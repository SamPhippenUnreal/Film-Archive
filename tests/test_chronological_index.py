import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from PIL import Image
from app.store import Store, _SCHEMA
from app.scanner import Scanner


class ChronologicalIndexTests(unittest.TestCase):
    def test_migrates_old_database_without_losing_existing_photos(self):
        with tempfile.TemporaryDirectory() as folder:
            db = str(Path(folder) / "old.db")
            conn = sqlite3.connect(db)
            conn.executescript(_SCHEMA.replace("    created_at  REAL,", ""))
            conn.execute("INSERT INTO photos (id, rel_path, folder, filename) VALUES ('old', 'old.jpg', '', 'old.jpg')")
            conn.commit(); conn.close()
            store = Store(db, None)
            try:
                self.assertEqual(store.get_photo("old")["filename"], "old.jpg")
                self.assertIsNone(store.get_photo("old")["created_at"])
                store.set_created_at("old", 123)
                self.assertEqual(store.get_photo("old")["created_at"], 123)
            finally:
                store._conn.close()

    def test_existing_thumbnails_receive_creation_date_without_regeneration(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "test.jpg"
            Image.new("RGB", (24, 16)).save(source)
            store = Store(str(root / "cache" / "archive.db"), None)
            try:
                scanner = Scanner(str(root), store, str(root / "cache"))
                scanner._index_one("photo", "test.jpg", str(source), None)
                record = store.get_photo("photo")
                stat = source.stat()
                expected = getattr(stat, "st_birthtime", stat.st_ctime if os.name == "nt" else None)
                self.assertEqual(record["created_at"], expected)
                before = Path(scanner.thumb_path("photo")).stat().st_mtime_ns
                store.set_created_at("photo", None)
                scanner._index_one("photo", "test.jpg", str(source), store.get_photo("photo"))
                self.assertEqual(store.get_photo("photo")["created_at"], expected)
                self.assertEqual(Path(scanner.thumb_path("photo")).stat().st_mtime_ns, before)
            finally:
                store._conn.close()
