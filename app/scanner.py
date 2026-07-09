"""Archive scanner: reads D:\\film_photos recursively, builds thumbnails.

Strictly read-only towards the archive. Thumbnails and previews are written
only inside the app's own data folder.
"""
import colorsys
import hashlib
import os
import threading
import time
import traceback

from PIL import Image, ImageOps, ExifTags

Image.MAX_IMAGE_PIXELS = None  # large film scans are fine; files are trusted

EXTENSIONS = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp", ".webp"}
THUMB_SIZE = 512
BROWSER_SAFE = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}
# the app's own metadata folder lives inside the archive; never treat it
# as photographs (the older name is still skipped for archives set up before
# the rename)
SKIP_DIRS = {"cache", "film_archive_app_metadata"}

_DATE_TAGS = ("DateTimeOriginal", "DateTimeDigitized", "DateTime")
_TAG_IDS = {name: tid for tid, name in ExifTags.TAGS.items()}


def photo_id(rel_path):
    return hashlib.sha1(rel_path.replace("\\", "/").encode("utf-8")).hexdigest()[:16]


def _exif_date(img):
    try:
        exif = img.getexif()
        if not exif:
            return ""
        # DateTimeOriginal lives in the Exif IFD on most files
        try:
            ifd = exif.get_ifd(0x8769)
        except Exception:
            ifd = {}
        for tag in _DATE_TAGS:
            tid = _TAG_IDS.get(tag)
            if not tid:
                continue
            val = ifd.get(tid) or exif.get(tid)
            if val:
                val = str(val).strip()
                # "2019:05:14 16:02:11" -> "2019-05-14"
                date = val.split(" ")[0].replace(":", "-")
                if len(date) == 10 and date[:4].isdigit():
                    return date
    except Exception:
        pass
    return ""


def dominant_color(path):
    """A photograph's most present colour as (h, s, l), each 0..1.
    Saturated pixels vote by hue, weighted by how vivid they are;
    near-grey photographs fall back to their average lightness."""
    try:
        with Image.open(path) as img:
            img = img.convert("RGB")
            img.thumbnail((48, 48))
            pixels = list(img.getdata())
    except Exception:
        return None
    if not pixels:
        return None
    buckets = {}
    grey_l = 0.0
    saturated = 0
    for r, g, b in pixels:
        h, l, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
        grey_l += l
        if s > 0.22 and 0.10 < l < 0.92:
            saturated += 1
            w = s * (1 - abs(l - 0.5))
            e = buckets.setdefault(int(h * 24) % 24, [0.0, 0.0, 0.0, 0.0])
            e[0] += w
            e[1] += h * w
            e[2] += s * w
            e[3] += l * w
    if buckets and saturated / len(pixels) > 0.05:
        e = max(buckets.values(), key=lambda v: v[0])
        return (e[1] / e[0], e[2] / e[0], e[3] / e[0])
    return (0.0, 0.0, grey_l / len(pixels))


