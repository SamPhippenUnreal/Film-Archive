"""Crash-resilient local write-ahead safety layer for per-photo metadata.

Every note, title, date, location, tag, star, camera/film label, rotation,
black-and-white state and drawing the user commits is *irreplaceable* (tier 3
in CONCEPT.md). It normally lives in the shared, often cloud-synced ``cache``
folder beside the photographs. That folder can be momentarily offline, slow to
propagate, temporarily locked, or the sync client can swallow a write — and the
app can crash mid-write. This module makes a committed edit survive all of
that.

The idea is a small **write-ahead journal** kept in a genuinely local folder
named ``backup`` (never in the cloud — it sits with the app's own rebuildable
cache):

    backup/
        photos/   <pid>.meta.json   full metadata, byte-identical to the cache
        photos/   <pid>.anno.json   sidecar — a human could copy these straight
        folders/  <key>.json        back into ``cache`` and recover everything
        journal/  <recid>.json      per-record sync state (rev, checksum, …)
        conflicts/                  divergent versions preserved for attention
        quarantine/                 malformed records set aside, never deleted

The payloads under ``photos``/``folders`` deliberately mirror the cache layout
and format, so the backup stays understandable and recoverable on its own. The
extra bookkeeping (revision, checksum, retry count, timestamps, sync state)
lives in the separate ``journal`` sidecar, so it never makes a backed-up
payload incompatible with the cache.

Persistence flow, per committed edit (see MetaStore._write_json):

  1. serialize the complete record, stamped with a stable id and a monotonic
     revision, and validate it round-trips as JSON;
  2. write it atomically (temp + fsync + replace) to ``backup`` — durable local
     copy *before* the cache is touched;
  3. record it in the journal as ``pending``;
  4. apply the same bytes to the primary ``cache``;
  5. verify the cache write by reading it back and comparing the checksum;
  6. mark the journal entry ``verified`` only once the read-back matches;
  7. keep the verified copy briefly (a recovery grace period, for delayed cloud
     propagation), then prune it — bounded by age, count and size.

A failed cache write never deletes the backup: the entry stays ``pending`` and
is replayed — immediately, on the next launch, and on a light periodic sweep —
with bounded exponential backoff. Replay is idempotent (same bytes, same
checksum), so retrying can never duplicate or corrupt anything. If the backup
and the cache diverge at the *same* revision with different content, neither is
assumed authoritative: both are preserved and the conflict is surfaced.
"""
import hashlib
import json
import logging
import os
import threading
import time

log = logging.getLogger("archive.backup")

# Centralised retention policy (requirement 12): tune these in one place.
DEFAULT_RETENTION = {
    # keep a verified recovery copy this long after the cache confirms it, so a
    # slow cloud provider or a late failure can still be recovered from local.
    # An hour is generous for sync propagation while keeping the working set
    # small (unverified pending records are always kept regardless of this).
    "grace_seconds": 3600,
    # hard caps on the *verified recovery* copies only — pending, conflict and
    # quarantined records are never pruned by these
    "max_records": 500,
    "max_bytes": 64 * 1024 * 1024,
    # retry a failed cache write with bounded exponential backoff
    "backoff_base": 2.0,
    "backoff_start": 1.0,
    "backoff_cap": 3600.0,
    "max_retries": 16,        # after this the entry is kept (not lost), quietly
    # clean up temp files older than this on startup
    "temp_age_seconds": 3600.0,
}

_KINDS = {
    ".meta.json": "meta",
    ".anno.json": "anno",
}


