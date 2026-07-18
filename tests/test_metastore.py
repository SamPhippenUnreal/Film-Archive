"""Integration tests for MetaStore with the backup journal wired in:
location as first-class metadata, backward compatibility with older sidecars,
and end-to-end crash/replay behaviour through the public API.
"""
import json
import os
import tempfile
import shutil
import unittest

from app.metastore import MetaStore


class MetaBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="fa_meta_")
        self.cache = os.path.join(self.tmp, "cache")
        self.backup = os.path.join(self.tmp, "backup")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def store(self):
        return MetaStore(self.cache, local_dir=self.backup)

    def fail_cache_writes(self, ms):
        """Make every write into the shared cache fail, as if the cloud folder
        were offline — while backup writes (a separate local folder) succeed."""
        real = MetaStore._atomic_write
        cache_root = os.path.abspath(self.cache)

        def failing(path, data):
            if os.path.abspath(path).startswith(cache_root):
                raise OSError("simulated cache offline")
            real(path, data)
        ms._atomic_write = failing


class TestLocation(MetaBase):
    def test_location_is_first_class_metadata(self):
        ms = self.store()
        ms.set_meta("p1", {"title": "T", "location": "Kyoto, Japan"})
        m = ms.get_meta("p1")
        self.assertEqual(m["location"], "Kyoto, Japan")
        # searchable alongside every other field
        self.assertIn("kyoto", ms.search_text()["p1"])
        # and it round-trips into the on-disk sidecar
        side = json.load(open(os.path.join(self.cache, "photos",
                                           "p1.meta.json"), encoding="utf-8"))
        self.assertEqual(side["location"], "Kyoto, Japan")

    def test_photos_without_location_default_empty(self):
        ms = self.store()
        ms.set_meta("p1", {"title": "no location here"})
        self.assertEqual(ms.get_meta("p1")["location"], "")


class TestBackwardCompatibility(MetaBase):
    def test_old_sidecar_without_location_or_rev_loads(self):
        # a sidecar written by an earlier app version: no location, no rev
        os.makedirs(os.path.join(self.cache, "photos"))
        old = {"title": "Old One", "notes": "kept", "tags": "beach, sunset"}
        with open(os.path.join(self.cache, "photos", "p1.meta.json"),
                  "w", encoding="utf-8") as f:
            json.dump(old, f)
        ms = self.store()
        m = ms.get_meta("p1")
        self.assertEqual(m["title"], "Old One")
        self.assertEqual(m["notes"], "kept")
        self.assertEqual(m["location"], "")     # gracefully defaulted
        self.assertEqual(ms.meta_flags()["p1"]["tags"], ["beach", "sunset"])
        # editing it now adds a location and a revision without losing anything
        ms.set_meta("p1", {"location": "Rome"})
        m2 = ms.get_meta("p1")
        self.assertEqual(m2["location"], "Rome")
        self.assertEqual(m2["title"], "Old One")
        side = json.load(open(os.path.join(self.cache, "photos",
                                           "p1.meta.json"), encoding="utf-8"))
        self.assertGreaterEqual(side["rev"], 1)

    def test_existing_cache_is_not_destructively_rewritten(self):
        os.makedirs(os.path.join(self.cache, "photos"))
        p = os.path.join(self.cache, "photos", "p1.meta.json")
        with open(p, "w", encoding="utf-8") as f:
            json.dump({"title": "keep me", "notes": "n"}, f)
        before = open(p, encoding="utf-8").read()
        # merely constructing the store (startup reconcile) must not touch it
        self.store()
        self.assertEqual(open(p, encoding="utf-8").read(), before)


class TestCrashReplayThroughApi(MetaBase):
    def test_commit_backs_up_before_cache(self):
        ms = self.store()
        ms.set_meta("p1", {"title": "hi", "location": "Paris"})
        # a durable, cache-compatible backup copy exists and is synchronised
        bp = os.path.join(self.backup, "photos", "p1.meta.json")
        self.assertTrue(os.path.exists(bp))
        self.assertEqual(ms._journal.counts()["verified"], 1)

    def test_cache_failure_keeps_edit_and_replays_on_restart(self):
        ms = self.store()
        self.fail_cache_writes(ms)
        ms.set_meta("p1", {"title": "survive", "location": "Oslo"})
        # cache write failed, but the edit is safe in the backup
        self.assertFalse(os.path.exists(
            os.path.join(self.cache, "photos", "p1.meta.json")))
        self.assertEqual(ms._journal.counts()["pending"], 1)
        # "restart": a fresh store with a working cache replays on launch
        ms2 = self.store()
        m = ms2.get_meta("p1")
        self.assertEqual(m["title"], "survive")
        self.assertEqual(m["location"], "Oslo")
        self.assertEqual(ms2._journal.counts()["pending"], 0)

    def test_annotations_and_folder_meta_are_backed_up(self):
        ms = self.store()
        ms.set_annotations("p1", {"cells": [[1, 2, "#000"]]})
        ms.set_folder_meta("roll-a", {"camera": "Leica", "film": "HP5"})
        self.assertTrue(os.path.exists(
            os.path.join(self.backup, "photos", "p1.anno.json")))
        folder_files = os.listdir(os.path.join(self.backup, "folders"))
        self.assertTrue(folder_files)
        self.assertEqual(ms.get_annotations("p1"), {"cells": [[1, 2, "#000"]]})
        self.assertEqual(ms.get_folder_meta("roll-a")["camera"], "Leica")

    def test_works_without_backup_folder(self):
        # if no local backup dir is given, the store still saves normally
        ms = MetaStore(self.cache)
        ms.set_meta("p1", {"title": "plain", "location": "Berlin"})
        self.assertEqual(ms.get_meta("p1")["location"], "Berlin")


if __name__ == "__main__":
    unittest.main()
