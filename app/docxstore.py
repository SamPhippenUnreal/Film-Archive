"""Writing Mode, folder-backed by real ``.docx`` files.

The Writing context is a GUI over a folder the user links. Every document in
the archive *is* a ``.docx`` file in that folder: listing reads the folder,
the ``+`` button creates a new ``.docx``, editing and saving rewrite it, and
deleting removes it. Files authored elsewhere (e.g. Word) that are dropped into
the folder appear as documents; documents written here appear as ``.docx`` on
disk. Inserted photographs are embedded as a copy directly inside the file.

Safety — the ``writing_backup`` journal
---------------------------------------
The linked folder plays the same role the shared ``cache`` folder plays for the
image archive: it is the authoritative, possibly cloud-synced destination. To
protect against a slow/offline/locked destination or a crash mid-write, every
commit is written **backup-first**, mirroring the image archive's write-ahead
journal (see backup.py):

    writing_backup/
        docs/     <name>.docx        a durable local copy of the bytes
        journal/  <name>.docx.json   {name, checksum, ts, state}

Flow per commit: stage the bytes locally, write them to the linked folder,
verify the folder now holds exactly those bytes, then purge the local copy. A
crash leaves the staged copy in place; on the next launch ``reconcile`` replays
anything the linked folder is missing or that doesn't match, and purges what is
already up to date. The local backup therefore only ever holds work not yet
safely in the linked folder.
"""
import base64
import hashlib
import io
import os
import re
import threading
import time
from html.parser import HTMLParser

from docx import Document
from docx.oxml.ns import qn
from docx.shared import Inches

try:
    from PIL import Image
except Exception:                       # pragma: no cover - Pillow is a dep
    Image = None


# ————————————————————————— low-level io helpers —————————————————————————

def _sha(blob):
    return hashlib.sha256(blob).hexdigest()


def _atomic_write_bytes(path, data):
    tmp = f"{path}.tmp.{os.getpid()}.{threading.get_ident()}"
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        try:
            os.fsync(f.fileno())
        except OSError:
            pass
    os.replace(tmp, path)


def _atomic_write_json(path, obj):
    import json
    tmp = f"{path}.tmp.{os.getpid()}.{threading.get_ident()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
        f.flush()
        try:
            os.fsync(f.fileno())
        except OSError:
            pass
    os.replace(tmp, path)


def _read_json(path):
    import json
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


_UNSAFE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _safe_filename(name):
    """A filesystem-safe document title, without extension."""
    name = _UNSAFE.sub(" ", (name or "").strip()).strip(". ")
    name = re.sub(r"\s+", " ", name)
    return name[:80] or "Untitled"


# ————————————————————————— html  ->  docx —————————————————————————

_BLOCK = {"div", "p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote"}
_HEADINGS = {"h1": 1, "h2": 2, "h3": 3, "h4": 4, "h5": 5, "h6": 6}


def _image_width(blob):
    """A page-margin-safe width for an embedded image."""
    if Image is None:
        return Inches(5.0)
    try:
        im = Image.open(io.BytesIO(blob))
        dpi = (im.info.get("dpi") or (96, 96))[0] or 96
        w_in = im.size[0] / float(dpi)
        return Inches(max(1.0, min(6.0, w_in)))
    except Exception:
        return Inches(5.0)


# The longest edge, in pixels, of a photograph embedded into a document. Linked
# photographs are full-resolution originals (commonly 3000–6000px wide); a
# document only ever displays one at page width, so embedding the original
# makes the .docx many megabytes. Every autosave then rebuilds and rewrites that
# whole payload and every open re-encodes it to base64 — the single biggest
# cause of the Writing context feeling slow. Capping the longest edge shrinks a
# typical photo roughly ten-fold with no visible loss at document scale.
EMBED_MAX_DIM = 1600


