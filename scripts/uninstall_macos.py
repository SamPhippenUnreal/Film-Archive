"""Remove only a verified, clean Mac clone, protecting linked archive folders."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
EXPECTED_REPO = "samphippenunreal/film-archive"


def validate_installation(root):
    root = root.resolve()
    if root in (Path.home().resolve(), Path(root.anchor)):
        raise RuntimeError("Refusing to remove a home or filesystem root.")
    for name in ("app/main.py", "setup.sh", "requirements-macos.txt"):
        if not (root / name).is_file():
            raise RuntimeError("This folder does not look like the Mac Archive installation.")
    if not (root / ".git").is_dir():
        raise RuntimeError("Use this helper only in a standalone Git clone, not a ZIP download or worktree.")
    top = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], cwd=root, text=True).strip()
    if Path(top).resolve() != root:
        raise RuntimeError("The installation is not the root of its own Git clone.")
    remote = subprocess.check_output(["git", "remote", "get-url", "origin"], cwd=root, text=True).strip().lower()
    if remote not in ("https://github.com/" + EXPECTED_REPO, "https://github.com/" + EXPECTED_REPO + ".git",
                      "git@github.com:" + EXPECTED_REPO, "git@github.com:" + EXPECTED_REPO + ".git"):
        raise RuntimeError("The origin is not the expected Film Archive repository.")
    dirty = subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=all"], cwd=root, text=True)
    if dirty.strip():
        raise RuntimeError("This clone contains local source changes or untracked files. "
                           "Back them up before uninstalling; nothing has been removed.")
    for settings in (root / "archive.config.json", root / "data" / "state.json"):
        if not settings.exists():
            continue
        try:
            config = json.loads(settings.read_text(encoding="utf-8"))
            if not isinstance(config, dict):
                raise ValueError("not a settings object")
        except (ValueError, OSError) as error:
            raise RuntimeError("Cannot safely read " + settings.name + "; nothing has been removed.") from error
        for key in ("root", "project_root", "writing_root"):
            value = config.get(key)
            if value:
                if not isinstance(value, str):
                    raise RuntimeError("Invalid linked folder setting; nothing has been removed.")
                linked = Path(value).expanduser()
                if not linked.is_absolute():
                    linked = root / linked
                linked = linked.resolve()
                if linked == root or root in linked.parents or linked in root.parents:
                    raise RuntimeError("A linked photo/document folder overlaps this installation. "
                                       "Move or back up that folder before uninstalling; nothing has been removed.")
    data = root / "data"
    if data.exists():
        for journal in data.rglob("journal/*.json"):
            try:
                record = json.loads(journal.read_text(encoding="utf-8"))
                verified = isinstance(record, dict) and record.get("state") == "verified"
            except (ValueError, OSError):
                verified = False
            if not verified:
                raise RuntimeError("Unresolved annotation backups exist. Open Archive to synchronize, "
                                   "or preserve the entire data folder outside this clone before uninstalling.")
    if sys.platform == "darwin":
        commands = subprocess.check_output(["ps", "-axo", "command="], text=True)
        if any(str(root) in line and ("-m app.main" in line or "update_and_launch.py" in line)
               for line in commands.splitlines()):
            raise RuntimeError("Archive is still running. Quit it before uninstalling.")
    return root


def main():
    if sys.platform != "darwin":
        print("This uninstaller is for macOS only.", file=sys.stderr)
        return 1
    try:
        root = validate_installation(ROOT)
        print("Quit Archive first and remove its Dock shortcut.")
        print("This permanently removes this clone, its Python environment and local caches/settings:")
        print(root)
        print("Local custom tag arrangements are removed. External photographs and their sidecars stay in place.")
        print("Any ignored personal files stored inside this clone would also be removed; back those up first.")
        if input("Type UNINSTALL to confirm: ").strip() != "UNINSTALL":
            print("Cancelled. Nothing removed.")
            return 0
        # Revalidate after the confirmation so a newly changed folder is never
        # removed using a stale safety check. rmtree does not follow child symlinks.
        root = validate_installation(root)
        os.chdir(root.parent)
        shutil.rmtree(root)
        print("Archive has been uninstalled. Your external photo archive was not removed.")
        return 0
    except (RuntimeError, OSError, ValueError, EOFError, subprocess.CalledProcessError) as error:
        print("Archive uninstall: " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
