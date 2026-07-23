"""Local HTTP layer: serves the UI, the JSON API, thumbnails and images.

Everything is read-only towards the photo archive; writes go to the local
cache and the shared metadata folder only.
"""
import base64
import binascii
import io
import os
import re
import sys
import threading
from datetime import datetime
from urllib.parse import quote

from flask import (Flask, jsonify, request, send_file, send_from_directory,
                   abort)

from . import layout
from .scanner import dominant_color


_DATA_IMAGE_RE = re.compile(
    r"^data:image/(png|jpe?g);base64,([A-Za-z0-9+/=\s]+)$", re.I)
_UNSAFE_FILENAME_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]+')


def _decode_image_data(value, max_bytes=80 * 1024 * 1024):
    if not isinstance(value, str) or len(value) > max_bytes * 2:
        return None
    match = _DATA_IMAGE_RE.match(value.strip())
    if not match:
        return None
    try:
        data = base64.b64decode(match.group(2), validate=True)
    except (binascii.Error, ValueError):
        return None
    return data if 0 < len(data) <= max_bytes else None


def _safe_export_name(value, fallback):
    name = _UNSAFE_FILENAME_RE.sub(" ", str(value or "")).strip(". ")
    name = re.sub(r"\s+", " ", name)[:100]
    return name or fallback


def _downloads_directory():
    """Resolve the platform Downloads folder, including Windows redirects."""
    if sys.platform == "win32":
        try:
            import ctypes
            import uuid

            # FOLDERID_Downloads
            raw = uuid.UUID("374DE290-123F-4565-9164-39C4925E467B").bytes_le
            guid = (ctypes.c_ubyte * 16).from_buffer_copy(raw)
            out = ctypes.c_wchar_p()
            result = ctypes.windll.shell32.SHGetKnownFolderPath(
                ctypes.byref(guid), 0, None, ctypes.byref(out))
            if result == 0 and out.value:
                path = out.value
                ctypes.windll.ole32.CoTaskMemFree(out)
                return os.path.realpath(path)
        except Exception:
            pass
        base = os.environ.get("USERPROFILE")
        if base:
            return os.path.realpath(os.path.join(base, "Downloads"))
    home = os.path.expanduser("~")
    if home and home != "~":
        return os.path.realpath(os.path.join(home, "Downloads"))
    return None


def _unique_export_path(directory, stem, extension):
    stem = _safe_export_name(stem, "archive")
    existing = set()
    try:
        existing = {name.casefold() for name in os.listdir(directory)}
    except OSError:
        pass
    candidate = stem + extension
    number = 2
    while candidate.casefold() in existing:
        candidate = f"{stem} {number}{extension}"
        number += 1
    return os.path.join(directory, candidate)


def _write_new_bytes(path, data):
    """Durably create a new file without ever replacing an existing one."""
    with open(path, "xb") as f:
        f.write(data)
        f.flush()
        try:
            os.fsync(f.fileno())
        except OSError:
            pass


def _pdf_bytes(page_values):
    """Build a visual-fidelity multipage PDF from rendered page images."""
    from PIL import Image

    if not isinstance(page_values, list) or not 1 <= len(page_values) <= 500:
        raise ValueError("no rendered pages were supplied")
    pages = []
    total = 0
    try:
        for value in page_values:
            data = _decode_image_data(value)
            if data is None:
                raise ValueError("a rendered page was not valid")
            total += len(data)
            if total > 200 * 1024 * 1024:
                raise ValueError("the rendered document is too large")
            image = Image.open(io.BytesIO(data))
            image.load()
            if image.width * image.height > 100_000_000:
                image.close()
                raise ValueError("a rendered page is too large")
            pages.append(image.convert("RGB"))
            image.close()
        output = io.BytesIO()
        # Writing pages are US Letter.  Deriving DPI from the rendered width
        # preserves an 8.5 x 11 inch / 612 x 792 point MediaBox at any capture
        # scale (816 CSS px, 1632 px at 2x export, etc.).
        resolution = pages[0].width / 8.5
        pages[0].save(output, format="PDF", save_all=True,
                      append_images=pages[1:], resolution=resolution)
        return output.getvalue()
    finally:
        for page in pages:
            page.close()


# Empty image-group placeholders the editor serializes look like
# <div class="doc-group" data-gid="ID"></div>; rehydrate each with its
# photographs so they can be embedded into the .docx.
_GROUP_RE = re.compile(
    r'<div class="doc-group"[^>]*data-gid="([^"]+)"[^>]*>\s*</div>')

