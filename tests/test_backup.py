"""Tests for the crash-resilient write-ahead backup journal (app/backup.py).

These exercise the durability guarantees directly, with a controllable clock
and an io layer that can be told to make cache writes fail — standing in for a
cloud folder that is offline, locked, or swallowing writes, and for a crash at
each stage of the backup -> cache -> prune sequence.
"""
import json
import os
import tempfile
import shutil
import unittest

from app.backup import BackupJournal, checksum
from app.metastore import MetaStore


class Clock:
    def __init__(self, t=1_000_000.0):
        self.t = t

    def __call__(self):
        return self.t

    def tick(self, dt):
        self.t += dt


class Io:
    """Real atomic file io, but able to fail writes under given path prefixes
    to simulate an unavailable / cloud-delayed cache."""

    def __init__(self):
        self.fail_prefixes = []

    def atomic_write(self, path, data):
        for pre in self.fail_prefixes:
            if os.path.abspath(path).startswith(os.path.abspath(pre)):
                raise OSError("simulated unavailable: " + path)
        MetaStore._atomic_write(path, data)

    def read_json(self, path):
        return MetaStore._read_json(path)


class BackupBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="fa_backup_")
        self.clock = Clock()
        self.io = Io()
        self.cache_photos = os.path.join(self.tmp, "cache", "photos")
        self.cache_folders = os.path.join(self.tmp, "cache", "folders")
        os.makedirs(self.cache_photos)
        os.makedirs(self.cache_folders)
        self.backup = os.path.join(self.tmp, "backup")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def journal(self, retention=None):
        return BackupJournal(
            self.backup,
            {"photos": self.cache_photos, "folders": self.cache_folders},
            io=self.io, clock=self.clock, retention=retention)

    def commit(self, j, name, payload, sub="photos"):
        """Full backup-first commit path, mirroring MetaStore._write_json."""
        cache_path = os.path.join(j.cache_dirs[sub], name)
        payload = dict(payload)
        payload["rev"] = j.next_rev(cache_path)
        j.stage(cache_path, payload)
        try:
            self.io.atomic_write(cache_path, payload)
        except OSError:
            pass
        j.reconcile()
        return cache_path, payload

    def cache_path(self, name, sub="photos"):
        return os.path.join(self.tmp, "cache", sub, name)

    def backup_path(self, name, sub="photos"):
        return os.path.join(self.backup, sub, name)

    def read(self, path):
        return MetaStore._read_json(path)


class TestDurability(BackupBase):
    def test_commit_creates_durable_backup_then_verifies(self):
        j = self.journal()
        cache_path, payload = self.commit(
            j, "a.meta.json", {"title": "hi", "location": "Paris"})
        # cache holds exactly the committed bytes
        self.assertEqual(self.read(cache_path), payload)
        # a durable backup copy exists, cache-compatible in shape
        self.assertTrue(os.path.exists(self.backup_path("a.meta.json")))
        self.assertEqual(self.read(self.backup_path("a.meta.json")), payload)
        # and it is marked synchronised
        self.assertEqual(j.counts()["verified"], 1)
        self.assertEqual(j.counts()["pending"], 0)

    def test_cache_failure_leaves_backup_intact(self):
        j = self.journal()
        self.io.fail_prefixes = [os.path.join(self.tmp, "cache")]
        cache_path, payload = self.commit(j, "a.meta.json", {"title": "hi"})
        # the cache write failed...
        self.assertFalse(os.path.exists(cache_path))
        # ...but the committed edit is safe in the backup, still pending
        self.assertTrue(os.path.exists(self.backup_path("a.meta.json")))
        self.assertEqual(self.read(self.backup_path("a.meta.json")), payload)
        self.assertEqual(j.counts()["pending"], 1)

    def test_pending_replays_when_cache_recovers(self):
        j = self.journal()
        self.io.fail_prefixes = [os.path.join(self.tmp, "cache")]
        cache_path, payload = self.commit(j, "a.meta.json", {"title": "hi"})
        self.assertEqual(j.counts()["pending"], 1)
        # cache comes back; a forced sweep (as on launch) replays immediately
        self.io.fail_prefixes = []
        stats = j.reconcile(force=True)
        self.assertEqual(stats["replayed"], 1)
        self.assertEqual(self.read(cache_path), payload)
        self.assertEqual(j.counts()["pending"], 0)

    def test_exhausted_retries_are_kept_and_still_replay_on_force(self):
        j = self.journal(retention={"max_retries": 2, "backoff_start": 0.0})
        self.io.fail_prefixes = [os.path.join(self.tmp, "cache")]
        self.commit(j, "a.meta.json", {"title": "hi"})    # attempt 1 -> retry 1
        j.reconcile()                                       # attempt 2 -> retry 2
        j.reconcile()                                       # exhausted: no write
        # the edit is never lost, just no longer burning periodic retries
        self.assertEqual(j.counts()["pending"], 1)
        self.assertTrue(os.path.exists(self.backup_path("a.meta.json")))
        # cache recovers; a forced sweep (launch / cache-back) replays it
        self.io.fail_prefixes = []
        stats = j.reconcile(force=True)
        self.assertEqual(stats["replayed"], 1)
        self.assertTrue(os.path.exists(self.cache_path("a.meta.json")))

    def test_replay_is_idempotent(self):
        j = self.journal()
        self.io.fail_prefixes = [os.path.join(self.tmp, "cache")]
        cache_path, payload = self.commit(j, "a.meta.json", {"title": "hi"})
        self.io.fail_prefixes = []
        for _ in range(5):
            j.reconcile(force=True)
        # exactly one cache file, unchanged content, no duplicate journal rows
        self.assertEqual(self.read(cache_path), payload)
        self.assertEqual(len(os.listdir(self.cache_photos)), 1)
        self.assertLessEqual(j.counts()["verified"], 1)

    def test_crash_after_backup_before_cache(self):
        # a crash after step 2 (backup written) but before step 4 (cache):
        # only stage, never write cache, then a fresh journal replays on launch
        j = self.journal()
        cache_path = os.path.join(self.cache_photos, "a.meta.json")
        payload = {"title": "hi", "rev": 1}
        j.stage(cache_path, payload)
        self.assertFalse(os.path.exists(cache_path))
        # "restart": new journal over the same folders, forced reconcile
        j2 = self.journal()
        j2.reconcile(force=True)
        self.assertEqual(self.read(cache_path), payload)

    def test_crash_after_cache_before_prune(self):
        # a crash after step 4 (cache written) but before step 6 (mark synced):
        # the cache already holds the revision, so the next launch finalises it
        # without writing a duplicate
        j = self.journal()
        cache_path = os.path.join(self.cache_photos, "a.meta.json")
        payload = {"title": "hi", "rev": 1}
        j.stage(cache_path, payload)
        self.io.atomic_write(cache_path, payload)   # cache write landed
        # (no reconcile — simulate crash before verify/mark)
        j2 = self.journal()
        j2.reconcile(force=True)
        self.assertEqual(self.read(cache_path), payload)
        self.assertEqual(len(os.listdir(self.cache_photos)), 1)
        self.assertEqual(j2.counts()["pending"], 0)


