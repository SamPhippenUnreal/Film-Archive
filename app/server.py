"""Local HTTP layer: serves the UI, the JSON API, thumbnails and images.

Everything is read-only towards the photo archive; writes go to the local
cache and the shared metadata folder only.
"""
import os
import re

from flask import (Flask, jsonify, request, send_file, send_from_directory,
                   abort)

from . import layout
from .scanner import dominant_color


# Empty image-group placeholders the editor serializes look like
# <div class="doc-group" data-gid="ID"></div>; rehydrate each with its
# photographs so they can be embedded into the .docx.
_GROUP_RE = re.compile(
    r'<div class="doc-group"[^>]*data-gid="([^"]+)"[^>]*>\s*</div>')


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


def _prepare_writing_fields(archive, body):
    """Turn an editor save payload into the fields DocxStore needs: content with
    its image-group placeholders rehydrated, plus the resolved image bytes so
    inserted photographs are embedded as a copy inside the document."""
    content = body.get("content") or ""
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

    content = _GROUP_RE.sub(inject, content)
    return {"content": content, "title": body.get("title"), "_images": images}


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

    # ---- writing: a folder of .docx documents ------------------------------

    def _wstore():
        return writing_archive.store if writing_archive is not None else None

    @app.get("/api/writing/status")
    def writing_status():
        if writing_archive is None:
            return jsonify({"linked": False, "root": None, "pending": 0})
        return jsonify(writing_archive.status())

    @app.post("/api/writing/root")
    def set_writing_root():
        """Link (or relink) the Writing context to a folder of .docx files."""
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
        return jsonify(store.save_doc(doc_id,
                                      _prepare_writing_fields(archive, body)))

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
