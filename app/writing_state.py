"""Authoritative sidecar model shared by Writing and Project documents."""
from __future__ import annotations

import os
from typing import Any

from .safeio import read_json, sha256_bytes


def editor_fields(state: Any) -> dict:
    state = state if isinstance(state, dict) else {}
    return {
        "content": state.get("content") or "",
        "groups": state.get("groups") if isinstance(state.get("groups"), dict) else {},
        "annotations": (state.get("annotations")
                        if isinstance(state.get("annotations"), dict) else {}),
        "rating": max(0, min(5, int(state.get("rating") or 0))),
        "tags": str(state.get("tags") or ""),
    }


def make_sidecar(data: bytes, source_format: str, state: Any,
                 source_stat=None) -> dict:
    sidecar = {
        "version": 2,
        "source_checksum": sha256_bytes(data),
        "source_format": str(source_format or "").lower().lstrip("."),
        **editor_fields(state),
    }
    if source_stat is not None:
        sidecar["source_stat"] = list(source_stat)
    return sidecar


def read_matching_sidecar(path: str, data: bytes) -> dict | None:
    state = read_json(path)
    if not isinstance(state, dict):
        return None
    checksum = state.get("source_checksum", state.get("docx_checksum"))
    return state if checksum == sha256_bytes(data) else None


def stat_signature(path: str) -> list[int] | None:
    try:
        stat = os.stat(path)
    except OSError:
        return None
    return [stat.st_mtime_ns, stat.st_size]
