"""Writing Mode documents — a second cache domain, kept strictly apart from
the image-archive metadata.

Writing Mode is a small paginated word-processor embedded inside the film
archive. Its documents are structured, editable data (never flattened into
screenshots): text and formatting, pagination, annotations, inserted image
groups, Writing-specific image modifications (black & white, layout), a star
rating and tags. Each document is one archive item, however many pages it has.

Where documents live (the two cache domains)
--------------------------------------------
The image archive already keeps its irreplaceable per-photo metadata as JSON
sidecars in a ``cache`` folder beside the photographs (see metastore.py). Writing
Mode reuses that same shared, travels-with-the-photographs folder but a
*separate subtree* so the two domains never mix:

    <linked archive folder>/cache/
        photos/     <- image archive metadata (MetaStore)
        folders/    <- per-roll metadata      (MetaStore)
        documents/  <- Writing Mode documents (DocStore)   ← this module

Each document is one file ``documents/<doc_id>.json``. Ids are random (a
document is authored on one machine, not derived from a file), so two documents
never collide and a duplicate is a genuinely independent copy.

Backups
-------
Every committed document edit is written backup-first exactly like image
metadata: a durable local write-ahead copy in the app's own local cache, then
the shared (possibly cloud-synced) cache, then reconciled. Writing Mode gets its
*own* backup journal root (``writing_backup`` beside the app cache) so the two
cache domains are backed up by the same machinery without ever mixing state.

Changes made to an image *inside a document* (black & white, layout, which
frames are in a group) are stored here, in the document — never written back
into the image archive. The archive images stay read-only and untouched.
"""
import json
import os
import threading
import time
import uuid

from .backup import BackupJournal

# The fields a document owns. Anything else the client sends is ignored, so a
# newer or older client can never corrupt a document with unexpected keys.
_DOC_FIELDS = ("content", "groups", "annotations", "rating", "tags")
_DOC_DEFAULT = {
    "content": "",       # sanitised HTML of the editable flow (text + group slots)
    "groups": {},        # group_id -> {"images": [...], "bw": bool, "layout": int}
    "annotations": {},   # shared pixel brushes: {cellSize, cells, wiggly}
    "rating": 0,
    "tags": "",          # comma-separated, same shape as photo tags
}

_README = (
    "Film Archive — Writing Mode documents\n"
    "=====================================\n\n"
    "This folder holds the paginated documents written in the Film Archive\n"
    "app's Writing Mode: their text, formatting, pagination, annotations,\n"
    "inserted image groups, per-document image settings, ratings and tags.\n"
    "Each document is one small JSON file, so several copies of the app that\n"
    "point at this same folder all share the same documents.\n\n"
    "Images placed in a document reference photographs in the archive but keep\n"
    "their own independent Writing-Mode state here; the original photographs\n"
    "are never modified. It is safe to back this folder up, and safe to delete\n"
    "it to start the documents over (the photographs themselves are untouched).\n"
)


def _new_id():
    return uuid.uuid4().hex[:16]


