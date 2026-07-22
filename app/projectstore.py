"""Folder-backed storage for the Project context.

The linked folder normally contains one immediate subfolder per project.  For
small, existing project folders there is one compatibility rule: when the
linked folder contains files and no project subfolders, the linked folder
itself is presented as one project.

Project material is never rewritten.  Cover choice, canvas positions and
permanent annotations live in small atomic JSON sidecars under the linked
root's ``cache/projects`` folder, while generated image previews stay in the
app's local, disposable cache.
"""
import hashlib
import json
import math
import mimetypes
import os
import shutil
import threading
import time

from PIL import Image, ImageOps

from .backup import BackupJournal


IMAGE_EXTENSIONS = {
    ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".psd", ".gif", ".bmp",
    ".webp",
}
DOCUMENT_EXTENSIONS = {".txt", ".pdf", ".docx"}
AUDIO_EXTENSIONS = {".mp3", ".wav"}
VIDEO_EXTENSIONS = {".mp4", ".mov"}
BROWSER_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"}
RESERVED_ROOT_DIR = "cache"
TEXT_PREVIEW_BYTES = 64 * 1024


def _stable_id(value):
    value = (value or ".").replace("\\", "/")
    return hashlib.sha1(value.encode("utf-8")).hexdigest()[:16]


def _norm(path):
    return os.path.normcase(os.path.realpath(os.path.abspath(path)))


def is_within(root, path):
    """True only when ``path`` resolves to ``root`` or one of its children."""
    try:
        root_n = _norm(root)
        path_n = _norm(path)
        return os.path.commonpath((root_n, path_n)) == root_n
    except (OSError, ValueError):
        return False


def _read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError, TypeError):
        return None


def _atomic_write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp.{os.getpid()}.{threading.get_ident()}"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError:
                pass
        os.replace(tmp, path)
    finally:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass


def _kind(extension):
    if extension in IMAGE_EXTENSIONS:
        return "image"
    if extension == ".txt":
        return "text"
    if extension in DOCUMENT_EXTENSIONS:
        return "document"
    if extension in AUDIO_EXTENSIONS:
        return "audio"
    if extension in VIDEO_EXTENSIONS:
        return "video"
    return "file"


