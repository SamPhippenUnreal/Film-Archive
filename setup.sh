#!/bin/sh
# Film Archive one-time setup for macOS and Linux.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

PYTHON=${PYTHON:-python3}
if ! command -v "$PYTHON" >/dev/null 2>&1; then
    echo "film archive: Python 3 is required."
    echo "Install Python 3, then run ./setup.sh again."
    exit 1
fi

echo
echo "  film archive - setup"
echo

if [ ! -x ".venv/bin/python" ]; then
    echo "  creating local environment..."
    "$PYTHON" -m venv .venv
fi

echo "  installing dependencies..."
".venv/bin/python" -m pip install -r requirements.txt

echo
echo "  done. Open launch.command, or run: ./launch.sh"
echo
