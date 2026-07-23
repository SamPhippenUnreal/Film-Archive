"""Local derived cache for Archive (data/archive.db): the photo index,
thumbnails' companion rows, and the dominant-colour cache. These are all
rebuildable per machine and never leave the app folder.

Every piece of user-authored metadata — notes, titles, dates, tags, stars,
camera/film, rotation, black-and-white, and drawings — lives instead in the
shared MetaStore (sidecar JSON in the archive's cloud folder), so multiple
instances stay in sync. Store delegates those calls to it.

Nothing here ever writes to the photo files themselves.
"""
import os
import sqlite3
import threading

_SCHEMA = """
CREATE TABLE IF NOT EXISTS photos (
    id          TEXT PRIMARY KEY,
    rel_path    TEXT NOT NULL,
    folder      TEXT NOT NULL,
    filename    TEXT NOT NULL,
    size        INTEGER,
    mtime       REAL,
    width       INTEGER,
    height      INTEGER,
    exif_date   TEXT,
    first_seen  REAL,
    missing     INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT
);
CREATE TABLE IF NOT EXISTS colors (
    photo_id    TEXT PRIMARY KEY,
    h           REAL,
    s           REAL,
    l           REAL
);
CREATE INDEX IF NOT EXISTS idx_photos_folder ON photos(folder);
"""


class Store:
    def __init__(self, db_path, metastore):
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        self._db_path = db_path
        self.meta = metastore          # shared, cloud-synced annotation store
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.executescript(_SCHEMA)
            self._conn.commit()

    # ---- photos -----------------------------------------------------------

    def upsert_photo(self, rec):
        with self._lock:
            self._conn.execute(
                """INSERT INTO photos
                   (id, rel_path, folder, filename, size, mtime, width, height,
                    exif_date, first_seen, missing)
                   VALUES (:id, :rel_path, :folder, :filename, :size, :mtime,
                           :width, :height, :exif_date, :first_seen, 0)
                   ON CONFLICT(id) DO UPDATE SET
                    rel_path=:rel_path, folder=:folder, filename=:filename,
                    size=:size, mtime=:mtime, width=:width, height=:height,
                    exif_date=:exif_date, missing=0""",
                rec,
            )
            self._conn.commit()

    def all_photos(self, include_missing=False):
        q = "SELECT * FROM photos"
        if not include_missing:
            q += " WHERE missing=0"
        with self._lock:
            return [dict(r) for r in self._conn.execute(q)]

    def get_photo(self, photo_id):
        with self._lock:
            r = self._conn.execute(
                "SELECT * FROM photos WHERE id=?", (photo_id,)
            ).fetchone()
            return dict(r) if r else None

    def mark_present(self, photo_id):
        with self._lock:
            self._conn.execute(
                "UPDATE photos SET missing=0 WHERE id=?", (photo_id,))
            self._conn.commit()

    def mark_missing(self, ids):
        with self._lock:
            self._conn.executemany(
                "UPDATE photos SET missing=1 WHERE id=?", [(i,) for i in ids]
            )
            self._conn.commit()

    def migrate_photo(self, old_id, new_id):
        """Move notes + drawings from a missing photo to its renamed twin,
        then forget the old index row."""
        self.meta.migrate(old_id, new_id)
        with self._lock:
            self._conn.execute("DELETE FROM photos WHERE id=?", (old_id,))
            self._conn.commit()

    # ---- user metadata: delegated to the shared cloud store ---------------

    def get_meta(self, photo_id):
        return self.meta.get_meta(photo_id)

    def set_meta(self, photo_id, fields):
        self.meta.set_meta(photo_id, fields)

    def get_annotations(self, photo_id):
        return self.meta.get_annotations(photo_id)

    def set_annotations(self, photo_id, data):
        self.meta.set_annotations(photo_id, data)

    def get_folder_meta(self, folder):
        return self.meta.get_folder_meta(folder)

    def set_folder_meta(self, folder, fields):
        self.meta.set_folder_meta(folder, fields)

    def all_folder_meta(self):
        return self.meta.all_folder_meta()

    def folder_offsets(self):
        return self.meta.folder_offsets()

    def add_folder_offset(self, folder, dx, dy):
        self.meta.add_folder_offset(folder, dx, dy)

    def meta_flags(self):
        return self.meta.meta_flags()

    def meta_titles(self):
        return self.meta.meta_titles()

    def search_text(self):
        return self.meta.search_text()

    # ---- dominant colours (for the gradient shelf) --------------------------

    def all_colors(self):
        with self._lock:
            return {r["photo_id"]: (r["h"], r["s"], r["l"])
                    for r in self._conn.execute("SELECT * FROM colors")}

    def set_color(self, photo_id, h, s, l):
        with self._lock:
            self._conn.execute(
                """INSERT INTO colors (photo_id, h, s, l)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT(photo_id) DO UPDATE SET
                    h=excluded.h, s=excluded.s, l=excluded.l""",
                (photo_id, h, s, l))
            self._conn.commit()

    # ---- settings ---------------------------------------------------------

    def get_setting(self, key, default=None):
        with self._lock:
            r = self._conn.execute(
                "SELECT value FROM settings WHERE key=?", (key,)
            ).fetchone()
        return r["value"] if r else default

    def set_setting(self, key, value):
        with self._lock:
            self._conn.execute(
                """INSERT INTO settings (key, value) VALUES (?, ?)
                   ON CONFLICT(key) DO UPDATE SET value=excluded.value""",
                (key, value),
            )
            self._conn.commit()
