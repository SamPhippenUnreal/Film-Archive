"""Cloud-shared per-image metadata.

Every note, title, date, tag, star, camera/film, rotation, black-and-white
state, and drawing (ink / wiggly / future / text) is written as a small JSON
sidecar file inside a "cache" folder created in the linked archive folder:

    <linked archive folder>/cache/

so that any number of Archive instances pointed at the same (cloud)
folder read and write the same information. A single shared SQLite database
would corrupt under cloud sync and concurrent writers; independent sidecar
files sync cleanly, keep conflicts per-file, and are written atomically.

Layout:

    cache/
        photos/
            <photo_id>.meta.json    title, notes, date, tags, star rating,
                                    per-photo camera / film override
            <photo_id>.anno.json    drawings, text, rotation, b/w state
        folders/
            <roll>.json             per-roll camera / film + wall position

Photo ids are a hash of the file's path relative to the archive root, so they
are identical on every machine that shares the folder.

Local backup (write-ahead) failsafe
------------------------------------
The shared "cache" folder often lives in a cloud-synced directory (Dropbox,
iCloud, OneDrive, Google Drive). If that folder is momentarily offline, slow to
propagate, temporarily locked, or the sync client swallows a write — and the
app can crash mid-write — an edit could be lost. So every committed edit is
first written to a genuinely local "backup" folder (kept beside the app's own
cache, never in the cloud) as a durable write-ahead copy, *before* the shared
cache is touched. Once the cache write is read back and confirmed the backup
entry is marked synchronised and kept only briefly as a recovery copy; if the
cache write fails the backup keeps the edit and it is replayed automatically —
immediately, on the next launch, and on a light periodic sweep. See backup.py
for the full journal, revision, conflict and pruning design.
"""
import hashlib
import os
import re
import threading
import time

from .backup import BackupJournal
from .safeio import atomic_write_json, read_json

_META_DEFAULT = {
    "title": "", "notes": "", "date": "", "location": "", "tags": "",
    "favorite": 0, "rating": 0, "camera": "", "film": "",
}
_META_KEYS = tuple(_META_DEFAULT.keys())

_README = (
    "Archive metadata\n"
    "================\n\n"
    "This folder holds every note, title, date, tag, star rating, camera and\n"
    "film label, rotation, black-and-white state, and drawing made in the\n"
    "Archive app. Each photograph has its own small JSON files here, so\n"
    "several copies of the app that point at this same folder all share the\n"
    "same information.\n\n"
    "Your original photographs are never modified. These files live alongside\n"
    "them but only ever describe them. It is safe to back this folder up; it\n"
    "is safe to delete it if you want to start the annotations over (the\n"
    "photographs themselves are untouched).\n"
)


def folder_key(folder):
    """A filesystem-safe, collision-free name for a roll/folder path."""
    folder = folder or ""
    slug = re.sub(r"[^A-Za-z0-9._-]+", "_", folder).strip("_") or "root"
    h = hashlib.sha1(folder.encode("utf-8")).hexdigest()[:8]
    return f"{slug[:48]}__{h}"


