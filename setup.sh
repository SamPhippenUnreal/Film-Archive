#!/bin/sh
# Mac setup is isolated from the frozen Windows branch.
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"
if [ "$(uname -s)" = "Darwin" ]; then
    if [ -z "${PYTHON:-}" ]; then
        if command -v python3.13 >/dev/null 2>&1; then
            PYTHON=python3.13
        else
            PYTHON=python3
        fi
    fi
    if ! command -v "$PYTHON" >/dev/null 2>&1; then
        echo "Archive: install Python 3.13 from python.org, then run ./setup.sh."
        exit 1
    fi
    exec "$PYTHON" scripts/macos_setup.py
fi
# Keep the ordinary non-Mac setup usable on this branch too.
PYTHON=${PYTHON:-python3}
if ! command -v "$PYTHON" >/dev/null 2>&1; then
    echo "Archive: Python 3 is required."
    exit 1
fi
if [ ! -x ".venv/bin/python" ]; then
    "$PYTHON" -m venv .venv
fi
".venv/bin/python" -m pip install -r requirements.txt
chmod +x launch.sh launch.command setup.sh
chmod +x "Archive.app/Contents/MacOS/Archive"
echo "Archive is ready. Run ./launch.sh."