# "IMG_0042 2.jpg" — the trailing counter ProjectStore adds when a picture is
# imported into a project that already holds a file of that name.
_COPY_SUFFIX_RE = re.compile(r"^(.+?) \d+$")


def _photo_bytes(archive, pid):
    """The on-disk bytes of an archive photograph, for embedding into a .docx."""
    store = getattr(archive, "store", None)
    scanner = getattr(archive, "scanner", None)
    if store is None or scanner is None:
        return None
    p = store.get_photo(pid)
    if not p:
        return None
    path = scanner.display_path(p)
    try:
        with open(path, "rb") as f:
            return (f.read(), os.path.splitext(path)[1].lstrip(".").lower())
    except OSError:
        return None


def _prepare_writing_fields(archive, body, embed_images=False):
    """Shape an editor payload for the mixed TXT/legacy-DOCX store.

    New text documents keep image placement in their sidecar, so their fast
    save path never reads or re-encodes photograph bytes.  Only an existing
    legacy DOCX asks for Word-facing image embedding.
    """
    # Keep the editor's clean model separately from the Word-facing HTML.
    # The latter has real <img> tags injected so python-docx can embed pixels;
    # the former retains the stable group ids and Archive-only layout state
    # needed to reopen those pictures as movable document elements.
    editor_content = body.get("content") or ""
    content = editor_content
    groups = body.get("groups") or {}
    images = {}

    def inject(m):
        gid = m.group(1)
        g = groups.get(gid) or {}
        tags = []
        for pid in (g.get("images") or []):
            src = "/image/" + str(pid)
            if src not in images:
                be = _photo_bytes(archive, pid)
                if be:
                    images[src] = be
            tags.append('<img src="%s">' % src)
        return '<div class="doc-group" data-gid="%s">%s</div>' % (
            gid, "".join(tags))

    if embed_images:
        content = _GROUP_RE.sub(inject, content)
    return {
        "content": content,
        "title": body.get("title"),
        "_images": images if embed_images else {},
        "editor_state": {
            "content": editor_content,
            "groups": groups,
            "annotations": body.get("annotations") or {},
            "rating": body.get("rating") or 0,
            "tags": body.get("tags") or "",
        },
    }