class TestRevisionSafety(BackupBase):
    def test_older_pending_never_overwrites_newer_cache(self):
        j = self.journal()
        cache_path = os.path.join(self.cache_photos, "a.meta.json")
        # the cache already holds a newer revision (e.g. a later local edit or
        # another instance wrote it while our edit was pending)
        newer = {"title": "new", "rev": 2}
        self.io.atomic_write(cache_path, newer)
        # a stale pending backup for an OLDER revision of the same record
        stale = {"title": "old", "rev": 1}
        j.stage(cache_path, stale)
        j.reconcile(force=True)
        # the newer cache revision must survive untouched
        self.assertEqual(self.read(cache_path), newer)
        self.assertEqual(j.counts()["pending"], 0)

    def test_divergent_same_revision_preserves_both(self):
        j = self.journal()
        cache_path = os.path.join(self.cache_photos, "a.meta.json")
        cache_side = {"title": "from-cache", "rev": 5}
        self.io.atomic_write(cache_path, cache_side)
        backup_side = {"title": "from-backup", "rev": 5}
        j.stage(cache_path, backup_side)
        j.reconcile(force=True)
        # neither side is silently discarded
        self.assertEqual(self.read(cache_path), cache_side)   # cache untouched
        self.assertEqual(j.counts()["conflict"], 1)
        conflicts = os.listdir(j.conflicts_dir)
        self.assertTrue(any("cache" in c for c in conflicts))
        self.assertTrue(any("backup" in c for c in conflicts))
        # a conflict is not auto-resolved or pruned on subsequent sweeps
        j.reconcile(force=True)
        self.assertEqual(j.counts()["conflict"], 1)

    def test_rapid_edits_keep_monotonic_revisions(self):
        j = self.journal()
        _, p1 = self.commit(j, "a.meta.json", {"title": "one"})
        _, p2 = self.commit(j, "a.meta.json", {"title": "two"})
        _, p3 = self.commit(j, "a.meta.json", {"title": "three"})
        self.assertEqual([p1["rev"], p2["rev"], p3["rev"]], [1, 2, 3])
        # the newest content wins and a replay cannot resurrect an older one
        cache_path = os.path.join(self.cache_photos, "a.meta.json")
        j.reconcile(force=True)
        self.assertEqual(self.read(cache_path)["title"], "three")


