#!/bin/sh
# Update safely from GitHub, then launch Archive on macOS/Linux.
set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

if [ ! -x ".venv/bin/python" ]; then
    echo "archive: the environment is missing."
    echo "Run ./setup.sh first."
    exit 1
fi

exec ".venv/bin/python" update_and_launch.py "$@"
