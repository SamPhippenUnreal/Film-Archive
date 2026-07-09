#!/bin/sh
# Finder-friendly macOS launcher. Delegates to the shared Unix launcher.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$SCRIPT_DIR/launch.sh" "$@"
