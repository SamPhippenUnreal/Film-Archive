"""Deterministic aligned layout for the archive wall.

Positions depend only on folder names and filenames, so the wall looks the
same every launch. Each subfolder becomes an aligned cluster of prints; clusters
are placed on a golden-angle spiral so they never overlap.
"""
import hashlib
import math
import random

PHOTO_W = 270          # equal print frames; originals are fitted without distortion
PHOTO_H = 180          # display height of a print on the wall, in wall units
GAP_X = 46             # nominal horizontal breathing room inside a cluster
GAP_Y = 64             # vertical breathing room
CLUSTER_PAD = 340      # minimum space between clusters


def _seed(text):
    return int(hashlib.sha1(text.encode("utf-8")).hexdigest()[:12], 16)


def _cluster_layout(folder, photos):
    """Equal print frames, mostly four rows, with compact large collections."""
    n = len(photos)
    if not n:
        return [], 0, 0
    variant = _seed(folder) % 10
    preferred = 3 if variant == 0 else 5 if variant == 1 else 4
    # Four rows for ordinary rolls; add rows when a large roll would become
    # more than roughly three times as wide as tall. Never strand a tiny final row.
    compact = math.ceil(math.sqrt(n * (PHOTO_W + GAP_X) /
                                  (3.5 * (PHOTO_H + GAP_Y))))
    rows = min(max(preferred, compact), max(1, n // 3))
    if n >= 4:
        rows = max(2, rows)
    # Keep rows on one shared left edge. When only the first row would have
    # an extra print, make the first TWO rows equally long and shorten the
    # bottom row instead. This avoids isolated right-edge overhangs without
    # offsetting rows or introducing holes in the grid.
    def row_counts(row_count):
        base, extra = divmod(n, row_count)
        counts = [base + (r < extra) for r in range(row_count)]
        if extra == 1 and row_count >= 3 and base >= 3:
            counts[1] += 1
            counts[-1] -= 1
        return counts

    if rows == 2 and n >= 9 and n % 2:
        rows = 3
    counts = row_counts(rows)
    # Small rolls should remain horizontal rather than becoming tall blocks.
    while rows > 2:
        width = max(counts) * PHOTO_W + (max(counts) - 1) * GAP_X
        height = rows * PHOTO_H + (rows - 1) * GAP_Y
        if width >= height * 1.15:
            break
        rows -= 1
        counts = row_counts(rows)
    block_w = max(counts) * PHOTO_W + (max(counts) - 1) * GAP_X
    block_h = rows * PHOTO_H + (rows - 1) * GAP_Y
    placements = []
    index = 0
    for row, count in enumerate(counts):
        for col in range(count):
            placements.append({"id": photos[index]["id"],
                               "x": -block_w / 2 + col * (PHOTO_W + GAP_X) + PHOTO_W / 2,
                               "y": -block_h / 2 + row * (PHOTO_H + GAP_Y) + PHOTO_H / 2,
                               "w": PHOTO_W, "h": PHOTO_H})
            index += 1
    return placements, block_w / 2 + 30, block_h / 2 + 34


def build_group(photos, label="chronological", folder="__chronological__"):
    """One group preserving caller order, with the ordinary wall geometry."""
    if not photos:
        return []
    placements, _, hh = _cluster_layout(folder, photos)
    return [{"folder": folder, "label": label, "x": 0, "y": -hh, "photos": placements}]


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
