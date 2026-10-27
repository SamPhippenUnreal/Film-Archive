"""Install the Mac runtime without changing application source or photo files."""
import json
import platform
from pathlib import Path
import subprocess
import sys
import venv

ROOT = Path(__file__).resolve().parents[1]


def validate_python():
    if sys.platform != "darwin":
        raise RuntimeError("This helper is for macOS; use setup.cmd on Windows.")
    if sys.version_info[:2] != (3, 13):
        raise RuntimeError("Install Python 3.13 from python.org, then rerun ./setup.sh. "
                           "It matches the tested Windows Python version.")
    check = subprocess.run(["/usr/sbin/sysctl", "-n", "hw.optional.arm64"],
                           capture_output=True, text=True, check=False)
    if check.stdout.strip() == "1" and platform.machine() != "arm64":
        raise RuntimeError("Use a native Apple Silicon Python 3.13 installation, "
                           "and run Terminal without Rosetta before setup.")


def main():
    try:
        validate_python()
        environment = ROOT / ".venv"
        python = environment / "bin" / "python"
        if environment.exists() and not python.is_file():
            raise RuntimeError("The existing .venv is not a Mac environment. "
                               "Rename it before setup; do not copy a Windows .venv onto the Mac.")
        if not environment.exists():
            venv.EnvBuilder(with_pip=True).create(environment)
        info = json.loads(subprocess.check_output([str(python), "-c",
            "import json,sys,platform; print(json.dumps([list(sys.version_info[:2]),sys.platform,platform.machine()]))"],
            text=True))
        if info != [[3, 13], "darwin", platform.machine()]:
            raise RuntimeError("The existing .venv uses a different Python version or architecture. "
                               "Rename it, then rerun setup to create the matching Mac environment.")
        subprocess.run([str(python), "-m", "pip", "install", "--disable-pip-version-check",
                        "-r", str(ROOT / "requirements-macos.txt")], check=True, cwd=ROOT)
        subprocess.run([str(python), "-c",
            "import flask, webview; from PIL import Image; import AppKit, Foundation, WebKit, Quartz, Security"],
            check=True, cwd=ROOT)
        for name in ("setup.sh", "launch.sh", "launch.command", "Archive.app/Contents/MacOS/Archive"):
            path = ROOT / name
            path.chmod(path.stat().st_mode | 0o111)
        print("Archive is ready. Run ./launch.command or open Archive.app.")
        print("Keep Archive.app inside this checkout; you can drag its icon onto the Dock.")
        return 0
    except (RuntimeError, OSError, ValueError, subprocess.CalledProcessError) as error:
        print("Archive setup: " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