class ProjectStore:
    """Discover project files and persist their shared, user-created state."""

    def __init__(self, root_dir, local_dir=None, preview_dir=None):
        self.root = os.path.realpath(root_dir)
        if not os.path.isdir(self.root):
            raise ValueError("project root does not exist")
        self.meta_dir = os.path.join(self.root, RESERVED_ROOT_DIR, "projects")
        os.makedirs(self.meta_dir, exist_ok=True)
        self.preview_dir = preview_dir or os.path.join(
            local_dir or self.meta_dir, "previews")
        os.makedirs(self.preview_dir, exist_ok=True)
        self._lock = threading.RLock()
        self._journal = None
        if local_dir:
            journal = BackupJournal(
                os.path.join(local_dir, "project_backup"),
                {"projects": self.meta_dir}, io=self)
            if journal.ok:
                self._journal = journal
                journal.cleanup_temp()
                journal.reconcile(force=True)

    # BackupJournal IO contract.
    def atomic_write(self, path, data):
        _atomic_write_json(path, data)

    def read_json(self, path):
        return _read_json(path)

    def _write_record(self, path, data):
        data = dict(data)
        data["updated"] = time.time()
        if self._journal is not None:
            data["rev"] = self._journal.next_rev(path)
            staged = self._journal.stage(path, data)
        else:
            staged = None
        try:
            _atomic_write_json(path, data)
        except OSError:
            if staged is None:
                raise
        if self._journal is not None:
            self._journal.reconcile()

    def _project_path(self, rel):
        path = self.root if rel == "." else os.path.join(self.root, rel)
        if not is_within(self.root, path) or not os.path.isdir(path):
            return None
        return os.path.realpath(path)

    def _project_specs(self):
        children = []
        root_files = []
        try:
            entries = list(os.scandir(self.root))
        except OSError:
            return []
        for entry in entries:
            if entry.name == RESERVED_ROOT_DIR:
                continue
            try:
                if entry.is_dir(follow_symlinks=False):
                    if is_within(self.root, entry.path):
                        children.append(entry.name)
                elif entry.is_file(follow_symlinks=False):
                    root_files.append(entry.name)
            except OSError:
                continue
        if children:
            return sorted(((name, name) for name in children),
                          key=lambda it: it[0].casefold())
        if root_files:
            return [(os.path.basename(self.root.rstrip(os.sep)) or "project", ".")]
        return []

    def _projects_by_id(self):
        return {_stable_id(rel): (title, rel)
                for title, rel in self._project_specs()}

    def _resolve_project(self, project_id):
        spec = self._projects_by_id().get(str(project_id))
        if spec is None:
            return None
        title, rel = spec
        path = self._project_path(rel)
        return (title, rel, path) if path else None

    def _meta_path(self, project_id):
        return os.path.join(self.meta_dir, str(project_id) + ".project.json")

    def _anno_path(self, project_id):
        return os.path.join(self.meta_dir, str(project_id) + ".anno.json")

    def _metadata(self, project_id):
        data = _read_json(self._meta_path(project_id)) or {}
        positions = data.get("positions")
        if not isinstance(positions, dict):
            positions = {}
        return {
            "cover": data.get("cover") if isinstance(data.get("cover"), str) else "",
            "positions": positions,
            "rev": data.get("rev", 0),
        }

    def _walk_files(self, project_path, single_root=False):
        out = []
        for dirpath, dirnames, filenames in os.walk(project_path, followlinks=False):
            safe_dirs = []
            for name in sorted(dirnames, key=str.casefold):
                full = os.path.join(dirpath, name)
                if single_root and dirpath == project_path and name == RESERVED_ROOT_DIR:
                    continue
                if os.path.islink(full):
                    continue
                if is_within(project_path, full):
                    safe_dirs.append(name)
            dirnames[:] = safe_dirs
            for name in sorted(filenames, key=str.casefold):
                full = os.path.join(dirpath, name)
                if not is_within(project_path, full) or not os.path.isfile(full):
                    continue
                try:
                    st = os.stat(full)
                except OSError:
                    continue
                rel = os.path.relpath(full, project_path).replace("\\", "/")
                ext = os.path.splitext(name)[1].lower()
                out.append({
                    "id": _stable_id(rel),
                    "filename": name,
                    "rel_path": rel,
                    "extension": ext,
                    "kind": _kind(ext),
                    "size": st.st_size,
                    "mtime": st.st_mtime,
                    "mtime_ns": st.st_mtime_ns,
                })
        out.sort(key=lambda f: f["rel_path"].casefold())
        return out

    @staticmethod
    def _text_excerpt(path, extension):
        try:
            if extension == ".txt":
                with open(path, "rb") as f:
                    blob = f.read(TEXT_PREVIEW_BYTES)
                return blob.decode("utf-8-sig", "replace").strip()[:1200]
            if extension == ".docx":
                from .docxstore import docx_text
                with open(path, "rb") as f:
                    return docx_text(f.read()).strip()[:1200]
        except Exception:
            pass
        return ""

    def _shape_project(self, project_id, title, rel, path, include_annotations=True):
        meta = self._metadata(project_id)
        files = self._walk_files(path, single_root=(rel == "."))
        by_rel = {f["rel_path"]: f for f in files}
        cover_rel = meta["cover"]
        explicit = cover_rel in by_rel and by_rel[cover_rel]["kind"] == "image"
        if explicit:
            cover = by_rel[cover_rel]
        else:
            cover = next((f for f in files if f["kind"] == "image"), None)
        for f in files:
            pos = meta["positions"].get(f["rel_path"])
            f["position"] = dict(pos) if isinstance(pos, dict) else None
            if f["extension"] in (".txt", ".docx"):
                resolved = self.resolve_file(project_id, f["id"])
                f["excerpt"] = self._text_excerpt(resolved, f["extension"]) if resolved else ""
        result = {
            "id": project_id,
            "title": title,
            "rel_path": rel,
            "single_root": rel == ".",
            "file_count": len(files),
            "files": files,
            "positions": {f["id"]: f["position"] for f in files
                          if f["position"] is not None},
            "cover_file_id": cover["id"] if cover else None,
            "cover_explicit": explicit,
        }
        if include_annotations:
            result["annotations"] = self.get_annotations(project_id)
        return result

    def list_projects(self):
        projects = []
        for project_id, (title, rel) in self._projects_by_id().items():
            path = self._project_path(rel)
            if not path:
                continue
            projects.append(self._shape_project(
                project_id, title, rel, path, include_annotations=False))
        projects.sort(key=lambda p: p["title"].casefold())
        return projects

    def get_project(self, project_id):
        resolved = self._resolve_project(project_id)
        if resolved is None:
            return None
        title, rel, path = resolved
        return self._shape_project(str(project_id), title, rel, path)

    def resolve_file(self, project_id, file_id):
        resolved = self._resolve_project(project_id)
        if resolved is None:
            return None
        _, rel, project_path = resolved
        match = next((f for f in self._walk_files(
            project_path, single_root=(rel == ".")) if f["id"] == str(file_id)), None)
        if match is None:
            return None
        path = os.path.join(project_path, *match["rel_path"].split("/"))
        if not is_within(project_path, path) or not os.path.isfile(path):
            return None
        return os.path.realpath(path)

    def file_record(self, project_id, file_id):
        project = self.get_project(project_id)
        if project is None:
            return None
        return next((f for f in project["files"] if f["id"] == str(file_id)), None)

    def set_cover(self, project_id, file_id):
        record = self.file_record(project_id, file_id)
        if record is None or record["kind"] != "image":
            return False
        with self._lock:
            meta = self._metadata(project_id)
            data = {"project_id": str(project_id), "cover": record["rel_path"],
                    "positions": meta["positions"]}
            self._write_record(self._meta_path(project_id), data)
        return True

    @staticmethod
    def _clean_position(value):
        if not isinstance(value, dict):
            return None
        clean = {}
        for key in ("x", "y", "width", "height"):
            if key not in value:
                continue
            val = value[key]
            if isinstance(val, bool) or not isinstance(val, (int, float)):
                return None
            val = float(val)
            if not math.isfinite(val) or abs(val) > 10_000_000:
                return None
            if key in ("width", "height") and val <= 0:
                return None
            clean[key] = val
        if "x" not in clean or "y" not in clean:
            return None
        return clean

    def update_positions(self, project_id, positions):
        project = self.get_project(project_id)
        if project is None or not isinstance(positions, dict):
            return False
        by_id = {f["id"]: f for f in project["files"]}
        updates = {}
        for file_id, value in positions.items():
            record = by_id.get(str(file_id))
            clean = self._clean_position(value)
            if record is None or clean is None:
                return False
            updates[record["rel_path"]] = clean
        with self._lock:
            meta = self._metadata(project_id)
            merged = dict(meta["positions"])
            merged.update(updates)
            self._write_record(self._meta_path(project_id), {
                "project_id": str(project_id), "cover": meta["cover"],
                "positions": merged,
            })
        return True

    def get_annotations(self, project_id):
        if self._resolve_project(project_id) is None:
            return None
        data = _read_json(self._anno_path(project_id)) or {}
        blob = data.get("annotations")
        return blob if isinstance(blob, dict) else {}

    def set_annotations(self, project_id, annotations):
        if self._resolve_project(project_id) is None or not isinstance(annotations, dict):
            return False
        # Future marks are ephemeral.  Existing brush data normally never puts
        # them in the saved blob; stripping defensive aliases keeps that true.
        clean = {k: v for k, v in annotations.items()
                 if str(k).lower() not in ("future", "futures", "futurecells")}
        with self._lock:
            self._write_record(self._anno_path(project_id), {
                "project_id": str(project_id), "annotations": clean,
            })
        return True

    def import_files(self, project_id, source_paths):
        """Copy trusted, server-resolved source paths and return new records."""
        return self.import_files_with_errors(project_id, source_paths)[0]

    def import_files_with_errors(self, project_id, source_paths):
        """Import variant used by the HTTP layer to surface per-file errors."""
        resolved = self._resolve_project(project_id)
        if resolved is None:
            return [], ["project could not be found"]
        _, _, project_path = resolved
        imported, errors = [], []
        seen_sources = set()
        with self._lock:
            try:
                existing = {n.casefold() for n in os.listdir(project_path)}
            except OSError:
                return [], ["project folder could not be read"]
            for raw_source in source_paths or []:
                source = os.path.realpath(str(raw_source))
                source_key = _norm(source)
                if source_key in seen_sources:
                    continue
                seen_sources.add(source_key)
                if not os.path.isfile(source):
                    errors.append("a selected file could not be found")
                    continue
                original = os.path.basename(source)
                stem, ext = os.path.splitext(original)
                candidate = original
                n = 2
                while candidate.casefold() in existing:
                    candidate = f"{stem} {n}{ext}"
                    n += 1
                destination = os.path.join(project_path, candidate)
                if not is_within(project_path, destination):
                    errors.append("a selected file could not be placed")
                    continue
                created = False
                try:
                    # Exclusive creation is the no-overwrite guarantee even if
                    # another process adds the same name between scan and copy.
                    with open(source, "rb") as src:
                        with open(destination, "xb") as dst:
                            created = True
                            shutil.copyfileobj(src, dst, 1024 * 1024)
                            dst.flush()
                            try:
                                os.fsync(dst.fileno())
                            except OSError:
                                pass
                    try:
                        shutil.copystat(source, destination)
                    except OSError:
                        pass
                except OSError:
                    try:
                        if created and os.path.exists(destination):
                            os.remove(destination)
                    except OSError:
                        pass
                    errors.append(f"{original} could not be placed")
                    continue
                existing.add(candidate.casefold())
                imported.append(_stable_id(candidate.replace("\\", "/")))
        records = []
        refreshed = self.get_project(project_id)
        if refreshed:
            by_id = {f["id"]: f for f in refreshed["files"]}
            records = [by_id[i] for i in imported if i in by_id]
        return records, errors

    def preview_for(self, project_id, file_id):
        record = self.file_record(project_id, file_id)
        path = self.resolve_file(project_id, file_id)
        if record is None or path is None or record["kind"] != "image":
            return None
        cached = os.path.join(
            self.preview_dir,
            f"{project_id}-{file_id}-{record['mtime_ns']}-{record['size']}.jpg")
        if os.path.exists(cached):
            return cached
        tmp = cached + f".tmp.{os.getpid()}.{threading.get_ident()}"
        try:
            with Image.open(path) as image:
                image.seek(0)
                image = ImageOps.exif_transpose(image)
                image.thumbnail((1600, 1600), Image.LANCZOS)
                if image.mode not in ("RGB", "L"):
                    image = image.convert("RGB")
                image.save(tmp, "JPEG", quality=88)
            os.replace(tmp, cached)
            return cached
        except Exception:
            try:
                if os.path.exists(tmp):
                    os.remove(tmp)
            except OSError:
                pass
            return None

    def mime_for(self, path):
        return mimetypes.guess_type(path)[0] or "application/octet-stream"