def create_app(archive, project_archive=None, writing_archive=None):
    static_dir = os.path.join(os.path.dirname(__file__), "static")
    app = Flask("archive", static_folder=static_dir,
                static_url_path="/static")

    @app.after_request
    def _no_store_api(resp):
        # the JSON API is live, shared state — never let the browser serve a
        # cached wall/photo response (thumbnails and images stay cacheable)
        if request.path.startswith("/api/"):
            resp.headers["Cache-Control"] = "no-store"
        # the app updates its own code from GitHub between launches; a webview
        # that cached the old html/js/css would then run stale UI against a
        # newer backend. Revalidate the source each load (pixels stay cached).
        elif request.path == "/" or request.path.endswith(
                (".js", ".css", ".html")):
            resp.headers["Cache-Control"] = "no-cache"
        return resp

    @app.get("/")
    def index():
        return send_from_directory(static_dir, "index.html")

    # ---- archive ----------------------------------------------------------

    @app.get("/api/status")
    def status():
        return jsonify(archive.status())

    @app.post("/api/rescan")
    def rescan():
        if archive.scanner:
            archive.scanner.start()
        return jsonify({"ok": True})

    @app.post("/api/root")
    def set_root():
        """Link (or relink) the app to a folder of photographs."""
        body = request.get_json(force=True, silent=True) or {}
        raw = body.get("path", "")
        ok, err = archive.set_root(raw)
        if not ok:
            return jsonify({"ok": False, "error": err}), 400
        return jsonify({"ok": True, "root": archive.root})

    # ---- projects: an independently-linked archive --------------------------

    @app.get("/api/project/status")
    def project_status():
        if project_archive is None:
            return jsonify({"linked": False, "root": None, "phase": "empty"})
        return jsonify(project_archive.status())

    @app.post("/api/project/root")
    def set_project_root():
        """Link (or relink) the projects archive to its own folder, managed
        independently of the photo archive."""
        if project_archive is None:
            return jsonify({"ok": False, "error": "projects unavailable"}), 400
        body = request.get_json(force=True, silent=True) or {}
        raw = body.get("path", "")
        ok, err = project_archive.set_root(raw)
        if not ok:
            return jsonify({"ok": False, "error": err}), 400
        return jsonify({"ok": True, "root": project_archive.root})

    def _project_store():
        return project_archive.store if project_archive is not None else None

    def _gallery_titles():
        """filename -> the title the photograph carries in the image gallery.

        A picture imported into a project is a copy of the gallery's own file
        and keeps its filename, so the filename is what still ties the two
        together once the copy lives in the project folder."""
        store = archive.store
        if store is None:
            return {}
        try:
            titles = store.meta_titles()
            if not titles:
                return {}
            out = {}
            for photo in store.all_photos():
                title = titles.get(photo.get("id"))
                name = (photo.get("filename") or "").strip()
                if title and name:
                    out.setdefault(name.casefold(), title)
            return out
        except Exception:
            return {}

    def _gallery_title_for(gallery, filename):
        if not gallery or not filename:
            return None
        name = str(filename)
        hit = gallery.get(name.casefold())
        if hit:
            return hit
        # importing a second copy of the same picture appends " 2" to the stem
        # (see ProjectStore.import_files_with_errors) — look past that too
        stem, ext = os.path.splitext(name)
        m = _COPY_SUFFIX_RE.match(stem)
        return gallery.get((m.group(1) + ext).casefold()) if m else None

    def _project_json(project, gallery=None):
        """Add HTTP locations without putting routing concerns in ProjectStore."""
        if project is None:
            return None
        if gallery is None:
            gallery = _gallery_titles()
        shaped = dict(project)
        files = []
        for raw in project.get("files") or []:
            item = dict(raw)
            pid = quote(str(project["id"]), safe="")
            fid = quote(str(item["id"]), safe="")
            item["file_url"] = f"/project/file/{pid}/{fid}"
            item["preview_url"] = (
                f"/project/preview/{pid}/{fid}"
                if item.get("kind") == "image" else None)
            # a picture goes by its filename unless the gallery gave it a title
            if item.get("kind") == "image":
                title = _gallery_title_for(gallery, item.get("filename"))
                if title:
                    item["gallery_title"] = title
            files.append(item)
        shaped["files"] = files
        cover_id = shaped.get("cover_file_id")
        cover = next((f for f in files if f.get("id") == cover_id), None)
        shaped["cover_url"] = cover.get("preview_url") if cover else None
        return shaped

    @app.get("/api/project/projects")
    def project_projects():
        store = _project_store()
        if store is None:
            return jsonify({"linked": False, "projects": []})
        gallery = _gallery_titles()      # resolved once for the whole listing
        return jsonify({"linked": True,
                        "layout": store.get_index_layout(),
                        "projects": [_project_json(p, gallery)
                                     for p in store.list_projects()]})

    @app.post("/api/project/layout")
    def project_index_layout():
        store = _project_store()
        if store is None:
            abort(404)
        body = request.get_json(force=True, silent=True) or {}
        if not store.update_index_layout(body.get("positions")):
            return jsonify({"ok": False,
                            "error": "that project layout could not be saved"}), 400
        return jsonify({"ok": True})

    @app.get("/api/project/projects/<project_id>")
    def project_detail(project_id):
        store = _project_store()
        project = store.get_project(project_id) if store is not None else None
        if project is None:
            abort(404)
        return jsonify(_project_json(project))

    @app.post("/api/project/projects/<project_id>/rename")
    def rename_project(project_id):
        store = _project_store()
        if store is None or store.get_project(project_id) is None:
            abort(404)
        body = request.get_json(force=True, silent=True) or {}
        project, error = store.rename_project(project_id, body.get("name"))
        if project is None:
            return jsonify({"ok": False, "error": error}), 400
        return jsonify({"ok": True, "project": _project_json(project)})

    @app.post("/api/project/projects/<project_id>/delete")
    def delete_project(project_id):
        store = _project_store()
        if store is None or store.get_project(project_id) is None:
            abort(404)
        ok, error = store.delete_project(project_id)
        if not ok:
            return jsonify({"ok": False, "error": error}), 400
        return jsonify({"ok": True})

    @app.post("/api/project/projects/<project_id>/files/<file_id>/delete")
    def delete_project_file(project_id, file_id):
        store = _project_store()
        if store is None or store.get_project(project_id) is None:
            abort(404)
        if store.file_record(project_id, file_id) is None:
            abort(404)
        # the project workspace never deletes from disk — this only takes the
        # file off the canvas and into the project's trash
        ok, error = store.remove_file(project_id, file_id)
        if not ok:
            return jsonify({"ok": False, "error": error}), 400
        return jsonify({"ok": True,
                        "project": _project_json(store.get_project(project_id))})

    @app.get("/api/project/projects/<project_id>/trash")
    def project_trash(project_id):
        """Material taken off this project's canvas — still on disk, only
        filtered out of it and gathered here until restored."""
        store = _project_store()
        trash = store.get_removed(project_id) if store is not None else None
        if trash is None:
            abort(404)
        return jsonify(_project_json(trash))

    @app.post("/api/project/projects/<project_id>/restore")
    def project_restore(project_id):
        store = _project_store()
        if store is None or store.get_project(project_id) is None:
            abort(404)
        body = request.get_json(force=True, silent=True) or {}
        ids = body.get("file_ids", body.get("ids"))
        if not isinstance(ids, list):
            return jsonify({"ok": False, "error": "no files were selected"}), 400
        ok, error = store.restore_files(project_id, ids[:500])
        if not ok:
            return jsonify({"ok": False, "error": error}), 400
        return jsonify({"ok": True,
                        "project": _project_json(store.get_project(project_id)),
                        "trash": _project_json(store.get_removed(project_id))})

    @app.post("/api/project/projects/<project_id>/cover")
    def project_cover(project_id):
        store = _project_store()
        if store is None or store.get_project(project_id) is None:
            abort(404)
        body = request.get_json(force=True, silent=True) or {}
        if not store.set_cover(project_id, body.get("file_id")):
            return jsonify({"ok": False,
                            "error": "that image could not be used"}), 400
        return jsonify({"ok": True,
                        "project": _project_json(store.get_project(project_id))})

    @app.post("/api/project/projects/<project_id>/positions")
    def project_positions(project_id):
        store = _project_store()
        if store is None or store.get_project(project_id) is None:
            abort(404)
        body = request.get_json(force=True, silent=True) or {}
        if not store.update_positions(project_id, body.get("positions")):
            return jsonify({"ok": False,
                            "error": "those positions could not be saved"}), 400
        return jsonify({"ok": True})

    @app.get("/api/project/projects/<project_id>/annotations")
    def project_annotations(project_id):
        store = _project_store()
        annotations = (store.get_annotations(project_id)
                       if store is not None else None)
        if annotations is None:
            abort(404)
        return jsonify({"annotations": annotations})

    @app.post("/api/project/projects/<project_id>/annotations")
    def save_project_annotations(project_id):
        store = _project_store()
        if store is None or store.get_project(project_id) is None:
            abort(404)
        body = request.get_json(force=True, silent=True)
        if isinstance(body, dict) and set(body) == {"annotations"}:
            body = body["annotations"]
        if not store.set_annotations(project_id, body):
            return jsonify({"ok": False,
                            "error": "those marks could not be saved"}), 400
        return jsonify({"ok": True})

    @app.get("/api/project/projects/<project_id>/documents/<file_id>")
    def get_project_document(project_id, file_id):
        store = _project_store()
        document = (store.get_document(project_id, file_id)
                    if store is not None else None)
        if document is None:
            abort(404)
        return jsonify(document)

    @app.post("/api/project/projects/<project_id>/documents/<file_id>")
    def save_project_document(project_id, file_id):
        store = _project_store()
        if store is None:
            abort(404)
        record = store.file_record(project_id, file_id)
        if record is None or record.get("extension") not in (".txt", ".docx"):
            abort(404)
        body = request.get_json(force=True, silent=True) or {}
        fields = _prepare_writing_fields(
            archive, body, embed_images=record.get("extension") == ".docx")
        document = store.save_document(project_id, file_id, fields)
        if document is None:
            return jsonify({"ok": False,
                            "error": "that project document could not be saved"}), 400
        return jsonify(document)

    def _photo_source(photo_id):
        store = getattr(archive, "store", None)
        photo = store.get_photo(photo_id) if store is not None else None
        if not photo or not getattr(archive, "root", None):
            return None
        rel = photo.get("rel_path")
        path = (os.path.join(archive.root, *rel.split("/")) if rel
                else photo.get("path"))
        if not path:
            return None
        from .projectstore import is_within
        return (os.path.realpath(path)
                if is_within(archive.root, path) and os.path.isfile(path)
                else None)

    def _writing_source(document_id):
        store = _wstore()
        if store is None or not hasattr(store, "source_path"):
            return None
        path = store.source_path(document_id)
        if not path or not getattr(writing_archive, "root", None):
            return None
        from .projectstore import is_within
        if not is_within(writing_archive.root, path) or not os.path.isfile(path):
            return None
        state = (store.export_state(document_id)
                 if hasattr(store, "export_state") else None)
        return {"path": os.path.realpath(path), "writing_state": state}

    def _project_import(project_id, ids, resolver, noun):
        store = _project_store()
        if store is None or store.get_project(project_id) is None:
            abort(404)
        sources, errors, seen = [], [], set()
        for item_id in ids:
            key = str(item_id)
            if key in seen:
                continue
            seen.add(key)
            path = resolver(key)
            if path:
                sources.append(path)
            else:
                errors.append(f"a selected {noun} could not be found")
        imported, copy_errors = store.import_files_with_errors(project_id, sources)
        errors.extend(copy_errors)
        return jsonify({
            "ok": not errors,
            "imported": imported,
            "errors": errors,
            "project": _project_json(store.get_project(project_id)),
        })

    @app.post("/api/project/projects/<project_id>/import/pictures")
    def project_import_pictures(project_id):
        body = request.get_json(force=True, silent=True) or {}
        ids = body.get("photo_ids", body.get("ids"))
        if not isinstance(ids, list):
            return jsonify({"ok": False,
                            "error": "no photographs were selected"}), 400
        return _project_import(project_id, ids[:200], _photo_source, "photograph")

    @app.post("/api/project/projects/<project_id>/import/writing")
    def project_import_writing(project_id):
        body = request.get_json(force=True, silent=True) or {}
        ids = body.get("document_ids", body.get("ids"))
        if not isinstance(ids, list):
            return jsonify({"ok": False,
                            "error": "no documents were selected"}), 400
        return _project_import(project_id, ids[:200], _writing_source, "document")

    @app.post("/api/project/projects/<project_id>/import/files")
    def project_import_files(project_id):
        store = _project_store()
        if store is None or store.get_project(project_id) is None:
            abort(404)
        body = request.get_json(force=True, silent=True) or {}
        paths = body.get("paths")
        if not isinstance(paths, list):
            return jsonify({"ok": False,
                            "error": "no files were selected"}), 400
        # The paths originate in the native open dialog.  ProjectStore still
        # requires absolute, existing files and owns all destination checks.
        imported, errors = store.import_files_with_errors(project_id, paths[:200])
        return jsonify({
            "ok": not errors,
            "imported": imported,
            "errors": errors,
            "project": _project_json(store.get_project(project_id)),
        })

    @app.post("/api/project/projects/<project_id>/snapshot")
    def save_project_snapshot(project_id):
        store = _project_store()
        project = store.get_project(project_id) if store is not None else None
        if project is None:
            abort(404)
        if request.content_length and request.content_length > 120 * 1024 * 1024:
            return jsonify({"ok": False,
                            "error": "the project snapshot was too large"}), 413
        body = request.get_json(force=True, silent=True) or {}
        data = _decode_image_data(body.get("data_url", body.get("jpeg")))
        if data is None:
            return jsonify({"ok": False,
                            "error": "the project canvas could not be captured"}), 400
        try:
            from PIL import Image
            image = Image.open(io.BytesIO(data))
            safe_size = image.width * image.height <= 100_000_000
            image.verify()
            is_jpeg = image.format == "JPEG" and safe_size
            image.close()
        except Exception:
            is_jpeg = False
        if not is_jpeg:
            return jsonify({"ok": False,
                            "error": "the project snapshot was not a JPEG"}), 400
        downloads = _downloads_directory()
        if not downloads:
            return jsonify({"ok": False,
                            "error": "the downloads folder could not be found"}), 400
        try:
            os.makedirs(downloads, exist_ok=True)
            if not os.path.isdir(downloads):
                raise OSError("downloads is not a directory")
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            stem = f"{project.get('title') or 'project'}-{stamp}"
            path = _unique_export_path(downloads, stem, ".jpg")
            # Guard against the Downloads path changing through a symlink
            # between resolution and write.
            if os.path.dirname(os.path.realpath(path)) != os.path.realpath(downloads):
                raise OSError("snapshot target escaped downloads")
            _write_new_bytes(path, data)
        except OSError:
            return jsonify({"ok": False,
                            "error": "the project canvas could not be saved to downloads"}), 400
        return jsonify({
            "ok": True,
            "path": path,
            "filename": os.path.basename(path),
            "message": "project canvas saved to downloads",
        })

    @app.get("/project/file/<project_id>/<file_id>")
    def project_file(project_id, file_id):
        store = _project_store()
        path = store.resolve_file(project_id, file_id) if store is not None else None
        if path is None:
            abort(404)
        return send_file(path, mimetype=store.mime_for(path), conditional=True,
                         max_age=0)

    @app.get("/project/preview/<project_id>/<file_id>")
    def project_preview(project_id, file_id):
        store = _project_store()
        path = store.preview_for(project_id, file_id) if store is not None else None
        if path is None:
            abort(404)
        return send_file(path, mimetype=store.mime_for(path), conditional=True,
                         max_age=3600)

    # ---- writing: TXT-first documents with legacy DOCX support -------------

    def _wstore():
        return writing_archive.store if writing_archive is not None else None

    @app.get("/api/writing/status")
    def writing_status():
        if writing_archive is None:
            return jsonify({"linked": False, "root": None, "pending": 0})
        return jsonify(writing_archive.status())

    @app.post("/api/writing/root")
    def set_writing_root():
        """Link the Writing context to its mixed TXT/DOCX folder."""
        if writing_archive is None:
            return jsonify({"ok": False, "error": "writing unavailable"}), 400
        body = request.get_json(force=True, silent=True) or {}
        ok, err = writing_archive.set_root(body.get("path", ""))
        if not ok:
            return jsonify({"ok": False, "error": err}), 400
        return jsonify({"ok": True, "root": writing_archive.root})

    @app.get("/api/writing/documents")
    def writing_documents():
        store = _wstore()
        if store is None:
            return jsonify({"documents": [], "linked": False})
        return jsonify({"documents": store.list_docs(), "linked": True})

    @app.post("/api/writing/documents")
    def create_writing_document():
        store = _wstore()
        if store is None:
            abort(404)
        body = request.get_json(force=True, silent=True) or {}
        return jsonify(store.create_doc(_prepare_writing_fields(archive, body)))

    @app.get("/api/writing/documents/<doc_id>")
    def get_writing_document(doc_id):
        store = _wstore()
        if store is None:
            abort(404)
        doc = store.get_doc(doc_id)
        if doc is None:
            abort(404)
        return jsonify(doc)

    @app.post("/api/writing/documents/<doc_id>")
    def save_writing_document(doc_id):
        store = _wstore()
        if store is None:
            abort(404)
        body = request.get_json(force=True, silent=True) or {}
        source = store.source_path(doc_id) if hasattr(store, "source_path") else None
        embed = bool(source and source.lower().endswith(".docx"))
        return jsonify(store.save_doc(
            doc_id, _prepare_writing_fields(archive, body, embed_images=embed)))

    @app.post("/api/writing/documents/<doc_id>/duplicate")
    def duplicate_writing_document(doc_id):
        store = _wstore()
        if store is None:
            abort(404)
        doc = store.duplicate_doc(doc_id)
        if doc is None:
            abort(404)
        return jsonify(doc)

    @app.post("/api/writing/documents/<doc_id>/delete")
    def delete_writing_document(doc_id):
        store = _wstore()
        if store is None:
            abort(404)
        store.delete_doc(doc_id)
        return jsonify({"ok": True})

    @app.post("/api/writing/export-pdf")
    def export_writing_pdf():
        """Persist rendered Writing pages as a visually faithful PDF.

        Native mode supplies the path returned by the operating system's Save
        dialog.  Browser mode omits it and receives a normal attachment.
        """
        if request.content_length and request.content_length > 280 * 1024 * 1024:
            return jsonify({"ok": False,
                            "error": "the rendered document is too large"}), 413
        body = request.get_json(force=True, silent=True) or {}
        try:
            data = _pdf_bytes(body.get("pages"))
        except (ValueError, OSError):
            return jsonify({"ok": False,
                            "error": "the document could not be prepared as a PDF"}), 400

        raw_path = body.get("path")
        suggested = _safe_export_name(body.get("filename"), "writing")
        if not suggested.lower().endswith(".pdf"):
            suggested += ".pdf"
        if not raw_path:
            return send_file(io.BytesIO(data), mimetype="application/pdf",
                             as_attachment=True, download_name=suggested,
                             max_age=0)
        if not isinstance(raw_path, str) or not os.path.isabs(raw_path):
            return jsonify({"ok": False,
                            "error": "the PDF destination was not valid"}), 400
        path = os.path.realpath(raw_path)
        if not path.lower().endswith(".pdf"):
            path += ".pdf"
        parent = os.path.dirname(path)
        if not parent or not os.path.isdir(parent):
            return jsonify({"ok": False,
                            "error": "the PDF folder could not be found"}), 400
        if os.path.basename(path) in ("", ".", ".."):
            return jsonify({"ok": False,
                            "error": "the PDF filename was not valid"}), 400
        tmp = f"{path}.tmp.{os.getpid()}.{threading.get_ident()}"
        try:
            with open(tmp, "wb") as f:
                f.write(data)
                f.flush()
                try:
                    os.fsync(f.fileno())
                except OSError:
                    pass
            os.replace(tmp, path)
        except OSError:
            try:
                if os.path.exists(tmp):
                    os.remove(tmp)
            except OSError:
                pass
            return jsonify({"ok": False,
                            "error": "the PDF could not be saved there"}), 400
        return jsonify({"ok": True, "path": path,
                        "filename": os.path.basename(path)})

    @app.get("/api/wall")
    def wall():
        store = archive.store
        if store is None:            # no folder linked yet
            return jsonify({"clusters": [], "flags": {}, "count": 0,
                            "shown": 0, "linked": False})
        photos = store.all_photos()
        flags = store.meta_flags()
        folder_meta = store.all_folder_meta()
        total = len(photos)

        # resolve effective camera / film per photo:
        # its own override wins, otherwise the folder (roll) default
        for p in photos:
            f = flags.get(p["id"], {})
            fm = folder_meta.get(p["folder"], {})
            camera = f.get("camera") or fm.get("camera") or ""
            film = f.get("film") or fm.get("film") or ""
            if camera or film:
                entry = flags.setdefault(p["id"], {})
                if camera:
                    entry["camera"] = camera
                if film:
                    entry["film"] = film

        # optional filters: ?tag=a,b ?stars=n (and up) ?camera= ?film= ?q=
        # several tags may be chosen at once; a photo must carry them all.
        # tags are matched case-insensitively and trimmed, so a photo tagged
        # "Sunset" is never missed when filtering by "sunset".
        tags_q = [t.strip().lower()
                  for t in (request.args.get("tag") or "").split(",")
                  if t.strip()]
        camera_q = (request.args.get("camera") or "").strip()
        film_q = (request.args.get("film") or "").strip()
        q = (request.args.get("q") or "").strip().lower()
        try:
            stars = int(request.args.get("stars") or 0)
        except ValueError:
            stars = 0
        if tags_q or stars or camera_q or film_q or q:
            text = store.search_text() if q else {}
            words = q.split()

            def keep(p):
                f = flags.get(p["id"], {})
                mine = {t.strip().lower() for t in (f.get("tags") or [])}
                for t in tags_q:
                    if t not in mine:
                        return False
                if stars and (f.get("rating") or 0) < stars:
                    return False
                if camera_q and f.get("camera") != camera_q:
                    return False
                if film_q and f.get("film") != film_q:
                    return False
                if words:
                    hay = " ".join((
                        p.get("folder") or "", p.get("filename") or "",
                        p.get("exif_date") or "",
                        text.get(p["id"], ""),
                        f.get("camera") or "", f.get("film") or "",
                    )).lower()
                    for w in words:
                        if w not in hay:
                            return False
                return True
            photos = [p for p in photos if keep(p)]

        filtered = bool(tags_q or stars or camera_q or film_q or q)
        # the user's own cluster positions apply to the full wall;
        # a filtered view gathers matches into fresh compact clusters
        offsets = {} if filtered else store.folder_offsets()
        clusters = layout.build_wall(photos, offsets)
        return jsonify({
            "clusters": clusters,
            "flags": flags,
            "count": total,
            "shown": len(photos),
            "linked": True,
        })

    @app.get("/api/gradient")
    def gradient():
        """Every photograph, ordered by its most present colour."""
        store = archive.store
        if store is None:
            return jsonify({"order": []})
        cached = store.all_colors()
        items = []
        for p in store.all_photos():
            c = cached.get(p["id"])
            if c is None:
                c = dominant_color(archive.scanner.thumb_path(p["id"]))
                if c is None:
                    continue
                store.set_color(p["id"], *c)
            items.append((p["id"], c))

        def key(it):
            h, s, l = it[1]
            if s < 0.12:
                return (1, l, 0)
            return (0, h, l)
        items.sort(key=key)
        return jsonify({"order": [
            {"id": pid, "h": h, "s": s, "l": l}
            for pid, (h, s, l) in items
        ]})

    @app.get("/api/tags")
    def tags():
        """All tags currently in use anywhere in the archive, read fresh from
        the metadata folder each time (so a tag just added — here or by another
        instance — is never missed) and deduped case-insensitively so the same
        tag in different casings is offered once."""
        store = archive.store
        if store is None:
            return jsonify([])
        seen = {}
        for f in store.meta_flags().values():
            for t in f.get("tags") or []:
                key = t.strip().lower()
                if key and key not in seen:
                    seen[key] = t.strip()
        return jsonify(sorted(seen.values(), key=str.lower))

    # ---- single photo ------------------------------------------------------

    @app.get("/api/photo/<pid>")
    def photo_detail(pid):
        store = archive.store
        if store is None:
            abort(404)
        p = store.get_photo(pid)
        if not p:
            abort(404)
        meta = store.get_meta(pid)
        return jsonify({
            "photo": p,
            "meta": meta,
            "folder_meta": store.get_folder_meta(p["folder"]),
            "annotations": store.get_annotations(pid),
        })

    @app.post("/api/photo/<pid>/meta")
    def save_meta(pid):
        store = archive.store
        if store is None or not store.get_photo(pid):
            abort(404)
        fields = request.get_json(force=True, silent=True) or {}
        store.set_meta(pid, fields)
        return jsonify({"ok": True})

    @app.post("/api/folder/offset")
    def save_folder_offset():
        store = archive.store
        if store is None:
            abort(404)
        body = request.get_json(force=True, silent=True) or {}
        folder = body.get("folder")
        if folder is None:
            abort(400)
        try:
            dx = float(body.get("dx") or 0)
            dy = float(body.get("dy") or 0)
        except (TypeError, ValueError):
            abort(400)
        store.add_folder_offset(folder, dx, dy)
        return jsonify({"ok": True})

    @app.post("/api/folder/meta")
    def save_folder_meta():
        store = archive.store
        if store is None:
            abort(404)
        body = request.get_json(force=True, silent=True) or {}
        folder = body.get("folder")
        if folder is None:
            abort(400)
        store.set_folder_meta(folder, body)
        return jsonify({"ok": True})

    @app.post("/api/photo/<pid>/annotations")
    def save_annotations(pid):
        store = archive.store
        if store is None or not store.get_photo(pid):
            abort(404)
        data = request.get_json(force=True, silent=True)
        store.set_annotations(pid, data or {})
        return jsonify({"ok": True})

    # ---- writing mode: documents (a separate cache domain) ----------------

    @app.get("/api/documents")
    def documents():
        """Every Writing Mode document, newest first. Returns full documents so
        the horizontal archive can render an accurate representation of each
        (text, formatting, pagination, image groups, annotations), never a
        placeholder. The image archive is untouched by any of this."""
        ds = archive.docstore
        if ds is None:
            return jsonify({"documents": [], "linked": False})
        return jsonify({"documents": ds.list_docs(), "linked": True})

    @app.post("/api/documents")
    def create_document():
        ds = archive.docstore
        if ds is None:
            abort(404)
        fields = request.get_json(force=True, silent=True) or {}
        return jsonify(ds.create_doc(fields))

    @app.get("/api/documents/<doc_id>")
    def get_document(doc_id):
        ds = archive.docstore
        if ds is None:
            abort(404)
        doc = ds.get_doc(doc_id)
        if doc is None:
            abort(404)
        return jsonify(doc)

    @app.post("/api/documents/<doc_id>")
    def save_document(doc_id):
        ds = archive.docstore
        if ds is None:
            abort(404)
        fields = request.get_json(force=True, silent=True) or {}
        return jsonify(ds.save_doc(doc_id, fields))

    @app.post("/api/documents/<doc_id>/duplicate")
    def duplicate_document(doc_id):
        ds = archive.docstore
        if ds is None:
            abort(404)
        doc = ds.duplicate_doc(doc_id)
        if doc is None:
            abort(404)
        return jsonify(doc)

    @app.post("/api/documents/<doc_id>/delete")
    def delete_document(doc_id):
        ds = archive.docstore
        if ds is None:
            abort(404)
        ds.delete_doc(doc_id)
        return jsonify({"ok": True})

    # ---- pixels ------------------------------------------------------------

    @app.get("/thumb/<pid>.jpg")
    def thumb(pid):
        if archive.scanner is None:
            abort(404)
        path = archive.scanner.thumb_path(pid)
        if not os.path.exists(path):
            abort(404)
        return send_file(path, mimetype="image/jpeg", max_age=86400)

    @app.get("/image/<pid>")
    def image(pid):
        store = archive.store
        if store is None:
            abort(404)
        p = store.get_photo(pid)
        if not p:
            abort(404)
        path = archive.scanner.display_path(p)
        if not os.path.exists(path):
            abort(404)
        return send_file(path, max_age=3600)

    return app