class MetaStore:
    def __init__(self, root_dir, local_dir=None):
        self.dir = root_dir
        # one-time migration from the folder's earlier name, so archives set
        # up before the rename keep all their notes, tags and drawings
        legacy = os.path.join(os.path.dirname(root_dir),
                              "film_archive_app_metadata")
        if (legacy != root_dir and not os.path.exists(root_dir)
                and os.path.isdir(legacy)):
            try:
                os.rename(legacy, root_dir)
            except OSError:
                pass
        self.photos_dir = os.path.join(root_dir, "photos")
        self.folders_dir = os.path.join(root_dir, "folders")
        os.makedirs(self.photos_dir, exist_ok=True)
        os.makedirs(self.folders_dir, exist_ok=True)
        self._lock = threading.Lock()
        # id -> (mtime, parsed) so bulk scans re-read only what changed,
        # here or in another instance sharing the folder
        self._meta_cache = {}
        self._anno_cache = {}
        # genuinely local write-ahead backup (never in the cloud): every
        # committed edit is durably staged here before the shared cache is
        # touched, and replayed if the cache write fails. local_dir is the
        # "backup" folder beside the app's own cache.
        self._journal = None
        if local_dir:
            j = BackupJournal(
                local_dir,
                {"photos": self.photos_dir, "folders": self.folders_dir},
                io=self)
            if j.ok:
                self._journal = j
        self._reconcile_min_gap = 30.0     # periodic-fallback throttle
        self._last_reconcile = 0.0
        # clear any interrupted temp files, then replay/finalise anything a
        # previous run left pending or half-written (crash recovery on launch)
        if self._journal:
            self._journal.cleanup_temp()
            self._journal.reconcile(force=True)   # immediate replay on launch
            self._last_reconcile = time.time()
        self._write_readme()

    def reconcile(self, force=False):
        """Replay/finalise pending backup records against the cache. Exposed so
        a caller can force a sweep (e.g. when the cache becomes reachable)."""
        if self._journal:
            self._journal.reconcile(force=force)
            self._last_reconcile = time.time()

    # io primitives the BackupJournal borrows, so there is exactly one atomic
    # write implementation in the app
    def atomic_write(self, path, data):
        self._atomic_write(path, data)

    def read_json(self, path):
        return self._read_json(path)

    # ---- low-level file io ------------------------------------------------

    @staticmethod
    def _read_json(path):
        return read_json(path, dictionaries_only=False)

    @staticmethod
    def _atomic_write(path, data):
        # atomic: write a temp file then replace, so a mid-sync reader (or
        # another instance) never sees a half-written file
        atomic_write_json(path, data)

    def _write_json(self, path, data):
        """Backup-first write of a cache sidecar. Without a backup journal
        (path not tracked, or backup unavailable) this is a plain atomic write
        so the app still works. Otherwise the edit is stamped with a monotonic
        revision, written durably to the local backup first, then applied to
        the (possibly cloud) cache and reconciled."""
        if self._journal is None or self._journal.rel_for(path) is None:
            self._atomic_write(path, data)
            return
        data = dict(data)
        # a monotonic revision, one past anything already on disk, so a newer
        # commit is never overwritten by an older replayed one
        data["rev"] = self._journal.next_rev(path)
        # 1-3: durable local backup + journal(pending) BEFORE the cache
        staged = self._journal.stage(path, data)
        # 4: apply to the shared, possibly cloud-synced cache
        try:
            self._atomic_write(path, data)
        except OSError:
            # the cache write failed; the backup keeps the edit and
            # reconciliation replays it. Only surface the error if there is
            # no durable backup to fall back on.
            if staged is None:
                raise
        # 5-7: verify via read-back, mark synchronised, prune. Idempotent.
        self._journal.reconcile()
        self._last_reconcile = time.time()

    def _maybe_reconcile(self):
        """A cheap periodic fallback: retry anything still pending and prune,
        but no more often than the throttle. Driven by the wall's own polling
        (meta_flags / search_text), so no background thread is needed."""
        if not self._journal:
            return
        now = time.time()
        if now - self._last_reconcile < self._reconcile_min_gap:
            return
        self._last_reconcile = now
        self._journal.reconcile()

    def _write_readme(self):
        path = os.path.join(self.dir, "README.txt")
        if not os.path.exists(path):
            try:
                with open(path, "w", encoding="utf-8") as f:
                    f.write(_README)
            except OSError:
                pass

    def _meta_path(self, pid):
        return os.path.join(self.photos_dir, pid + ".meta.json")

    def _anno_path(self, pid):
        return os.path.join(self.photos_dir, pid + ".anno.json")

    def _folder_path(self, folder):
        return os.path.join(self.folders_dir, folder_key(folder) + ".json")

    # ---- meta -------------------------------------------------------------

    def get_meta(self, photo_id):
        data = self._read_json(self._meta_path(photo_id)) or {}
        out = dict(_META_DEFAULT)
        for k in _META_KEYS:
            if data.get(k) is not None:
                out[k] = data[k]
        out["photo_id"] = photo_id
        return out

    def set_meta(self, photo_id, fields):
        with self._lock:
            cur = self.get_meta(photo_id)
            for k in _META_KEYS:
                if k in fields:
                    cur[k] = fields[k]
            cur["photo_id"] = photo_id
            cur["updated"] = time.time()
            self._write_json(self._meta_path(photo_id), cur)
            # this instance must see its own write immediately, even if the
            # file lands in the same coarse mtime tick as the cached copy
            self._meta_cache.pop(photo_id, None)

    # ---- annotations (drawings, text, rotation, b/w) ----------------------

    def get_annotations(self, photo_id):
        data = self._read_json(self._anno_path(photo_id))
        if not data:
            return None
        # sidecars wrap the blob under "annotations"; tolerate a bare blob too
        blob = data.get("annotations") if isinstance(data, dict) else None
        if blob is None and isinstance(data, dict) and "updated" not in data:
            blob = data
        return blob

    def set_annotations(self, photo_id, data):
        with self._lock:
            self._write_json(self._anno_path(photo_id),
                             {"annotations": data, "updated": time.time()})
            self._anno_cache.pop(photo_id, None)

    # ---- folder (roll) camera / film + wall position ----------------------

    def get_folder_meta(self, folder):
        d = self._read_json(self._folder_path(folder)) or {}
        return {"camera": d.get("camera", ""), "film": d.get("film", "")}

    def set_folder_meta(self, folder, fields):
        with self._lock:
            d = self._read_json(self._folder_path(folder)) or {}
            d["folder"] = folder
            for k in ("camera", "film"):
                if k in fields:
                    d[k] = fields[k]
            d.setdefault("off_x", d.get("off_x", 0) or 0)
            d.setdefault("off_y", d.get("off_y", 0) or 0)
            d["updated"] = time.time()
            self._write_json(self._folder_path(folder), d)

    def add_folder_offset(self, folder, dx, dy):
        with self._lock:
            d = self._read_json(self._folder_path(folder)) or {}
            d["folder"] = folder
            d["off_x"] = (d.get("off_x") or 0) + dx
            d["off_y"] = (d.get("off_y") or 0) + dy
            d["updated"] = time.time()
            self._write_json(self._folder_path(folder), d)

    def _all_folders(self):
        out = {}
        try:
            names = os.listdir(self.folders_dir)
        except OSError:
            return out
        for name in names:
            if not name.endswith(".json"):
                continue
            d = self._read_json(os.path.join(self.folders_dir, name))
            if isinstance(d, dict) and "folder" in d:
                out[d["folder"]] = d
        return out

    def all_folder_meta(self):
        return {f: {"camera": d.get("camera", ""), "film": d.get("film", "")}
                for f, d in self._all_folders().items()}

    def folder_offsets(self):
        return {f: (d.get("off_x") or 0, d.get("off_y") or 0)
                for f, d in self._all_folders().items()}

    # ---- bulk scans (wall flags, search) ----------------------------------

    def _scan(self):
        """Refresh caches from disk, picking up edits made by other
        instances. Returns (metas, annos) keyed by photo id."""
        try:
            names = os.listdir(self.photos_dir)
        except OSError:
            return {}, {}
        seen_meta, seen_anno = set(), set()
        for name in names:
            if name.endswith(".meta.json"):
                pid = name[:-len(".meta.json")]
                seen_meta.add(pid)
                cache, path = self._meta_cache, os.path.join(self.photos_dir, name)
            elif name.endswith(".anno.json"):
                pid = name[:-len(".anno.json")]
                seen_anno.add(pid)
                cache, path = self._anno_cache, os.path.join(self.photos_dir, name)
            else:
                continue
            try:
                mt = os.path.getmtime(path)
            except OSError:
                continue
            hit = cache.get(pid)
            if not hit or hit[0] != mt:
                cache[pid] = (mt, self._read_json(path) or {})
        for pid in list(self._meta_cache):
            if pid not in seen_meta:
                del self._meta_cache[pid]
        for pid in list(self._anno_cache):
            if pid not in seen_anno:
                del self._anno_cache[pid]
        return ({p: v[1] for p, v in self._meta_cache.items()},
                {p: v[1] for p, v in self._anno_cache.items()})

    @staticmethod
    def _anno_blob(a):
        if not isinstance(a, dict):
            return None
        blob = a.get("annotations")
        if blob is None and "updated" not in a:
            blob = a
        return blob if isinstance(blob, dict) else None

    def meta_titles(self):
        """photo_id -> the title given to the photograph in the gallery.

        Only photographs that actually carry a title appear, so callers can
        treat a miss as "this one still goes by its filename"."""
        self._maybe_reconcile()
        with self._lock:
            metas, _ = self._scan()
        return {pid: (m.get("title") or "").strip()
                for pid, m in metas.items() if (m.get("title") or "").strip()}

    def meta_flags(self):
        """photo_id -> small dict for the wall's dots and tag/star filtering."""
        self._maybe_reconcile()
        with self._lock:
            metas, annos = self._scan()
        out = {}
        for pid, m in metas.items():
            tags = [t.strip() for t in (m.get("tags") or "").split(",")
                    if t.strip()]
            entry = {"noted": bool(m.get("title") or m.get("notes"))}
            if tags:
                entry["tags"] = tags
            if m.get("rating"):
                entry["rating"] = m["rating"]
            if m.get("camera"):
                entry["camera"] = m["camera"]
            if m.get("film"):
                entry["film"] = m["film"]
            out[pid] = entry
        for pid, a in annos.items():
            blob = self._anno_blob(a)
            if blob and (blob.get("cells") or blob.get("texts")
                         or blob.get("wiggly")):
                out.setdefault(pid, {})["inked"] = True
        return out

    def search_text(self):
        """photo_id -> lowercase haystack of everything written about it."""
        with self._lock:
            metas, annos = self._scan()
        out = {}
        for pid, m in metas.items():
            out[pid] = " ".join(filter(None, (
                m.get("title"), m.get("notes"), m.get("date"),
                m.get("location"), m.get("tags"),
                m.get("camera"), m.get("film"),
            ))).lower()
        for pid, a in annos.items():
            blob = self._anno_blob(a)
            if blob:
                words = " ".join(t.get("str", "")
                                 for t in (blob.get("texts") or [])).strip()
                if words:
                    out[pid] = (out.get(pid, "") + " " + words.lower())
        return out

    # ---- rename / move ----------------------------------------------------

    def migrate(self, old_id, new_id):
        """Carry a renamed photo's sidecars over to its new id."""
        with self._lock:
            for ext in (".meta.json", ".anno.json"):
                src = os.path.join(self.photos_dir, old_id + ext)
                dst = os.path.join(self.photos_dir, new_id + ext)
                if not os.path.exists(src):
                    continue
                try:
                    if os.path.exists(dst):
                        os.remove(src)
                    else:
                        os.replace(src, dst)
                except OSError:
                    pass
            self._meta_cache.pop(old_id, None)
            self._anno_cache.pop(old_id, None)
