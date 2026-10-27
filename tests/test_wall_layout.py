import tempfile
import unittest
from pathlib import Path

from app.layout import _cluster_layout, GAP_X, GAP_Y, PHOTO_W, PHOTO_H
from app.store import Store


class WallLayoutTests(unittest.TestCase):
    def test_equal_frames_aligned_rows_preserve_spacing(self):
        for count in range(1, 151):
            photos = [{"id": str(i), "width": [2, 3, 1][i % 3],
                       "height": [3, 2, 1][i % 3]} for i in range(count)]
            placements, _, _ = _cluster_layout("roll", photos)
            rows = {}
            for photo, placed in zip(photos, placements):
                rows.setdefault(placed["y"], []).append(placed)
                self.assertEqual((placed["w"], placed["h"]), (PHOTO_W, PHOTO_H))
            ordered = list(rows.values())
            self.assertGreaterEqual(len(ordered[-1]), min(2, count))
            left = ordered[0][0]["x"] - ordered[0][0]["w"] / 2
            for row in ordered:
                offset = (row[0]["x"] - row[0]["w"] / 2 - left) / (PHOTO_W + GAP_X)
                self.assertEqual(offset, 0, "all rows share the same left edge")
                for a, b in zip(row, row[1:]):
                    self.assertAlmostEqual(b["x"] - b["w"] / 2 - a["x"] - a["w"] / 2, GAP_X)
            for a, b in zip(ordered, ordered[1:]):
                self.assertAlmostEqual(b[0]["y"] - b[0]["h"] / 2 - a[0]["y"] - a[0]["h"] / 2, GAP_Y)

    def test_every_occupied_row_and_column_has_at_least_two_photos(self):
        for count in range(4, 401):
            if count in (5, 7):  # Impossible with contiguous, left-aligned rows.
                continue
            for folder in ("roll", "variation", "other"):
                photos = [{"id": str(i)} for i in range(count)]
                placements, _, _ = _cluster_layout(folder, photos)
                rows, columns = {}, {}
                for p in placements:
                    rows[p["y"]] = rows.get(p["y"], 0) + 1
                    columns[p["x"]] = columns.get(p["x"], 0) + 1
                self.assertGreaterEqual(min(rows.values()), 2, (count, folder, rows))
                self.assertGreaterEqual(min(columns.values()), 2, (count, folder, columns))
                self.assertEqual({p["id"] for p in placements}, {p["id"] for p in photos})
                self.assertEqual(len(placements), count)

    def test_small_impossible_counts_keep_every_photo_visible(self):
        for count in (1, 2, 3, 5):
            photos = [{"id": str(i)} for i in range(count)]
            placements, _, _ = _cluster_layout("small", photos)
            self.assertEqual([p["id"] for p in placements], [p["id"] for p in photos])

    def test_shape_varies_stably_between_three_four_and_five_rows(self):
        shapes = set()
        for count in (18, 25, 36):
            photos = [{"id": str(i)} for i in range(count)]
            for i in range(30):
                wall = _cluster_layout(str(i), photos)
                self.assertEqual(wall, _cluster_layout(str(i), photos))
                shapes.add(len({p["y"] for p in wall[0]}))
        self.assertEqual(shapes, {3, 4, 5})

    def test_short_rows_taper_at_bottom_without_sideways_steps(self):
        for count in range(4, 401):
            placements, _, _ = _cluster_layout("roll", [{"id": str(i)} for i in range(count)])
            rows = {}
            for p in placements:
                rows.setdefault(p["y"], []).append(p)
            ordered = list(rows.values())
            counts = [len(row) for row in ordered]
            self.assertEqual(counts, sorted(counts, reverse=True))
            self.assertEqual(len({row[0]["x"] for row in ordered}), 1)
            self.assertLessEqual(max(counts) - min(counts), 2)

    def test_four_rows_are_the_default_and_large_collections_stay_compact(self):
        photos = [{"id": str(i)} for i in range(36)]
        shapes = [len({p["y"] for p in _cluster_layout(str(i), photos)[0]}) for i in range(100)]
        self.assertGreater(shapes.count(4), 70)
        photos = [{"id": str(i)} for i in range(200)]
        _, hw, hh = _cluster_layout("large", photos)
        self.assertLess(hw / hh, 3.6)


class TagOrderStorageTests(unittest.TestCase):
    def test_order_survives_reopening_and_preserves_filtered_out_positions(self):
        with tempfile.TemporaryDirectory() as folder:
            db = str(Path(folder) / "archive.db")
            store = Store(db, None)
            store.save_tag_order([" Sun ", "Beach"], ["a", "b", "c", "d"])
            store.save_tag_order(["beach", "sun"], ["d", "b"])
            store._conn.close()
            restored = Store(db, None)
            try:
                self.assertEqual(restored.tag_order(["SUN", "beach"]), ["a", "d", "c", "b"])
                self.assertEqual(restored.tag_order(["other"]), [])
            finally:
                restored._conn.close()


if __name__ == "__main__":
    unittest.main()