class Scanner:
    """Background scan of the archive with a small status the UI can poll."""

    def __init__(self, root, store, data_dir):
        self.root = root
        self.store = store
        self.thumb_dir = os.path.join(data_dir, "thumbs")
        self.preview_dir = os.path.join(data_dir, "previews")
        os.makedirs(self.thumb_dir, exist_ok=True)
        os.makedirs(self.preview_dir, exist_ok=True)
        self._lock = threading.Lock()
        self._thread = None
        self._stopped = False
        self.state = {"phase": "idle", "found": 0, "done": 0, "total": 0,
                      "errors": 0}

    # ---- public -----------------------------------------------------------

    def start(self):
        with self._lock:
            if self._stopped:
                return
            if self._thread and self._thread.is_alive():
                return
            self._thread = threading.Thread(target=self._run, daemon=True)
            self._thread.start()

    def stop(self):
        """End this scanner for good — used when the app switches to a
        different archive folder, so the old watcher does not keep running."""
        self._stopped = True

    def status(self):
        return dict(self.state)

    def watch(self, interval=45):
        """Quietly rescan whenever the archive folder changes on disk —
        new rolls simply appear on the wall, no user action involved."""
        def loop():
            last = self._signature()
            while not self._stopped:
                time.sleep(interval)
                if self._stopped:
                    return
                try:
                    sig = self._signature()
                except Exception:
                    continue
                if sig != last:
                    last = sig
                    self.start()
        threading.Thread(target=loop, daemon=True).start()

    def _signature(self):
        """Cheap fingerprint of the tree: paths, mtimes, sizes only."""
        h = hashlib.sha1()
        if not os.path.isdir(self.root):
            return "missing"
        for dirpath, dirnames, filenames in os.walk(self.root):
            dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
            for name in sorted(filenames):
                if os.path.splitext(name)[1].lower() in EXTENSIONS:
                    try:
                        st = os.stat(os.path.join(dirpath, name))
                    except OSError:
                        continue
                    h.update(f"{dirpath}|{name}|{st.st_mtime}|{st.st_size}"
                             .encode("utf-8", "replace"))
        return h.hexdigest()

    def thumb_path(self, pid):
        return os.path.join(self.thumb_dir, pid + ".jpg")

    # ---- scan -------------------------------------------------------------

    def _run(self):
        try:
            self.state.update(phase="reading", found=0, done=0, total=0,
                              errors=0)
            files = self._collect()
            self.state.update(found=len(files), total=len(files),
                              phase="thumbs")
            known = {p["id"]: p for p in self.store.all_photos(True)}
            seen = set()
            new_ids = []
            for rel, full in files:
                if self._stopped:
                    return
                pid = photo_id(rel)
                seen.add(pid)
                try:
                    self._index_one(pid, rel, full, known.get(pid))
                    if pid not in known:
                        new_ids.append(pid)
                except Exception:
                    traceback.print_exc()
                    self.state["errors"] += 1
                self.state["done"] += 1

            # photos that vanished since last scan
            gone = [pid for pid, p in known.items()
                    if pid not in seen and not p["missing"]]
            if gone:
                self._reconcile_moves(gone, new_ids, known)
            self.state["phase"] = "ready"
        except Exception:
            traceback.print_exc()
            self.state["phase"] = "error"

    def _collect(self):
        files = []
        if not os.path.isdir(self.root):
            return files
        for dirpath, dirnames, filenames in os.walk(self.root):
            dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
            for name in sorted(filenames):
                if os.path.splitext(name)[1].lower() in EXTENSIONS:
                    full = os.path.join(dirpath, name)
                    rel = os.path.relpath(full, self.root)
                    files.append((rel, full))
        return files

    def _index_one(self, pid, rel, full, existing):
        st = os.stat(full)
        thumb = self.thumb_path(pid)
        unchanged = (existing and existing["mtime"] == st.st_mtime
                     and existing["size"] == st.st_size
                     and os.path.exists(thumb))
        if unchanged:
            # a photo that is back on disk must never stay flagged missing
            if existing["missing"]:
                self.store.mark_present(pid)
            return
        with Image.open(full) as img:
            width, height = img.size
            exif_date = _exif_date(img)
            img = ImageOps.exif_transpose(img)
            img.thumbnail((THUMB_SIZE, THUMB_SIZE), Image.LANCZOS)
            if img.mode not in ("RGB", "L"):
                img = img.convert("RGB")
            img.save(thumb, "JPEG", quality=85)
        # clusters are only one level deep: everything under a top-level
        # subfolder (however deeply nested) belongs to that subfolder's
        # cluster; images sitting directly in the archive root share the
        # loose cluster ("")
        rel_dir = os.path.dirname(rel).replace("\\", "/")
        folder = rel_dir.split("/", 1)[0] if rel_dir else ""
        self.store.upsert_photo({
            "id": pid, "rel_path": rel.replace("\\", "/"), "folder": folder,
            "filename": os.path.basename(rel), "size": st.st_size,
            "mtime": st.st_mtime, "width": width, "height": height,
            "exif_date": exif_date, "first_seen": st.st_mtime,
        })

    def _reconcile_moves(self, gone, new_ids, known):
        """If a file was renamed/moved, carry its notes over (matched by
        filename + byte size). Otherwise just mark it missing."""
        unmatched = []
        new_photos = {pid: self.store.get_photo(pid) for pid in new_ids}
        for old_id in gone:
            old = known[old_id]
            match = None
            for nid, np in list(new_photos.items()):
                if (np and np["filename"] == old["filename"]
                        and np["size"] == old["size"]):
                    match = nid
                    break
            if match:
                self.store.migrate_photo(old_id, match)
                new_photos.pop(match, None)
            else:
                unmatched.append(old_id)
        if unmatched:
            self.store.mark_missing(unmatched)

    # ---- full-size preview for the detail view ----------------------------

    def display_path(self, photo):
        """Path to a browser-displayable full-size image. Originals that the
        browser can already show are returned as-is; TIFFs get a cached
        high-quality JPEG preview (written only in the app data folder)."""
        full = os.path.join(self.root, photo["rel_path"])
        ext = os.path.splitext(full)[1].lower()
        if ext in BROWSER_SAFE:
            return full
        cached = os.path.join(self.preview_dir, photo["id"] + ".jpg")
        try:
            if (not os.path.exists(cached)
                    or os.path.getmtime(cached) < os.path.getmtime(full)):
                with Image.open(full) as img:
                    img = ImageOps.exif_transpose(img)
                    if img.mode not in ("RGB", "L"):
                        img = img.convert("RGB")
                    img.save(cached, "JPEG", quality=92)
        except Exception:
            traceback.print_exc()
            return full  # let the browser try; better than nothing
        return cached