def _downscale_image(blob):
    """Shrink an oversized embedded photograph to a document-appropriate size.

    Idempotent: an image already within the cap is returned untouched, so
    repeated saves never recompress it (no generation loss) and only the first
    save of an oversized image pays the cost. Any failure returns the original
    bytes, so a quirky image is embedded verbatim rather than dropped."""
    if Image is None:
        return blob
    try:
        im = Image.open(io.BytesIO(blob))
        w, h = im.size
        if max(w, h) <= EMBED_MAX_DIM:
            return blob
        scale = EMBED_MAX_DIM / float(max(w, h))
        im = im.convert("RGB").resize(
            (max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
        out = io.BytesIO()
        im.save(out, format="JPEG", quality=85, optimize=True)
        return out.getvalue()
    except Exception:
        return blob


class _HtmlToDocx(HTMLParser):
    """Convert the editor's content HTML into Word paragraphs and runs.

    Supports the formatting the editor produces: block paragraphs, bold /
    italic / underline runs, bullet lists, and inline images (data: URIs, or
    ``/image/<id>`` sources resolved to bytes by the caller)."""

    def __init__(self, document, images):
        super().__init__(convert_charrefs=True)
        self.doc = document
        self.images = images or {}
        self.para = None
        self.bold = self.ital = self.und = 0
        self.list_depth = 0
        self.heading = 0

    def _flush(self):
        self.para = None

    def _ensure(self):
        if self.para is None:
            self.para = self.doc.add_paragraph()
            if self.heading:
                try:
                    self.para.style = self.doc.styles[f"Heading {self.heading}"]
                except KeyError:
                    pass
            elif self.list_depth > 0:
                try:
                    self.para.style = self.doc.styles["List Bullet"]
                except KeyError:
                    pass
        return self.para

    def handle_starttag(self, tag, attrs):
        if tag in ("b", "strong"):
            self.bold += 1
        elif tag in ("i", "em"):
            self.ital += 1
        elif tag == "u":
            self.und += 1
        elif tag in ("ul", "ol"):
            self.list_depth += 1
            self._flush()
        elif tag == "br":
            if self.para is not None:
                self.para.add_run().add_break()
        elif tag == "img":
            self._add_image(dict(attrs).get("src", ""))
        elif tag in _HEADINGS:
            self._flush()
            self.heading = _HEADINGS[tag]
        elif tag in _BLOCK:
            self._flush()

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if tag in ("b", "strong"):
            self.bold = max(0, self.bold - 1)
        elif tag in ("i", "em"):
            self.ital = max(0, self.ital - 1)
        elif tag == "u":
            self.und = max(0, self.und - 1)
        elif tag in ("ul", "ol"):
            self.list_depth = max(0, self.list_depth - 1)
            self._flush()
        elif tag in _HEADINGS:
            self.heading = 0
            self._flush()
        elif tag in _BLOCK:
            self._flush()

    def handle_data(self, data):
        if not data or (data.strip() == "" and self.para is None):
            return
        run = self._ensure().add_run(data)
        run.bold = self.bold > 0
        run.italic = self.ital > 0
        run.underline = self.und > 0

    def _add_image(self, src):
        blob = None
        if src.startswith("data:"):
            try:
                blob = base64.b64decode(src.split(",", 1)[1])
            except Exception:
                blob = None
        else:
            entry = self.images.get(src)
            if entry:
                blob = entry[0]
        if not blob:
            return
        blob = _downscale_image(blob)
        try:
            self._ensure().add_run().add_picture(
                io.BytesIO(blob), width=_image_width(blob))
        except Exception:
            pass


def html_to_docx_bytes(html, images=None):
    """Serialize editor content HTML to ``.docx`` bytes."""
    doc = Document()
    parser = _HtmlToDocx(doc, images or {})
    parser.feed(html or "")
    parser.close()
    if not doc.paragraphs:
        doc.add_paragraph("")
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


# ————————————————————————— docx  ->  html —————————————————————————

def _esc(text):
    return (text.replace("&", "&amp;").replace("<", "&lt;")
                .replace(">", "&gt;"))


def _run_images(run, part):
    out = []
    for blip in run._element.findall(".//" + qn("a:blip")):
        rid = blip.get(qn("r:embed"))
        if not rid:
            continue
        try:
            image_part = part.related_parts[rid]
            b64 = base64.b64encode(image_part.blob).decode("ascii")
            ct = image_part.content_type or "image/png"
            out.append(f'<img src="data:{ct};base64,{b64}">')
        except Exception:
            pass
    return "".join(out)


def _run_html(run, part):
    imgs = _run_images(run, part)
    text = _esc(run.text or "")
    if text:
        if run.bold:
            text = f"<b>{text}</b>"
        if run.italic:
            text = f"<i>{text}</i>"
        if run.underline:
            text = f"<u>{text}</u>"
    return imgs + text


def docx_bytes_to_html(data):
    """Render a ``.docx`` file into content HTML the editor can display."""
    doc = Document(io.BytesIO(data))
    part = doc.part
    out = []
    in_list = False
    for para in doc.paragraphs:
        style = (para.style.name or "") if para.style is not None else ""
        is_li = style.startswith("List")
        inner = "".join(_run_html(r, part) for r in para.runs)
        if is_li:
            if not in_list:
                out.append("<ul>")
                in_list = True
            out.append(f"<li>{inner or '<br>'}</li>")
            continue
        if in_list:
            out.append("</ul>")
            in_list = False
        out.append(f"<div>{inner or '<br>'}</div>")
    if in_list:
        out.append("</ul>")
    return "".join(out)


def docx_text(data):
    """Plain text of a document, for previews and search."""
    try:
        doc = Document(io.BytesIO(data))
    except Exception:
        return ""
    return " ".join(p.text for p in doc.paragraphs).strip()


def docx_plain_text(data):
    """Lowercase plain text of a document, for search."""
    return docx_text(data).lower()


# ————————————————————————— the write-ahead backup —————————————————————————

class _DocxBackup:
    """A durable local copy of each committed ``.docx`` until the linked folder
    confirms it, then purged — the binary counterpart of backup.py's journal."""

    def __init__(self, local_dir):
        self.dir = local_dir
        self.docs_dir = os.path.join(local_dir, "docs")
        self.journal_dir = os.path.join(local_dir, "journal")
        self._lock = threading.RLock()
        self.ok = True
        try:
            os.makedirs(self.docs_dir, exist_ok=True)
            os.makedirs(self.journal_dir, exist_ok=True)
        except OSError:
            self.ok = False

    def _jpath(self, name):
        return os.path.join(self.journal_dir, name + ".json")

    def _dpath(self, name):
        return os.path.join(self.docs_dir, name)

    def stage(self, name, data):
        """Durably record the bytes locally, before the linked folder is
        touched."""
        if not self.ok:
            return
        with self._lock:
            try:
                _atomic_write_bytes(self._dpath(name), data)
                _atomic_write_json(self._jpath(name), {
                    "name": name, "checksum": _sha(data),
                    "ts": time.time(), "state": "pending"})
            except OSError:
                pass

    def confirm(self, name, target_dir):
        """The linked folder now holds this file — if it matches the staged
        bytes, the local safety copy has done its job and is purged."""
        if not self.ok:
            return
        with self._lock:
            entry = _read_json(self._jpath(name)) or {}
            try:
                with open(os.path.join(target_dir, name), "rb") as f:
                    cur = f.read()
            except OSError:
                return
            if _sha(cur) == entry.get("checksum"):
                self._purge(name)

    def forget(self, name):
        """Drop any staged copy for a deleted document, so reconcile never
        resurrects it."""
        if not self.ok:
            return
        with self._lock:
            self._purge(name)

    def _purge(self, name):
        for p in (self._dpath(name), self._jpath(name)):
            try:
                os.remove(p)
            except OSError:
                pass

    def reconcile(self, target_dir):
        """On launch: replay anything the linked folder is missing or that does
        not match the staged bytes, then purge what is already up to date."""
        if not self.ok:
            return
        with self._lock:
            try:
                names = os.listdir(self.journal_dir)
            except OSError:
                return
            for jn in names:
                if not jn.endswith(".json") or ".tmp." in jn:
                    continue
                entry = _read_json(os.path.join(self.journal_dir, jn))
                if not isinstance(entry, dict) or not entry.get("name"):
                    continue
                name = entry["name"]
                staged = self._dpath(name)
                if not os.path.exists(staged):
                    self._purge(name)
                    continue
                try:
                    with open(staged, "rb") as f:
                        staged_bytes = f.read()
                except OSError:
                    continue
                if _sha(staged_bytes) != entry.get("checksum"):
                    self._purge(name)          # corrupt/incomplete stage
                    continue
                target = os.path.join(target_dir, name)
                try:
                    with open(target, "rb") as f:
                        cur = f.read()
                except OSError:
                    cur = None
                if cur is not None and _sha(cur) == entry.get("checksum"):
                    self._purge(name)          # already safely landed
                    continue
                try:                            # replay, verify, purge
                    _atomic_write_bytes(target, staged_bytes)
                    with open(target, "rb") as f:
                        if _sha(f.read()) == entry.get("checksum"):
                            self._purge(name)
                except OSError:
                    pass

    def pending(self):
        """How many committed docs are not yet confirmed in the folder."""
        if not self.ok:
            return 0
        try:
            return len([n for n in os.listdir(self.journal_dir)
                        if n.endswith(".json") and ".tmp." not in n])
        except OSError:
            return 0


# ————————————————————————— the store —————————————————————————

_README = (
    "Archive — Writing documents\n"
    "===========================\n\n"
    "This folder is linked to the Writing context of the Archive app. Every\n"
    "document you see there is a .docx file in this folder: new documents are\n"
    "created here, edits rewrite the file, and deleting a document deletes its\n"
    "file. .docx files placed here from elsewhere appear as documents too.\n\n"
    "Photographs inserted into a document are embedded as a copy inside its\n"
    ".docx. A local write-ahead backup keeps your work safe until it has been\n"
    "written here; once a file is safely in this folder the local copy is\n"
    "purged.\n"
)


class DocxStore:
    """The folder of ``.docx`` documents, addressed by their filename stem."""

    def __init__(self, root_dir, local_dir=None):
        self.dir = root_dir
        os.makedirs(root_dir, exist_ok=True)
        # A .docx is the portable, user-readable document.  A small companion
        # state file preserves Archive-only editing semantics that Word cannot
        # represent (image-group ids/layout, canvas annotations, rating/tags).
        # It lives with the documents so cloud-synced Writing folders retain
        # the exact editor model across machines.
        self.state_dir = os.path.join(root_dir, ".archive-writing")
        os.makedirs(self.state_dir, exist_ok=True)
        self._lock = threading.RLock()
        self._ids = {}                       # id (stem) -> actual filename
        # filename -> ((mtime, size), shaped-dict): the docx->html conversion is
        # the expensive step of every list/open, so its result is memoised and
        # only recomputed when the file on disk actually changes (a fresh save,
        # or a file edited outside the app). Keeps opening the archive cheap.
        self._shape_cache = {}
        self.backup = _DocxBackup(local_dir) if local_dir else None
        if self.backup and self.backup.ok:
            self.backup.reconcile(self.dir)  # crash-safe replay on launch
        self._write_readme()

    # ---- helpers ----------------------------------------------------------

    def _write_readme(self):
        path = os.path.join(self.dir, "README.txt")
        if not os.path.exists(path):
            try:
                with open(path, "w", encoding="utf-8") as f:
                    f.write(_README)
            except OSError:
                pass

    def _scan(self):
        ids = {}
        try:
            names = os.listdir(self.dir)
        except OSError:
            self._ids = ids
            return ids
        for name in names:
            if not name.lower().endswith(".docx") or name.startswith("~$"):
                continue
            ids[name[:-5]] = name
        self._ids = ids
        return ids

    def _unique_name(self, title):
        base = _safe_filename(title) if title else "Untitled"
        name = base + ".docx"
        i = 2
        existing = {n.lower() for n in self._ids.values()}
        while name.lower() in existing:
            name = f"{base} {i}.docx"
            i += 1
        return name

    def _commit(self, name, data):
        """Backup-first: stage locally, write the linked folder, verify+purge."""
        path = os.path.join(self.dir, name)
        if self.backup:
            self.backup.stage(name, data)
        _atomic_write_bytes(path, data)
        if self.backup:
            self.backup.confirm(name, self.dir)
        self._shape_cache.pop(name, None)    # rewritten: its cached shape is stale

    def _state_path(self, name):
        return os.path.join(self.state_dir, name + ".json")

    def _write_editor_state(self, name, data, state):
        if not isinstance(state, dict):
            return
        clean = {
            "version": 1,
            "docx_checksum": _sha(data),
            "content": state.get("content") or "",
            "groups": state.get("groups") if isinstance(state.get("groups"), dict) else {},
            "annotations": (state.get("annotations")
                            if isinstance(state.get("annotations"), dict) else {}),
            "rating": max(0, min(5, int(state.get("rating") or 0))),
            "tags": str(state.get("tags") or ""),
        }
        _atomic_write_json(self._state_path(name), clean)

    def _read_editor_state(self, name, data):
        state = _read_json(self._state_path(name))
        if not isinstance(state, dict) or state.get("docx_checksum") != _sha(data):
            return None
        return state

    def _light(self, doc_id, name, mt=None):
        """The document's metadata without the costly docx->html conversion —
        enough for the save response (which the editor discards) and to fill in
        a shape whose content is supplied by the caller."""
        if mt is None:
            try:
                mt = os.path.getmtime(os.path.join(self.dir, name))
            except OSError:
                mt = time.time()
        return {
            "id": doc_id, "title": doc_id, "filename": name, "content": "",
            # kept for shape-compatibility with the editor's document model
            "groups": {}, "annotations": {}, "rating": 0, "tags": "",
            "created": mt, "updated": mt,
        }

    def _shape(self, doc_id, name):
        path = os.path.join(self.dir, name)
        try:
            st = os.stat(path)
            try:
                sst = os.stat(self._state_path(name))
                state_key = (sst.st_mtime, sst.st_size)
            except OSError:
                state_key = None
            key = (st.st_mtime, st.st_size, state_key)
        except OSError:
            key = None
        cached = self._shape_cache.get(name)
        if cached is not None and key is not None and cached[0] == key:
            return dict(cached[1])           # a copy — callers may reassign keys
        shaped = self._light(doc_id, name, mt=key[0] if key else None)
        try:
            with open(path, "rb") as f:
                data = f.read()
            state = self._read_editor_state(name, data)
            if state is not None:
                shaped["content"] = state.get("content") or ""
                shaped["groups"] = state.get("groups") or {}
                shaped["annotations"] = state.get("annotations") or {}
                shaped["rating"] = state.get("rating") or 0
                shaped["tags"] = state.get("tags") or ""
            else:
                # A document created or changed outside Archive has no matching
                # companion model.  Parse it normally and bound its inline
                # images in the editor; never trust stale state from older bytes.
                shaped["content"] = docx_bytes_to_html(data)
        except Exception:
            shaped["content"] = ""
        if key is not None:
            self._shape_cache[name] = (key, dict(shaped))
        return shaped

    # ---- crud -------------------------------------------------------------

    def list_docs(self):
        if self.backup:
            self.backup.reconcile(self.dir)
        with self._lock:
            ids = dict(self._scan())
        docs = [self._shape(i, n) for i, n in ids.items()]
        docs.sort(key=lambda d: d.get("updated") or 0, reverse=True)
        return docs

    def get_doc(self, doc_id):
        with self._lock:
            self._scan()
            name = self._ids.get(doc_id)
        if not name:
            return None
        return self._shape(doc_id, name)

    def source_path(self, doc_id):
        """Canonical path for a known document id, or ``None``.

        Importers use this rather than joining a request value to the linked
        Writing folder.  Only an id discovered by ``_scan`` can resolve.
        """
        with self._lock:
            self._scan()
            name = self._ids.get(str(doc_id))
        if not name:
            return None
        path = os.path.realpath(os.path.join(self.dir, name))
        try:
            if os.path.commonpath((os.path.normcase(os.path.realpath(self.dir)),
                                   os.path.normcase(path))) != \
                    os.path.normcase(os.path.realpath(self.dir)):
                return None
        except ValueError:
            return None
        return path if os.path.isfile(path) else None

    def create_doc(self, fields=None):
        fields = fields or {}
        with self._lock:
            self._scan()
            name = self._unique_name(fields.get("title"))
            data = html_to_docx_bytes(fields.get("content", ""),
                                      fields.get("_images"))
            self._commit(name, data)
            self._write_editor_state(name, data, fields.get("editor_state"))
            self._scan()
        return self._shape(name[:-5], name)

    def save_doc(self, doc_id, fields):
        fields = fields or {}
        with self._lock:
            self._scan()
            name = self._ids.get(doc_id) or (_safe_filename(doc_id) + ".docx")
            data = html_to_docx_bytes(fields.get("content", ""),
                                      fields.get("_images"))
            self._commit(name, data)
            self._write_editor_state(name, data, fields.get("editor_state"))
            self._scan()
            # The editor discards the save response, so skip re-reading and
            # re-converting the file we just wrote (a full docx->html of a
            # possibly image-heavy document) — return light metadata only. The
            # next list/open re-parses this one document once and re-caches it.
            return self._light(name[:-5], name)

    def duplicate_doc(self, doc_id):
        with self._lock:
            self._scan()
            name = self._ids.get(doc_id)
            if not name:
                return None
            try:
                with open(os.path.join(self.dir, name), "rb") as f:
                    data = f.read()
            except OSError:
                return None
            new_name = self._unique_name(doc_id)
            self._commit(new_name, data)
            state = self._read_editor_state(name, data)
            if state is not None:
                self._write_editor_state(new_name, data, state)
            self._scan()
        return self._shape(new_name[:-5], new_name)

    def delete_doc(self, doc_id):
        with self._lock:
            self._scan()
            name = self._ids.get(doc_id)
            if name:
                try:
                    os.remove(os.path.join(self.dir, name))
                except OSError:
                    pass
                if self.backup:
                    self.backup.forget(name)
                self._ids.pop(doc_id, None)
                self._shape_cache.pop(name, None)
                try:
                    os.remove(self._state_path(name))
                except OSError:
                    pass
        return True
