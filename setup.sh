#!/bin/sh
# Archive one-time setup for macOS and Linux.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

PYTHON=${PYTHON:-python3}
if ! command -v "$PYTHON" >/dev/null 2>&1; then
    echo "archive: Python 3 is required."
    echo "Install Python 3, then run ./setup.sh again."
    exit 1
fi

echo
echo "  archive - setup"
echo

if [ ! -x ".venv/bin/python" ]; then
    echo "  creating local environment..."
    "$PYTHON" -m venv .venv
fi

echo "  installing dependencies..."
".venv/bin/python" -m pip install -r requirements.txt

# Restore executable bits on the launchers. Git preserves these on clone, but
# a ZIP download from GitHub strips them, which would make the Dock app and
# the shell launchers silently do nothing.
chmod +x launch.sh launch.command setup.sh 2>/dev/null || true
chmod +x "Archive.app/Contents/MacOS/Archive" 2>/dev/null || true

# Let the Dock app open without a Gatekeeper prompt (no-op if not needed).
xattr -dr com.apple.quarantine "Archive.app" 2>/dev/null || true

echo
echo "  done."
echo "    - double-click  launch.command   (or run ./launch.sh)"
echo "    - or drag  'Archive.app'  onto your Dock and click it"
echo