def checksum(payload):
    """A stable content hash of a JSON-able payload, independent of key order
    so the same content always hashes the same on any machine."""
    blob = json.dumps(payload, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _rev_of(data):
    if isinstance(data, dict):
        try:
            return int(data.get("rev") or 0)
        except (TypeError, ValueError):
            return 0
    return 0


class BackupJournal:
    """Owns the local ``backup`` folder and its write-ahead journal.

    It knows nothing about photos specifically — it moves opaque JSON payloads
    between a *backup* copy and a *cache* copy, both addressed by a stable
    relative path like ``photos/<pid>.meta.json``. MetaStore injects the
    atomic-write / read / verify primitives so there is exactly one atomic-write
    implementation in the app.
    """

    def __init__(self, backup_dir, cache_dirs, io, *,
                 retention=None, clock=time.time):
        """cache_dirs: {"photos": <cache photos dir>, "folders": <dir>}.
        io: object exposing atomic_write(path, data), read_json(path).
        """
        self.dir = backup_dir
        self.cache_dirs = dict(cache_dirs)
        self.io = io
        self.clock = clock
        self.cfg = dict(DEFAULT_RETENTION)
        if retention:
            self.cfg.update(retention)
        self._lock = threading.RLock()

        self.journal_dir = os.path.join(backup_dir, "journal")
        self.conflicts_dir = os.path.join(backup_dir, "conflicts")
        self.quarantine_dir = os.path.join(backup_dir, "quarantine")
        self._subs = tuple(cache_dirs.keys())        # ("photos", "folders")
        self.ok = True
        try:
            for sub in self._subs:
                os.makedirs(os.path.join(backup_dir, sub), exist_ok=True)
            os.makedirs(self.journal_dir, exist_ok=True)
            os.makedirs(self.conflicts_dir, exist_ok=True)
            os.makedirs(self.quarantine_dir, exist_ok=True)
        except OSError:
            # a read-only or unavailable backup location must never stop the
            # app: we simply run without the extra safety net
            self.ok = False

    # ---- path helpers -----------------------------------------------------

    @staticmethod
    def kind_of(name):
        for suffix, kind in _KINDS.items():
            if name.endswith(suffix):
                return kind
        return "folder"

    def rel_for(self, cache_path):
        """The stable ``sub/name`` key for a cache sidecar path, or None when
        the path is not a photo/folder sidecar we track."""
        target = os.path.realpath(cache_path)
        matches = []
        for sub, cdir in self.cache_dirs.items():
            root = os.path.realpath(cdir)
            try:
                relative = os.path.relpath(target, root)
            except ValueError:
                continue
            if relative == os.pardir or relative.startswith(os.pardir + os.sep):
                continue
            matches.append((len(root), sub, relative.replace("\\", "/")))
        if matches:
            # A nested cache root must win over a broader project root.
            _, sub, relative = max(matches, key=lambda item: item[0])
            return f"{sub}/{relative}"
        return None

    def _backup_path(self, rel):
        sub, name = rel.split("/", 1)
        return os.path.join(self.dir, sub, name)

    def _cache_path(self, rel):
        sub, name = rel.split("/", 1)
        return os.path.join(self.cache_dirs[sub], name)

    def _journal_path(self, rel):
        # rel already ends in .json, so the record id is a clean, unique name
        return os.path.join(self.journal_dir, rel.replace("/", "__"))

    def id_of(self, rel):
        name = rel.split("/", 1)[1]
        for suffix in _KINDS:
            if name.endswith(suffix):
                return name[: -len(suffix)]
        return name[: -len(".json")] if name.endswith(".json") else name

    # ---- next revision ----------------------------------------------------

    def next_rev(self, cache_path):
        """One past the highest revision seen for this record in either the
        cache or a lingering backup, so a new commit is always newer than
        anything already on disk — even after a crash or a concurrent write."""
        rel = self.rel_for(cache_path)
        paths = [cache_path]
        if rel:
            paths.append(self._backup_path(rel))
        r = 0
        for p in paths:
            r = max(r, _rev_of(self.io.read_json(p)))
        return r + 1

    # ---- write-ahead ------------------------------------------------------

    def stage(self, cache_path, payload):
        """Durably record a committed edit in ``backup`` *before* the cache is
        written. Returns the journal entry (or None when not tracked / backup
        unavailable). Never overwrites a good backup with an invalid one."""
        if not self.ok:
            return None
        rel = self.rel_for(cache_path)
        if rel is None:
            return None
        # validate the serialized form round-trips before it can replace a
        # previous, known-good backup copy
        try:
            blob = json.dumps(payload, ensure_ascii=False)
            json.loads(blob)
        except (TypeError, ValueError):
            log.warning("refusing to stage unserialisable payload for %s", rel)
            return None
        entry = {
            "rel": rel,
            "kind": self.kind_of(rel.split("/", 1)[1]),
            "id": self.id_of(rel),
            "rev": _rev_of(payload),
            "checksum": checksum(payload),
            "ts": self.clock(),
            "state": "pending",
            "retries": 0,
            "next_retry": 0.0,
            "verified_ts": None,
        }
        with self._lock:
            try:
                # payload first, then the journal entry that points at it — so
                # a journal entry never references a missing/half-written payload
                self.io.atomic_write(self._backup_path(rel), payload)
                self.io.atomic_write(self._journal_path(rel), entry)
            except OSError as e:
                log.warning("backup stage failed for %s: %s", rel, e)
                return None
        return entry

    def forget(self, cache_path):
        """Drop any backup payload and journal record for a cache path whose
        cache file has been deleted, so a later reconcile never replays
        (resurrects) it. Safe to call for an untracked or unknown path."""
        if not self.ok:
            return
        rel = self.rel_for(cache_path)
        if rel is None:
            return
        with self._lock:
            self._drop_record(rel)

    # ---- reconciliation ---------------------------------------------------

    def _load_journal(self):
        try:
            names = os.listdir(self.journal_dir)
        except OSError:
            return []
        out = []
        for name in names:
            if not name.endswith(".json") or name.endswith(".tmp"):
                continue
            path = os.path.join(self.journal_dir, name)
            entry = self.io.read_json(path)
            if not isinstance(entry, dict) or "rel" not in entry:
                # a corrupt journal sidecar: set it aside, do not let it block
                self._quarantine_file(path, "journal")
                continue
            out.append(entry)
        return out

    def _save_entry(self, entry):
        self.io.atomic_write(self._journal_path(entry["rel"]), entry)

    def _drop_record(self, rel):
        """Remove a finalised record — journal sidecar and backup payload."""
        for p in (self._journal_path(rel), self._backup_path(rel)):
            try:
                os.remove(p)
            except OSError:
                pass

    def _quarantine_file(self, path, tag):
        try:
            dest = os.path.join(self.quarantine_dir,
                                f"{tag}.{int(self.clock()*1000)}."
                                + os.path.basename(path))
            os.replace(path, dest)
            log.error("quarantined %s -> %s", path, dest)
        except OSError:
            pass

    def _quarantine_record(self, entry):
        rel = entry.get("rel", "")
        log.error("quarantining unreadable backup record %s", rel)
        bp = self._backup_path(rel) if rel else None
        if bp:
            self._quarantine_file(bp, "payload")
        jp = self._journal_path(rel) if rel else None
        if jp:
            self._quarantine_file(jp, "journal")

    def _preserve_conflict(self, entry, cache_data):
        """Both sides changed at the same revision with different content and
        neither is safely authoritative — keep both, flag it, discard nothing."""
        rel = entry["rel"]
        stamp = int(self.clock() * 1000)
        recid = rel.replace("/", "__")
        try:
            self.io.atomic_write(
                os.path.join(self.conflicts_dir, f"{recid}.{stamp}.cache.json"),
                cache_data)
            backup_data = self.io.read_json(self._backup_path(rel))
            self.io.atomic_write(
                os.path.join(self.conflicts_dir,
                             f"{recid}.{stamp}.backup.json"),
                backup_data)
        except OSError:
            pass
        entry["state"] = "conflict"
        self._save_entry(entry)
        log.error("conflict on %s at rev %s (cache rev %s) — both preserved",
                  rel, entry.get("rev"), _rev_of(cache_data))

    def _due(self, entry, now, force=False):
        return force or now >= (entry.get("next_retry") or 0.0)

    def _backoff(self, entry, now):
        n = int(entry.get("retries") or 0) + 1
        entry["retries"] = n
        delay = min(self.cfg["backoff_cap"],
                    self.cfg["backoff_start"] * (self.cfg["backoff_base"] ** n))
        entry["next_retry"] = now + delay

    def reconcile(self, force=False):
        """Bring every journal entry to rest: mark ones the cache already holds
        as verified, replay ones it is missing, preserve genuine conflicts,
        quarantine unreadable ones. Idempotent and safe to call as often as we
        like — after each commit, on launch, and on a light periodic sweep.

        force ignores the retry backoff and attempts every pending record now;
        used on launch and when the cache becomes reachable again, so recovery
        is immediate instead of waiting out a previous edit's backoff timer."""
        if not self.ok:
            return {"pending": 0, "verified": 0, "replayed": 0,
                    "conflicts": 0, "quarantined": 0}
        stats = {"pending": 0, "verified": 0, "replayed": 0,
                 "conflicts": 0, "quarantined": 0}
        with self._lock:
            now = self.clock()
            for entry in self._load_journal():
                rel = entry["rel"]
                state = entry.get("state")
                # verified and conflict records are at rest — leave their
                # lifecycle to prune() and don't pay to re-read their payloads
                if state == "conflict":
                    stats["conflicts"] += 1
                    continue
                if state == "verified":
                    stats["verified"] += 1
                    continue

                payload = self.io.read_json(self._backup_path(rel))
                if payload is None:
                    self._quarantine_record(entry)
                    stats["quarantined"] += 1
                    continue
                if checksum(payload) != entry.get("checksum"):
                    self._quarantine_record(entry)
                    stats["quarantined"] += 1
                    continue

                cache_path = self._cache_path(rel)
                cache_data = self.io.read_json(cache_path)
                cache_rev = _rev_of(cache_data)
                cache_matches = (cache_data is not None
                                 and checksum(cache_data) == entry["checksum"])

                if cache_matches:
                    # the cache already holds exactly this revision (either our
                    # write landed, or a crash happened just before we marked it)
                    entry["state"] = "verified"
                    entry["verified_ts"] = now
                    self._save_entry(entry)
                    stats["verified"] += 1
                    continue

                if cache_data is not None and cache_rev > entry["rev"]:
                    # the cache moved on to a newer revision (a later local edit
                    # or another instance) — it is authoritative, our pending
                    # copy is safely superseded; finalise without clobbering
                    self._drop_record(rel)
                    stats["verified"] += 1
                    continue

                if cache_data is not None and cache_rev == entry["rev"] \
                        and not cache_matches:
                    # same revision, different content: a true divergence
                    self._preserve_conflict(entry, cache_data)
                    stats["conflicts"] += 1
                    continue

                # cache is missing or older than our pending edit — replay it.
                # A record that has failed many times keeps its copy (never
                # lost) but stops burning periodic retries; a forced sweep (on
                # launch, or when the cache is known to be back) still tries it.
                exhausted = int(entry.get("retries") or 0) >= \
                    self.cfg["max_retries"]
                if (exhausted or not self._due(entry, now, force)) and not force:
                    stats["pending"] += 1
                    continue
                try:
                    self.io.atomic_write(cache_path, payload)
                    reread = self.io.read_json(cache_path)
                    applied = (reread is not None
                               and checksum(reread) == entry["checksum"])
                except OSError:
                    applied = False
                if applied:
                    entry["state"] = "verified"
                    entry["verified_ts"] = now
                    entry["next_retry"] = 0.0
                    self._save_entry(entry)
                    stats["replayed"] += 1
                    stats["verified"] += 1
                else:
                    self._backoff(entry, now)
                    self._save_entry(entry)
                    stats["pending"] += 1
                    log.warning("cache write for %s not yet confirmed; "
                                "retry %s scheduled", rel, entry["retries"])
        self.prune()
        return stats

    # ---- pruning ----------------------------------------------------------

    def prune(self):
        """Keep the backup bounded without ever deleting the only valid copy.
        Only *verified recovery* copies are eligible: pending, conflict and
        quarantined records are always kept."""
        if not self.ok:
            return
        with self._lock:
            now = self.clock()
            verified = []
            for entry in self._load_journal():
                if entry.get("state") != "verified":
                    continue
                rel = entry["rel"]
                bp = self._backup_path(rel)
                try:
                    size = os.path.getsize(bp)
                except OSError:
                    size = 0
                verified.append((entry, size))

            grace = self.cfg["grace_seconds"]
            keep = []
            for entry, size in verified:
                age = now - (entry.get("verified_ts") or entry.get("ts") or now)
                if age >= grace:
                    self._drop_record(entry["rel"])   # past its recovery window
                else:
                    keep.append((entry, size))

            # enforce count / size caps on what remains, dropping oldest first
            keep.sort(key=lambda es: es[0].get("verified_ts")
                      or es[0].get("ts") or 0)
            total = sum(s for _, s in keep)
            i = 0
            while (len(keep) - i) > self.cfg["max_records"] or \
                    total > self.cfg["max_bytes"]:
                if i >= len(keep):
                    break
                entry, size = keep[i]
                self._drop_record(entry["rel"])
                total -= size
                i += 1

    # ---- startup housekeeping --------------------------------------------

    def cleanup_temp(self):
        """Remove stray temp files an interrupted atomic write may have left
        behind. Safe: atomic writes replace the real file only on success, so
        any leftover ``*.tmp.*`` is by definition incomplete."""
        if not self.ok:
            return
        now = self.clock()
        age = self.cfg["temp_age_seconds"]
        roots = [os.path.join(self.dir, s) for s in self._subs]
        roots += [self.journal_dir, self.conflicts_dir, self.quarantine_dir]
        for root in roots:
            try:
                names = os.listdir(root)
            except OSError:
                continue
            for name in names:
                if ".tmp." not in name:
                    continue
                p = os.path.join(root, name)
                try:
                    if now - os.path.getmtime(p) >= age:
                        os.remove(p)
                except OSError:
                    pass

    # ---- diagnostics (for tests / logging) -------------------------------

    def counts(self):
        pending = verified = conflict = 0
        for entry in self._load_journal():
            st = entry.get("state")
            if st == "verified":
                verified += 1
            elif st == "conflict":
                conflict += 1
            else:
                pending += 1
        try:
            quarantined = len([n for n in os.listdir(self.quarantine_dir)])
        except OSError:
            quarantined = 0
        return {"pending": pending, "verified": verified,
                "conflict": conflict, "quarantined": quarantined}
