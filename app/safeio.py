"""Shared, scope-aware filesystem primitives used by Archive's stores.

All durable writes use a sibling temporary file, flush it, fsync when the
platform permits, and replace the destination atomically.  Keeping these
operations here prevents the photo, Writing, and Project stores from drifting
into subtly different durability and path-safety behaviour.
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
from typing import Any


def canonical(path: str) -> str:
    return os.path.normcase(os.path.realpath(os.path.abspath(path)))


def is_within(root: str, path: str, *, allow_root: bool = True) -> bool:
    """Return whether *path* resolves inside *root* without crossing volumes."""
    try:
        root_n = canonical(root)
        path_n = canonical(path)
        inside = os.path.commonpath((root_n, path_n)) == root_n
        return inside and (allow_root or path_n != root_n)
    except (OSError, ValueError):
        return False


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def read_json(path: str, *, dictionaries_only: bool = True) -> Any:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, ValueError, TypeError):
        return None
    return value if not dictionaries_only or isinstance(value, dict) else None


def _temporary_path(path: str) -> str:
    return f"{path}.tmp.{os.getpid()}.{threading.get_ident()}"


def atomic_write_bytes(path: str, payload: bytes) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    temporary = _temporary_path(path)
    try:
        with open(temporary, "wb") as handle:
            handle.write(payload)
            handle.flush()
            try:
                os.fsync(handle.fileno())
            except OSError:
                pass
        os.replace(temporary, path)
    finally:
        try:
            if os.path.exists(temporary):
                os.remove(temporary)
        except OSError:
            pass


def atomic_write_json(path: str, value: Any) -> None:
    payload = json.dumps(value, ensure_ascii=False).encode("utf-8")
    atomic_write_bytes(path, payload)