class DocStore:
    def __init__(self, root_dir, local_dir=None):
        self.dir = root_dir
        os.makedirs(root_dir, exist_ok=True)
        self._lock = threading.RLock()
        # id -> (mtime, parsed) so bulk scans re-read only what changed here or
        # in another instance sharing the folder
        self._cache = {}
        # Writing Mode's own write-ahead backup journal, rooted apart from the
        # image-archive journal so the two domains never share journal state.
        self._journal = None
        if local_dir:
            j = BackupJournal(local_dir, {"documents": root_dir}, io=self)
            if j.ok:
                self._journal = j
        if self._journal:
            self._journal.cleanup_temp()
            self._journal.reconcile(force=True)   # crash-safe replay on launch
        self._write_readme()

    # ---- io primitives the BackupJournal borrows -------------------------

    def atomic_write(self, path, data):
        self._atomic_write(path, data)

    def read_json(self, path):
        return self._read_json(path)

    @staticmethod
    def _read_json(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except FileNotFoundError:
            return None
        except Exception:
            return None

    @staticmethod
    def _atomic_write(path, data):
        tmp = f"{path}.tmp.{os.getpid()}.{threading.get_ident()}"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError:
                pass
        os.replace(tmp, path)

    def _write_json(self, path, data):
        """Backup-first write, identical in shape to MetaStore._write_json:
        stamp a monotonic revision, stage a durable local copy, apply to the
        (possibly cloud) cache, then reconcile. Falls back to a plain atomic
        write when no journal is available."""
        if self._journal is None or self._journal.rel_for(path) is None:
            self._atomic_write(path, data)
            return
        data = dict(data)
        data["rev"] = self._journal.next_rev(path)
        staged = self._journal.stage(path, data)
        try:
            self._atomic_write(path, data)
        except OSError:
            if staged is None:
                raise
        self._journal.reconcile()

    def _write_readme(self):
        path = os.path.join(self.dir, "README.txt")
        if not os.path.exists(path):
            try:
                with open(path, "w", encoding="utf-8") as f:
                    f.write(_README)
            except OSError:
                pass

    def _doc_path(self, doc_id):
        return os.path.join(self.dir, doc_id + ".json")

    # ---- shaping ----------------------------------------------------------

    @staticmethod
    def _clean(fields):
        """Keep only recognised document fields, coercing to safe types so a
        malformed client payload can never poison a stored document."""
        out = {}
        for k in _DOC_FIELDS:
            if k not in fields:
                continue
            v = fields[k]
            if k == "groups" and not isinstance(v, dict):
                continue
            if k == "annotations" and not isinstance(v, dict):
                continue
            if k == "rating":
                try:
                    v = max(0, min(5, int(v)))
                except (TypeError, ValueError):
                    continue
            if k in ("content", "tags") and not isinstance(v, str):
                continue
            out[k] = v
        return out

    def _shape(self, doc_id, data):
        out = dict(_DOC_DEFAULT)
        if isinstance(data, dict):
            for k in _DOC_FIELDS:
                if data.get(k) is not None:
                    out[k] = data[k]
            out["created"] = data.get("created")
            out["updated"] = data.get("updated")
        out["id"] = doc_id
        if not out.get("created"):
            out["created"] = time.time()
        return out

    # ---- crud -------------------------------------------------------------

    def get_doc(self, doc_id):
        data = self._read_json(self._doc_path(doc_id))
        if data is None:
            return None
        return self._shape(doc_id, data)

    def create_doc(self, fields=None):
        doc_id = _new_id()
        now = time.time()
        data = dict(_DOC_DEFAULT)
        if fields:
            data.update(self._clean(fields))
        data["created"] = now
        data["updated"] = now
        with self._lock:
            self._write_json(self._doc_path(doc_id), data)
            self._cache.pop(doc_id, None)
        return self._shape(doc_id, data)

    def save_doc(self, doc_id, fields):
        """Autosave. Merges the given fields into the existing document (or
        creates it if the file is missing, e.g. a first save of a new doc)."""
        with self._lock:
            cur = self._read_json(self._doc_path(doc_id))
            if not isinstance(cur, dict):
                cur = dict(_DOC_DEFAULT)
                cur["created"] = time.time()
            cur.update(self._clean(fields))
            cur["updated"] = time.time()
            self._write_json(self._doc_path(doc_id), cur)
            self._cache.pop(doc_id, None)
        return self._shape(doc_id, cur)

    def duplicate_doc(self, doc_id):
        """An independent copy: same pages/text/formatting, image groups,
        Writing-specific image modifications, annotations, tags and rating,
        under a fresh id so the two never share state."""
        src = self._read_json(self._doc_path(doc_id))
        if not isinstance(src, dict):
            return None
        new_id = _new_id()
        now = time.time()
        data = dict(_DOC_DEFAULT)
        data.update(self._clean(src))
        data["created"] = now
        data["updated"] = now
        with self._lock:
            self._write_json(self._doc_path(new_id), data)
            self._cache.pop(new_id, None)
        return self._shape(new_id, data)

    def delete_doc(self, doc_id):
        """Permanent — no trash, no restore (by design)."""
        with self._lock:
            try:
                os.remove(self._doc_path(doc_id))
            except OSError:
                pass
            self._cache.pop(doc_id, None)
            if self._journal:
                self._journal.forget(self._doc_path(doc_id))
        return True

    # ---- bulk / listing ---------------------------------------------------

    def _scan(self):
        try:
            names = os.listdir(self.dir)
        except OSError:
            return {}
        seen = set()
        for name in names:
            if not name.endswith(".json"):
                continue
            doc_id = name[: -len(".json")]
            seen.add(doc_id)
            path = os.path.join(self.dir, name)
            try:
                mt = os.path.getmtime(path)
            except OSError:
                continue
            hit = self._cache.get(doc_id)
            if not hit or hit[0] != mt:
                self._cache[doc_id] = (mt, self._read_json(path))
        for doc_id in list(self._cache):
            if doc_id not in seen:
                del self._cache[doc_id]
        # skip files that failed to parse (corrupt / half-written): a real
        # document is always a JSON object, so None here means unreadable
        return {d: v[1] for d, v in self._cache.items()
                if isinstance(v[1], dict)}

    def list_docs(self):
        """Every document, newest first (new documents enter at the front of
        the horizontal archive). Returns full documents so the archive can show
        an accurate representation, not a placeholder."""
        if self._journal:
            self._journal.reconcile()
        with self._lock:
            raw = self._scan()
        docs = [self._shape(doc_id, data) for doc_id, data in raw.items()]
        docs.sort(key=lambda d: d.get("created") or 0, reverse=True)
        return docs

    @staticmethod
    def doc_text(doc):
        """Plain lowercase text of a document, for search. Strips the HTML tags
        of the content flow, keeping only the words."""
        import re
        html = doc.get("content") or ""
        # drop tags, unescape the few entities the editor emits
        text = re.sub(r"<[^>]+>", " ", html)
        text = (text.replace("&nbsp;", " ").replace("&amp;", "&")
                    .replace("&lt;", "<").replace("&gt;", ">"))
        text = " ".join((text, doc.get("tags") or ""))
        return re.sub(r"\s+", " ", text).strip().lower()
