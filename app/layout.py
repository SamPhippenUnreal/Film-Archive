"""Deterministic organic layout for the archive wall.

Positions depend only on folder names and filenames, so the wall looks the
same every launch. Each subfolder becomes a loose cluster of prints; clusters
are placed on a golden-angle spiral so they never overlap.
"""
import hashlib
import math
import random

PHOTO_H = 180          # display height of a print on the wall, in wall units
GAP_X = 46             # nominal horizontal breathing room inside a cluster
GAP_Y = 64             # vertical breathing room (leaves space for jitter)
CLUSTER_PAD = 340      # minimum space between clusters


def _seed(text):
    return int(hashlib.sha1(text.encode("utf-8")).hexdigest()[:12], 16)


def _cluster_layout(folder, photos):
    """Arrange one folder's photos as a loose block with organic jitter.
    Returns (placements, half_w, half_h) with positions relative to the
    cluster centre."""
    n = len(photos)
    cols = max(1, round(math.sqrt(n * 1.55)))
    rows = math.ceil(n / cols)

    # widths at uniform print height
    widths = []
    for p in photos:
        w, h = (p.get("width") or 3, p.get("height") or 2)
        widths.append(PHOTO_H * (w / max(1, h)))

    row_widths = []
    for r in range(rows):
        seg = widths[r * cols:(r + 1) * cols]
        row_widths.append(sum(seg) + GAP_X * max(0, len(seg) - 1))
    block_w = max(row_widths) if row_widths else 0
    block_h = rows * PHOTO_H + GAP_Y * max(0, rows - 1)

    placements = []
    for i, p in enumerate(photos):
        r, c = divmod(i, cols)
        seg = widths[r * cols:(r + 1) * cols]
        row_w = sum(seg) + GAP_X * max(0, len(seg) - 1)
        x = -row_w / 2 + sum(seg[:c]) + GAP_X * c + seg[c] / 2
        y = -block_h / 2 + r * (PHOTO_H + GAP_Y) + PHOTO_H / 2

        rng = random.Random(_seed(folder + "/" + p["filename"]))
        x += rng.uniform(-14, 14)
        y += rng.uniform(-18, 18)
        placements.append({
            "id": p["id"], "x": x, "y": y,
            "w": widths[i], "h": PHOTO_H,
        })
    half_w = block_w / 2 + 30
    half_h = block_h / 2 + 34
    return placements, half_w, half_h


def build_wall(photos, offsets=None):
    """photos: list of dicts from the store. Returns cluster list with
    absolute wall coordinates. offsets: folder -> (dx, dy), the user's own
    repositioning of whole clusters, applied on top of the layout."""
    offsets = offsets or {}
    by_folder = {}
    for p in photos:
        by_folder.setdefault(p["folder"], []).append(p)
    for lst in by_folder.values():
        lst.sort(key=lambda p: p["filename"].lower())

    folders = sorted(by_folder.keys(), key=lambda f: f.lower())
    clusters = []
    placed = []  # (cx, cy, half_w, half_h)

    for idx, folder in enumerate(folders):
        placements, hw, hh = _cluster_layout(folder, by_folder[folder])
        cx, cy = _spot(idx, folder, hw, hh, placed)
        placed.append((cx, cy, hw, hh))
        dx, dy = offsets.get(folder, (0, 0))
        cx += dx
        cy += dy
        for pl in placements:
            pl["x"] = round(pl["x"] + cx, 1)
            pl["y"] = round(pl["y"] + cy, 1)
        label = folder.split("/")[-1] if folder else "loose photographs"
        clusters.append({
            "folder": folder, "label": label,
            "x": cx, "y": cy - hh,  # label anchor above the cluster
            "photos": placements,
        })
    return clusters


def _spot(idx, folder, hw, hh, placed):
    """Deterministic spiral placement that avoids earlier clusters."""
    if not placed:
        return 0.0, 0.0
    rng = random.Random(_seed("spot:" + folder))
    golden = math.radians(137.508)
    angle0 = rng.uniform(0, 2 * math.pi)
    step = 90.0
    k = 1
    while True:
        a = angle0 + k * golden
        r = step * math.sqrt(k) * 3.2
        cx = math.cos(a) * r * 1.35   # wider than tall, like a wall
        cy = math.sin(a) * r
        ok = True
        for px, py, pw, ph in placed:
            if (abs(cx - px) < hw + pw + CLUSTER_PAD
                    and abs(cy - py) < hh + ph + CLUSTER_PAD):
                ok = False
                break
        if ok:
            return cx, cy
        k += 1
        if k > 4000:  # safety net; effectively unreachable
            return cx, cy
