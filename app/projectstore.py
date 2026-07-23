"""Folder-backed storage for the Project context.

The linked folder normally contains one immediate subfolder per project.  For
small, existing project folders there is one compatibility rule: when the
linked folder contains files and no project subfolders, the linked folder
itself is presented as one project.

Project material is only rewritten for an explicit in-app document edit.
Cover choice, index/canvas positions and permanent annotations live in small
atomic JSON sidecars under the linked root's ``cache/projects`` folder, while
generated image previews stay in the app's local, disposable cache.
"""
import hashlib
import json
import math
import mimetypes
import os
import re
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
WRITING_STATE_DIR = ".archive-writing"
TEXT_PREVIEW_BYTES = 64 * 1024
_INVALID_PROJECT_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_WINDOWS_RESERVED_NAMES = {
    "con", "prn", "aux", "nul",
    *(f"com{i}" for i in range(1, 10)),
    *(f"lpt{i}" for i in range(1, 10)),
}


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


def _atomic_write_bytes(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
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

    def _remove_record(self, path):
        """Remove a shared record without allowing the journal to restore it."""
        if self._journal is not None:
            self._journal.forget(path)
        try:
            os.remove(path)
        except OSError:
            pass

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

    def _index_path(self):
        return os.path.join(self.meta_dir, "index.json")

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

    def get_index_layout(self):
        """Return persisted cover positions keyed by stable project id."""
        data = _read_json(self._index_path()) or {}
        positions = data.get("positions")
        return dict(positions) if isinstance(positions, dict) else {}

    def update_index_layout(self, positions):
        if not isinstance(positions, dict):
            return False
        known = self._projects_by_id()
        updates = {}
        for raw_id, value in positions.items():
            project_id = str(raw_id)
            if project_id not in known:
                return False
            clean = self._clean_position(value, dimensions=False)
            if clean is None:
                return False
            updates[project_id] = clean
        with self._lock:
            merged = self.get_index_layout()
            merged.update(updates)
            # Deleted projects do not leave an ever-growing state record.
            merged = {key: value for key, value in merged.items() if key in known}
            self._write_record(self._index_path(), {"positions": merged})
        return True

    def _walk_files(self, project_path, single_root=False):
        out = []
        for dirpath, dirnames, filenames in os.walk(project_path, followlinks=False):
            safe_dirs = []
            for name in sorted(dirnames, key=str.casefold):
                full = os.path.join(dirpath, name)
                if (dirpath == project_path and
                        name in (RESERVED_ROOT_DIR, WRITING_STATE_DIR)):
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

    def _document_state(self, project_path, record):
        """Return the Writing-style preview model for TXT/DOCX material."""
        path = os.path.join(project_path, *record["rel_path"].split("/"))
        if not is_within(project_path, path):
            return None
        try:
            with open(path, "rb") as f:
                data = f.read()
        except OSError:
            return None
        state_path = self._writing_state_path(project_path, record)
        state = _read_json(state_path)
        if isinstance(state, dict):
            checksum = state.get("source_checksum", state.get("docx_checksum"))
            if checksum == hashlib.sha256(data).hexdigest():
                return {
                    "content": state.get("content") or "",
                    "groups": state.get("groups") or {},
                    "annotations": state.get("annotations") or {},
                    "rating": state.get("rating") or 0,
                    "tags": state.get("tags") or "",
                }
        try:
            from .docxstore import docx_bytes_to_html, plain_text_to_html
            content = (plain_text_to_html(data.decode("utf-8-sig", "replace"))
                       if record["extension"] == ".txt"
                       else docx_bytes_to_html(data))
            return {"content": content, "groups": {}, "annotations": {},
                    "rating": 0, "tags": ""}
        except Exception:
            return None

    @staticmethod
    def _writing_state_path(project_path, record):
        relative = str(record.get("rel_path") or record.get("filename") or "")
        parts = [part for part in relative.replace("\\", "/").split("/")
                 if part not in ("", ".", "..")]
        return os.path.join(project_path, WRITING_STATE_DIR, *parts) + ".json"

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
            if include_annotations and f["extension"] in (".txt", ".docx"):
                resolved = os.path.join(path, *f["rel_path"].split("/"))
                f["excerpt"] = self._text_excerpt(resolved, f["extension"])
                f["document"] = self._document_state(path, f)
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

    @staticmethod
    def validate_project_name(name):
        """Return a portable folder name, or a quiet validation error."""
        if not isinstance(name, str):
            return None, "project name is required"
        clean = name.strip()
        if not clean:
            return None, "project name cannot be empty"
        if len(clean) > 200:
            return None, "project name is too long"
        if clean in (".", "..") or clean.endswith((".", " ")):
            return None, "that project name is not valid"
        if _INVALID_PROJECT_NAME.search(clean):
            return None, "that project name contains unsupported characters"
        stem = clean.split(".", 1)[0].casefold()
        if stem in _WINDOWS_RESERVED_NAMES:
            return None, "that project name is reserved"
        if clean.casefold() in {RESERVED_ROOT_DIR.casefold(),
                                WRITING_STATE_DIR.casefold()}:
            return None, "that project name is reserved"
        return clean, None

    def rename_project(self, project_id, name):
        """Rename one immediate project folder and carry every sidecar forward.

        The linked root itself is never renamed by the single-project
        compatibility mode; relinking its parent is the safe operation there.
        """
        clean, error = self.validate_project_name(name)
        if error:
            return None, error
        resolved = self._resolve_project(project_id)
        if resolved is None:
            return None, "project could not be found"
        _, rel, old_path = resolved
        if rel == ".":
            return None, "the linked project folder cannot be renamed here"
        root_n = _norm(self.root)
        if os.path.dirname(_norm(old_path)) != root_n:
            return None, "project folder is outside the linked projects folder"
        for known_id, (known_title, _) in self._projects_by_id().items():
            if known_id != str(project_id) and known_title.casefold() == clean.casefold():
                return None, "a project with that name already exists"
        target = os.path.join(self.root, clean)
        if os.path.dirname(_norm(target)) != root_n:
            return None, "that project name is not valid"
        if _norm(target) != _norm(old_path) and os.path.exists(target):
            return None, "a project with that name already exists"
        if clean == rel:
            return self.get_project(project_id), None

        old_id = str(project_id)
        new_id = _stable_id(clean)
        old_meta, old_anno = self._meta_path(old_id), self._anno_path(old_id)
        new_meta, new_anno = self._meta_path(new_id), self._anno_path(new_id)
        moved_records = []
        with self._lock:
            try:
                os.rename(old_path, target)
                for src, dst in ((old_meta, new_meta), (old_anno, new_anno)):
                    if not os.path.exists(src):
                        continue
                    if self._journal is not None:
                        self._journal.forget(src)
                        self._journal.forget(dst)
                    try:
                        os.remove(dst)
                    except FileNotFoundError:
                        pass
                    os.replace(src, dst)
                    moved_records.append((src, dst))
            except OSError:
                for src, dst in reversed(moved_records):
                    try:
                        os.replace(dst, src)
                    except OSError:
                        pass
                if os.path.isdir(target) and not os.path.exists(old_path):
                    try:
                        os.rename(target, old_path)
                    except OSError:
                        pass
                return None, "project could not be renamed"

            layout = self.get_index_layout()
            prior = layout.pop(old_id, None)
            if prior is not None:
                layout[new_id] = prior
            self._write_record(self._index_path(), {"positions": layout})
        return self.get_project(new_id), None

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

    def delete_file(self, project_id, file_id):
        """Permanently delete one known project file and its element state."""
        resolved = self._resolve_project(project_id)
        record = self.file_record(project_id, file_id)
        path = self.resolve_file(project_id, file_id)
        if resolved is None or record is None or path is None:
            return False, "that file could not be found"
        project_path = resolved[2]
        if (_norm(path) == _norm(project_path) or
                not is_within(project_path, path) or not os.path.isfile(path)):
            return False, "that file is outside the project folder"
        with self._lock:
            try:
                os.remove(path)
            except FileNotFoundError:
                return False, "that file could not be found"
            except OSError:
                return False, "that file could not be deleted"

            state_path = self._writing_state_path(project_path, record)
            if is_within(os.path.join(project_path, WRITING_STATE_DIR), state_path):
                try:
                    os.remove(state_path)
                except OSError:
                    pass
            meta = self._metadata(project_id)
            positions = dict(meta["positions"])
            positions.pop(record["rel_path"], None)
            cover = "" if meta["cover"] == record["rel_path"] else meta["cover"]
            self._write_record(self._meta_path(project_id), {
                "project_id": str(project_id), "cover": cover,
                "positions": positions,
            })
        return True, None

    def delete_project(self, project_id):
        """Permanently delete an immediate project directory, never the root."""
        resolved = self._resolve_project(project_id)
        if resolved is None:
            return False, "project could not be found"
        _, rel, path = resolved
        if rel == ".":
            return False, "the linked projects folder cannot be deleted here"
        if (os.path.dirname(_norm(path)) != _norm(self.root) or
                _norm(path) == _norm(self.root) or not os.path.isdir(path)):
            return False, "that project is outside the linked projects folder"
        with self._lock:
            try:
                shutil.rmtree(path)
            except OSError:
                return False, "project folder could not be deleted"
            self._remove_record(self._meta_path(project_id))
            self._remove_record(self._anno_path(project_id))
            layout = self.get_index_layout()
            layout.pop(str(project_id), None)
            self._write_record(self._index_path(), {"positions": layout})
            prefix = str(project_id) + "-"
            try:
                for filename in os.listdir(self.preview_dir):
                    if filename.startswith(prefix):
                        try:
                            os.remove(os.path.join(self.preview_dir, filename))
                        except OSError:
                            pass
            except OSError:
                pass
        return True, None

    def get_document(self, project_id, file_id):
        resolved = self._resolve_project(project_id)
        record = self.file_record(project_id, file_id)
        if resolved is None or record is None or record["extension"] not in (".txt", ".docx"):
            return None
        state = self._document_state(resolved[2], record)
        if state is None:
            return None
        return dict(state, id=record["id"], title=os.path.splitext(
            record["filename"])[0], filename=record["filename"],
            source_format=record["extension"].lstrip("."), project_id=str(project_id))

    def save_document(self, project_id, file_id, fields):
        """Explicitly save a TXT or legacy DOCX through the shared editor model."""
        resolved = self._resolve_project(project_id)
        record = self.file_record(project_id, file_id)
        if (resolved is None or record is None or
                record["extension"] not in (".txt", ".docx") or
                not isinstance(fields, dict)):
            return None
        project_path = resolved[2]
        path = os.path.join(project_path, *record["rel_path"].split("/"))
        if not is_within(project_path, path) or not os.path.isfile(path):
            return None
        try:
            from .docxstore import html_to_docx_bytes, html_to_plain_text
            if record["extension"] == ".txt":
                data = html_to_plain_text(fields.get("content") or "").encode("utf-8")
            else:
                data = html_to_docx_bytes(fields.get("content") or "",
                                          fields.get("_images") or {})
            _atomic_write_bytes(path, data)
            st = os.stat(path)
            editor = fields.get("editor_state")
            if not isinstance(editor, dict):
                editor = {}
            clean = {
                "version": 2,
                "source_checksum": hashlib.sha256(data).hexdigest(),
                "source_format": record["extension"].lstrip("."),
                "source_stat": [st.st_mtime_ns, st.st_size],
                "content": editor.get("content", fields.get("content")) or "",
                "groups": editor.get("groups") if isinstance(editor.get("groups"), dict) else {},
                "annotations": (editor.get("annotations")
                                if isinstance(editor.get("annotations"), dict) else {}),
                "rating": max(0, min(5, int(editor.get("rating") or 0))),
                "tags": str(editor.get("tags") or ""),
            }
            _atomic_write_json(self._writing_state_path(project_path, record), clean)
        except (OSError, TypeError, ValueError):
            return None
        return self.get_document(project_id, file_id)

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
    def _clean_position(value, dimensions=True):
        if not isinstance(value, dict):
            return None
        clean = {}
        keys = (("x", "y", "width", "height", "z", "rotation")
                if dimensions else ("x", "y", "z"))
        for key in keys:
            if key not in value:
                continue
            val = value[key]
            if isinstance(val, bool) or not isinstance(val, (int, float)):
                return None
            val = float(val)
            if not math.isfinite(val) or abs(val) > 10_000_000:
                return None
            if key in ("width", "height") and not 32 <= val <= 5000:
                return None
            if key == "z" and not 0 <= val <= 100000:
                return None
            if key == "rotation":
                if val % 90 != 0:
                    return None
                val %= 360
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
                writing_state = (raw_source.get("writing_state")
                                 if isinstance(raw_source, dict) else None)
                source_value = (raw_source.get("path")
                                if isinstance(raw_source, dict) else raw_source)
                if not source_value or not os.path.isabs(str(source_value)):
                    errors.append("a selected file path was not valid")
                    continue
                source = os.path.realpath(str(source_value or ""))
                source_key = _norm(source)
                if source_key in seen_sources:
                    continue
                seen_sources.add(source_key)
                if not os.path.isfile(source):
                    errors.append("a selected file could not be found")
                    continue
                if is_within(project_path, source):
                    errors.append(f"{os.path.basename(source)} is already in this project")
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
                    if isinstance(writing_state, dict):
                        self._write_imported_writing_state(
                            project_path, candidate, destination, writing_state)
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

    @staticmethod
    def _write_imported_writing_state(project_path, filename, source_path, state):
        """Copy a Writing document's app-only model beside its Project copy."""
        try:
            with open(source_path, "rb") as f:
                data = f.read()
            st = os.stat(source_path)
            clean = {
                "version": 2,
                "source_checksum": hashlib.sha256(data).hexdigest(),
                "source_format": os.path.splitext(filename)[1].lower().lstrip("."),
                "source_stat": [st.st_mtime_ns, st.st_size],
                "content": state.get("content") or "",
                "groups": state.get("groups") if isinstance(state.get("groups"), dict) else {},
                "annotations": (state.get("annotations")
                                if isinstance(state.get("annotations"), dict) else {}),
                "rating": max(0, min(5, int(state.get("rating") or 0))),
                "tags": str(state.get("tags") or ""),
            }
            _atomic_write_json(ProjectStore._writing_state_path(
                project_path, {"rel_path": filename}), clean)
        except (OSError, TypeError, ValueError):
            # The primary file copy is still valid; its preview can fall back
            # to parsing the portable source without registering bad state.
            pass

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
