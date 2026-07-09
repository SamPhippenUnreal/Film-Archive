#!/usr/bin/env python3
"""Film Archive — update-then-launch.

A small, conservative launcher. Before starting the app it tries to bring the
*application code* up to date from the trusted GitHub repository using a
strictly safe, fast-forward-only Git update. It then starts the app with the
project's virtual environment.

Design goals: simple, boring, reliable. Safety over cleverness.

  * standard library only — imports nothing from the app or its dependencies
  * never runs a destructive Git command (no reset/clean/stash/rebase/force)
  * never overwrites local edits; a dirty or diverged checkout is left alone
  * never touches the linked photo archive or its `cache/` metadata folder
  * always launches the currently installed version, even when updating fails
  * writes a readable log to data/update.log (data/ is git-ignored)

The app itself is unchanged and is still started as:  python -m app.main
All command-line arguments are forwarded to it untouched.
"""
import logging
import os
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

# ── configuration ────────────────────────────────────────────────────────
PROJECT_ROOT = Path(__file__).resolve().parent
LOG_DIR = PROJECT_ROOT / "data"
LOG_FILE = LOG_DIR / "update.log"
LOG_MAX_BYTES = 1_000_000

# the app code may only ever update from this repository (owner/name)
EXPECTED_SLUG = "samphippenunreal/film-archive"

# reasonable caps so a launch never hangs indefinitely
T_QUICK = 15      # local git queries
T_FETCH = 30      # network fetch
T_MERGE = 20      # fast-forward
T_PIP = 600       # dependency install

DEBUG = os.environ.get("FILM_ARCHIVE_DEBUG", "").lower() in ("1", "true", "yes")
SKIP_UPDATE = os.environ.get("FILM_ARCHIVE_NO_UPDATE", "").lower() in (
    "1", "true", "yes")

log = logging.getLogger("film-archive-update")


# ── logging ──────────────────────────────────────────────────────────────
def setup_logging():
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    try:
        if LOG_FILE.exists() and LOG_FILE.stat().st_size > LOG_MAX_BYTES:
            LOG_FILE.unlink()
    except OSError:
        pass
    log.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s  %(message)s", "%Y-%m-%d %H:%M:%S")
    try:
        fh = logging.FileHandler(LOG_FILE, encoding="utf-8")
        fh.setFormatter(fmt)
        log.addHandler(fh)
    except OSError:
        pass
    # also to the console, useful for launch.bat / the debug launcher
    sh = logging.StreamHandler(sys.stderr)
    sh.setFormatter(fmt)
    log.addHandler(sh)