class TestIsolationAndQuarantine(BackupBase):
    def test_corrupt_record_is_quarantined_without_blocking_others(self):
        j = self.journal()
        self.io.fail_prefixes = [os.path.join(self.tmp, "cache")]
        self.commit(j, "good.meta.json", {"title": "good"})
        self.commit(j, "bad.meta.json", {"title": "bad"})
        self.assertEqual(j.counts()["pending"], 2)
        # corrupt one backup payload (truncated / invalid JSON)
        with open(self.backup_path("bad.meta.json"), "w", encoding="utf-8") as f:
            f.write("{ this is not valid json")
        # cache recovers; forced sweep
        self.io.fail_prefixes = []
        j.reconcile(force=True)
        # the good record replayed to the cache...
        self.assertTrue(os.path.exists(self.cache_path("good.meta.json")))
        # ...the bad one was set aside, not deleted, not blocking the good one
        self.assertGreaterEqual(j.counts()["quarantined"], 1)
        self.assertFalse(os.path.exists(self.cache_path("bad.meta.json")))

    def test_checksum_mismatch_is_quarantined(self):
        j = self.journal()
        self.io.fail_prefixes = [os.path.join(self.tmp, "cache")]
        self.commit(j, "a.meta.json", {"title": "hi"})
        # tamper with the payload so it no longer matches the journal checksum,
        # but is still valid JSON
        with open(self.backup_path("a.meta.json"), "w", encoding="utf-8") as f:
            json.dump({"title": "tampered", "rev": 1}, f)
        self.io.fail_prefixes = []
        j.reconcile(force=True)
        self.assertGreaterEqual(j.counts()["quarantined"], 1)


class TestPruning(BackupBase):
    def test_verified_recovery_copies_pruned_after_grace(self):
        j = self.journal(retention={"grace_seconds": 100})
        cache_path, payload = self.commit(j, "a.meta.json", {"title": "hi"})
        self.assertTrue(os.path.exists(self.backup_path("a.meta.json")))
        # within grace: kept for recovery
        self.clock.tick(50)
        j.prune()
        self.assertTrue(os.path.exists(self.backup_path("a.meta.json")))
        # past grace: the recovery copy is pruned, cache stays intact
        self.clock.tick(100)
        j.prune()
        self.assertFalse(os.path.exists(self.backup_path("a.meta.json")))
        self.assertEqual(self.read(cache_path), payload)

    def test_count_cap_keeps_cache_and_drops_oldest_backup(self):
        j = self.journal(retention={"grace_seconds": 10_000, "max_records": 2})
        for name in ("a", "b", "c"):
            self.clock.tick(1)
            self.commit(j, f"{name}.meta.json", {"title": name})
        j.prune()
        # cache keeps all three; backup recovery copies bounded to two newest
        self.assertEqual(len(os.listdir(self.cache_photos)), 3)
        self.assertLessEqual(j.counts()["verified"], 2)
        self.assertFalse(os.path.exists(self.backup_path("a.meta.json")))
        self.assertTrue(os.path.exists(self.backup_path("c.meta.json")))

    def test_pending_is_never_pruned(self):
        j = self.journal(retention={"grace_seconds": 0, "max_records": 0})
        self.io.fail_prefixes = [os.path.join(self.tmp, "cache")]
        self.commit(j, "a.meta.json", {"title": "hi"})
        self.clock.tick(10_000)
        j.prune()
        # an unverified change is the only copy — it must survive pruning
        self.assertTrue(os.path.exists(self.backup_path("a.meta.json")))
        self.assertEqual(j.counts()["pending"], 1)

    def test_cleanup_temp_removes_stale_only(self):
        j = self.journal(retention={"temp_age_seconds": 100})
        stale = os.path.join(self.backup, "photos", "x.meta.json.tmp.999.1")
        fresh = os.path.join(self.backup, "photos", "y.meta.json.tmp.999.2")
        for p in (stale, fresh):
            with open(p, "w") as f:
                f.write("partial")
        old = self.clock() - 500
        os.utime(stale, (old, old))
        j.cleanup_temp()
        self.assertFalse(os.path.exists(stale))
        self.assertTrue(os.path.exists(fresh))


class TestContent(BackupBase):
    def test_unicode_preserved(self):
        j = self.journal()
        payload = {"title": "café — 東京 🎞️", "notes": "naïve\nÜber"}
        cache_path, saved = self.commit(j, "a.meta.json", payload)
        self.assertEqual(self.read(cache_path)["title"], "café — 東京 🎞️")
        self.assertEqual(self.read(self.backup_path("a.meta.json"))["notes"],
                         "naïve\nÜber")

    def test_folders_records_are_tracked_too(self):
        j = self.journal()
        cache_path, payload = self.commit(
            j, "roll__abcd1234.json", {"camera": "Nikon"}, sub="folders")
        self.assertEqual(self.read(cache_path), payload)
        self.assertEqual(j.counts()["verified"], 1)


if __name__ == "__main__":
    unittest.main()