# ── git helpers ──────────────────────────────────────────────────────────
def git(args, timeout=T_QUICK):
    """Run a git command in the project root. Returns (rc, out, err).
    rc is 127 if git is missing or the call times out."""
    try:
        p = subprocess.run(
            ["git", *args], cwd=str(PROJECT_ROOT),
            capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout.strip(), p.stderr.strip()
    except FileNotFoundError:
        return 127, "", "git not found"
    except subprocess.TimeoutExpired:
        return 127, "", "timed out"


def remote_slug():
    """owner/name for origin, lowercased — or None. The raw URL (which could
    in principle carry a token) is never returned or logged."""
    rc, url, _ = git(["remote", "get-url", "origin"])
    if rc != 0 or not url:
        return None
    s = url.strip().lower()
    for cut in ("git@github.com:", "ssh://git@github.com/",
                "https://github.com/", "http://github.com/"):
        if s.startswith(cut):
            s = s[len(cut):]
            break
    else:
        # some other host / form — take the tail after the last ':' or '/'
        s = s.split("github.com")[-1].lstrip(":/")
    if s.endswith(".git"):
        s = s[:-4]
    return s.strip("/") or None


# ── update ───────────────────────────────────────────────────────────────
def try_update():
    """Fast-forward the checkout to origin if — and only if — that is
    completely safe. Any doubt: leave the checkout exactly as it is."""
    if SKIP_UPDATE:
        log.info("update skipped (FILM_ARCHIVE_NO_UPDATE set)")
        return

    rc, ver, _ = git(["--version"])
    if rc != 0:
        log.info("skip update: Git is not installed — launching current version")
        return
    log.info("using %s", ver)

    rc, top, _ = git(["rev-parse", "--is-inside-work-tree"])
    if rc != 0 or top != "true":
        log.info("skip update: not a Git working tree — launching current version")
        return

    slug = remote_slug()
    if slug is None:
        log.info("skip update: no 'origin' remote — launching current version")
        return
    if slug != EXPECTED_SLUG:
        log.info("skip update: origin is '%s', not the expected repository — "
                 "launching current version", slug)
        return
    log.info("origin: %s", slug)

    rc, branch, _ = git(["rev-parse", "--abbrev-ref", "HEAD"])
    if rc != 0 or branch in ("", "HEAD"):
        log.info("skip update: detached HEAD or unknown branch — "
                 "launching current version")
        return
    rc, upstream, _ = git(["rev-parse", "--abbrev-ref",
                           "--symbolic-full-name", "@{u}"])
    if rc != 0 or not upstream:
        log.info("skip update: branch '%s' has no upstream — "
                 "launching current version", branch)
        return
    log.info("branch: %s  ->  %s", branch, upstream)

    rc, dirty, _ = git(["status", "--porcelain"])
    if rc != 0:
        log.info("skip update: could not read status — launching current version")
        return
    if dirty:
        n = len(dirty.splitlines())
        log.info("skip update: %d local change(s) present — leaving them "
                 "untouched and launching current version", n)
        return

    rc, _, err = git(["fetch", "--quiet", "origin"], timeout=T_FETCH)
    if rc != 0:
        log.info("skip update: fetch failed (offline / Git / auth?) — "
                 "launching current version")
        if err:
            log.info("  fetch: %s", err.splitlines()[0][:200])
        return

    rc1, behind, _ = git(["rev-list", "--count", "HEAD..@{u}"])
    rc2, ahead, _ = git(["rev-list", "--count", "@{u}..HEAD"])
    if rc1 != 0 or rc2 != 0 or not behind.isdigit() or not ahead.isdigit():
        log.info("skip update: could not compare with origin — "
                 "launching current version")
        return
    behind, ahead = int(behind), int(ahead)

    if behind == 0 and ahead == 0:
        log.info("already up to date")
        return
    if ahead > 0 and behind > 0:
        log.info("skip update: history has diverged (%d ahead, %d behind) — "
                 "launching current version", ahead, behind)
        return
    if ahead > 0:
        log.info("skip update: %d local commit(s) ahead of origin — "
                 "launching current version", ahead)
        return

    # behind only → a clean fast-forward is possible
    log.info("update available: %d new commit(s)", behind)
    if not deps_ok_for_update(upstream):
        log.info("skip update: dependency install failed — "
                 "launching current version")
        return

    rc, cur, _ = git(["rev-parse", "--short", "HEAD"])
    rc, out, err = git(["merge", "--ff-only", "@{u}"], timeout=T_MERGE)
    if rc != 0:
        log.info("skip update: fast-forward was refused — leaving the "
                 "checkout untouched and launching current version")
        if err:
            log.info("  merge: %s", err.splitlines()[0][:200])
        return
    rc, new, _ = git(["rev-parse", "--short", "HEAD"])
    log.info("updated: %s -> %s (fast-forward)", cur, new)


def deps_ok_for_update(upstream):
    """If the incoming requirements.txt differs, install it *before* the code
    that needs it. Returns True to proceed with the code update, False to
    hold back. If nothing changed, installs nothing (launches stay fast)."""
    rc, remote_req, _ = git(["show", f"{upstream}:requirements.txt"])
    if rc != 0:
        return True   # no requirements.txt upstream, or unreadable: nothing to do
    try:
        local_req = (PROJECT_ROOT / "requirements.txt").read_text(
            encoding="utf-8")
    except OSError:
        local_req = ""
    if remote_req.strip() == local_req.strip():
        return True   # unchanged — do not run pip on launch

    py = venv_python(for_pip=True)
    if py is None:
        log.info("  dependencies changed but the environment is missing — "
                 "holding the update")
        return False
    log.info("  dependencies changed — installing the new requirements first")
    tmp = None
    try:
        fd, tmp = tempfile.mkstemp(prefix="fa-req-", suffix=".txt")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(remote_req)
        p = subprocess.run(
            [str(py), "-m", "pip", "install", "-r", tmp],
            cwd=str(PROJECT_ROOT), capture_output=True, text=True,
            timeout=T_PIP)
        if p.returncode != 0:
            tail = (p.stderr or p.stdout or "").strip().splitlines()[-3:]
            for line in tail:
                log.info("  pip: %s", line[:200])
            return False
        log.info("  dependencies installed")
        return True
    except subprocess.TimeoutExpired:
        log.info("  dependency install timed out")
        return False
    except OSError as e:
        log.info("  dependency install error: %s", e)
        return False
    finally:
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass


# ── launch ───────────────────────────────────────────────────────────────
def venv_python(for_pip=False):
    """Path to the project venv interpreter, or None if missing.
    Normal Windows launch uses the quiet pythonw.exe; pip and the debug
    launch use the console python.exe."""
    if os.name == "nt":
        scripts = PROJECT_ROOT / ".venv" / "Scripts"
        if for_pip or DEBUG:
            exe = scripts / "python.exe"
        else:
            exe = scripts / "pythonw.exe"
        if not exe.exists():                     # fall back within the venv
            exe = scripts / "python.exe"
        return exe if exe.exists() else None
    exe = PROJECT_ROOT / ".venv" / "bin" / "python"
    return exe if exe.exists() else None


def setup_hint():
    if os.name == "nt":
        return "The environment is missing. Run  setup.cmd  in this folder first."
    return ("The environment is missing. Run  ./setup.sh  in this folder first\n"
            "(or:  python3 -m venv .venv && ./.venv/bin/python -m pip install "
            "-r requirements.txt ).")


def mac_arch_prefix():
    """On Apple Silicon, pin the launch to arm64.

    A universal Python opened from the Dock/Finder can end up running under
    Rosetta (x86_64); native extensions installed as arm64 (Pillow, pyobjc)
    then fail with "incompatible architecture". Terminal launches happen to
    run arm64, which is why they work. Detect Apple-Silicon hardware (reliable
    even under Rosetta) and force arm64 so every launch path matches."""
    if sys.platform != "darwin":
        return []
    try:
        out = subprocess.run(["/usr/sbin/sysctl", "-n", "hw.optional.arm64"],
                             capture_output=True, text=True, timeout=5)
        if out.stdout.strip() != "1":
            return []                       # Intel Mac — nothing to pin
    except Exception:
        return []
    if os.path.exists("/usr/bin/arch"):
        return ["/usr/bin/arch", "-arm64"]
    return []


def launch(app_args):
    py = venv_python()
    if py is None:
        msg = setup_hint()
        log.info("cannot launch: %s", msg.replace("\n", " "))
        print("\nfilm archive:\n" + msg + "\n", file=sys.stderr)
        return 1

    prefix = mac_arch_prefix()
    cmd = [*prefix, str(py), "-m", "app.main", *app_args]
    if prefix:
        log.info("macOS: pinning launch to arm64")
    log.info("launching: python -m app.main %s", " ".join(app_args))

    if os.name == "nt" and not DEBUG:
        # quiet, windowed launch: start the app detached and return
        flags = 0
        for name in ("DETACHED_PROCESS", "CREATE_NEW_PROCESS_GROUP"):
            flags |= getattr(subprocess, name, 0)
        subprocess.Popen(cmd, cwd=str(PROJECT_ROOT), close_fds=True,
                         creationflags=flags)
        return 0

    # debug (Windows console) or macOS/Linux: run in the foreground
    try:
        return subprocess.run(cmd, cwd=str(PROJECT_ROOT)).returncode
    except KeyboardInterrupt:
        return 0


# ── main ─────────────────────────────────────────────────────────────────
def main():
    os.chdir(str(PROJECT_ROOT))
    setup_logging()
    log.info("──────── film archive launch  %s ────────",
             datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    try:
        try_update()
    except Exception as e:                       # never let updating block launch
        log.info("update skipped: unexpected error (%s) — launching current "
                 "version", e.__class__.__name__)
    return launch(sys.argv[1:])


if __name__ == "__main__":
    sys.exit(main())
