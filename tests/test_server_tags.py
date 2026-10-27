"""Tests for reliable tag discovery, indexing, search and filtering at the
HTTP layer (app/server.py). A lightweight fake store stands in for a real
archive so the tag/filter logic can be exercised without a photo folder.
"""
import unittest

from app.server import create_app


class FakeStore:
    """Just enough of Store for the wall / tags endpoints."""

    def __init__(self, photos, flags, text=None):
        self._photos = photos
        self._flags = flags
        self._text = text or {}

    def all_photos(self, include_missing=False):
        return [dict(p) for p in self._photos]

    def meta_flags(self):
        return {k: dict(v) for k, v in self._flags.items()}

    def all_folder_meta(self):
        return {}

    def folder_offsets(self):
        return {}

    def remove_tag(self, name):
        changed = 0
        for flags in self._flags.values():
            tags = flags.get("tags", [])
            kept = [t for t in tags if t.strip().lower() != name.lower()]
            if kept != tags:
                flags["tags"] = kept
                changed += 1
        return changed

    def tag_order(self, tags):
        return getattr(self, "_tag_orders", {}).get(tuple(sorted(set(tags))), [])

    def save_tag_order(self, tags, ids):
        if not hasattr(self, "_tag_orders"):
            self._tag_orders = {}
        self._tag_orders[tuple(sorted(set(tags)))] = ids

    def search_text(self):
        return dict(self._text)

    def get_photo(self, pid):
        for p in self._photos:
            if p["id"] == pid:
                return dict(p)
        return None


class FakeArchive:
    def __init__(self, store):
        self.store = store
        self.scanner = None
        self.root = "/fake"

    def status(self):
        return {"linked": True}


def photo(pid, folder="roll", fname=None):
    return {"id": pid, "folder": folder, "filename": fname or (pid + ".jpg"),
            "width": 3, "height": 2, "exif_date": ""}


class TagBase(unittest.TestCase):
    def client(self, photos, flags, text=None):
        store = FakeStore(photos, flags, text)
        app = create_app(FakeArchive(store))
        app.testing = True
        return app.test_client()


class TestSharedAssets(TagBase):
    def test_creative_project_icon_is_served_from_the_shared_svg(self):
        response = self.client([], {}).get(
            "/assets/creative-project-file.svg")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "image/svg+xml")
        svg = response.get_data(as_text=True)
        self.assertIn('viewBox="0 0 64 64"', svg)
        self.assertIn('stroke="#666862"', svg)
        self.assertIn('stroke-width="2.6"', svg)

    def test_pointer_icon_is_served_from_the_shared_svg(self):
        response = self.client([], {}).get("/assets/pointer-head.svg")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "image/svg+xml")
        svg = response.get_data(as_text=True)
        self.assertIn('viewBox="0 0 64 64"', svg)
        self.assertIn('fill="#B8B9B5"', svg)


class TestTagDiscovery(TagBase):
    def test_all_tag_instances_are_discovered(self):
        c = self.client(
            [photo("a"), photo("b"), photo("c")],
            {"a": {"tags": ["beach"]},
             "b": {"tags": ["sunset", "beach"]},
             "c": {"tags": ["forest"]}})
        tags = c.get("/api/tags").get_json()
        self.assertEqual(set(tags), {"beach", "sunset", "forest"})

    def test_tags_deduped_case_insensitively(self):
        c = self.client(
            [photo("a"), photo("b")],
            {"a": {"tags": ["Beach"]}, "b": {"tags": ["beach", "BEACH"]}})
        tags = c.get("/api/tags").get_json()
        # the same tag in different casings is offered exactly once
        self.assertEqual(len(tags), 1)
        self.assertEqual(tags[0].lower(), "beach")

    def test_newly_added_tag_appears_immediately(self):
        store = FakeStore([photo("a")], {"a": {"tags": ["beach"]}})
        app = create_app(FakeArchive(store))
        app.testing = True
        c = app.test_client()
        self.assertEqual(set(c.get("/api/tags").get_json()), {"beach"})
        # a tag added to the authoritative metadata shows up on the next read,
        # with no restart and no manual index refresh
        store._flags["a"]["tags"] = ["beach", "mountains"]
        self.assertEqual(set(c.get("/api/tags").get_json()),
                         {"beach", "mountains"})


class TestTagFiltering(TagBase):
    def test_filter_returns_all_matches_without_duplicates(self):
        c = self.client(
            [photo("a"), photo("b"), photo("c")],
            {"a": {"tags": ["beach"]},
             "b": {"tags": ["beach"]},
             "c": {"tags": ["forest"]}})
        data = c.get("/api/wall?tag=beach").get_json()
        ids = [p["id"] for cl in data["clusters"] for p in cl["photos"]]
        self.assertEqual(sorted(ids), ["a", "b"])
        self.assertEqual(len(ids), len(set(ids)))   # no duplicates

    def test_filter_is_case_insensitive(self):
        c = self.client(
            [photo("a")], {"a": {"tags": ["Sunset"]}})
        data = c.get("/api/wall?tag=sunset").get_json()
        ids = [p["id"] for cl in data["clusters"] for p in cl["photos"]]
        self.assertEqual(ids, ["a"])

    def test_filter_matches_tags_with_surrounding_whitespace(self):
        # older/hand-edited metadata may carry stray whitespace in a tag
        c = self.client(
            [photo("a")], {"a": {"tags": ["  beach  "]}})
        data = c.get("/api/wall?tag=beach").get_json()
        ids = [p["id"] for cl in data["clusters"] for p in cl["photos"]]
        self.assertEqual(ids, ["a"])

    def test_multiple_tags_require_all(self):
        c = self.client(
            [photo("a"), photo("b")],
            {"a": {"tags": ["beach", "sunset"]},
             "b": {"tags": ["beach"]}})
        data = c.get("/api/wall?tag=beach,sunset").get_json()
        ids = [p["id"] for cl in data["clusters"] for p in cl["photos"]]
        self.assertEqual(ids, ["a"])

    def test_search_includes_location(self):
        c = self.client(
            [photo("a"), photo("b")],
            {"a": {}, "b": {}},
            text={"a": "sunrise over kyoto", "b": "a grey day in oslo"})
        data = c.get("/api/wall?q=kyoto").get_json()
        ids = [p["id"] for cl in data["clusters"] for p in cl["photos"]]
        self.assertEqual(ids, ["a"])




class TestTagWallOrder(TagBase):
    def test_tag_results_gather_across_folders_and_return_saved_order(self):
        client = self.client([photo("a", "roll-a"), photo("b", "roll-b")],
                             {"a": {"tags": ["sun"]}, "b": {"tags": ["Sun"]}})
        response = client.post("/api/wall/order", json={"root": "/fake", "tags": ["SUN"], "ids": ["b", "a"]})
        self.assertEqual(response.status_code, 200)
        wall = client.get("/api/wall?tag=sun").get_json()
        self.assertEqual(len(wall["clusters"]), 1)
        self.assertEqual(wall["tagOrder"], ["b", "a"])
        self.assertEqual(len(client.get("/api/wall").get_json()["clusters"]), 2)

    def test_invalid_order_does_not_save(self):
        client = self.client([photo("a"), photo("b")], {"a": {"tags": ["sun"]}})
        for ids in (["a", "a"], ["unknown"], ["b"], [1]):
            self.assertEqual(client.post("/api/wall/order", json={
                "root": "/fake", "tags": ["sun"], "ids": ids}).status_code, 400)
        self.assertEqual(client.post("/api/wall/order", json={
            "root": "/other", "tags": ["sun"], "ids": ["a"]}).status_code, 409)
        for tags in ([], "sun", [None], [""]):
            self.assertEqual(client.post("/api/wall/order", json={
                "root": "/fake", "tags": tags, "ids": ["a"]}).status_code, 400)


class TestDeleteTag(TagBase):
    def test_deletes_every_matching_tag_even_outside_current_filter(self):
        client = self.client([photo("a"), photo("b")], {
            "a": {"tags": ["SUN", "trip"], "rating": 5},
            "b": {"tags": ["sun"]}, "missing": {"tags": ["Sun", "keep"]}})
        result = client.post("/api/tags/delete", json={"root": "/fake", "tag": " sun "})
        self.assertEqual(result.get_json(), {"ok": True, "changed": 3})
        self.assertEqual(client.get("/api/tags").get_json(), ["keep", "trip"])
        self.assertEqual(client.get("/api/wall?stars=5").get_json()["shown"], 1)

    def test_rejects_changed_archives_and_invalid_tags(self):
        client = self.client([photo("a")], {"a": {"tags": ["sun"]}})
        self.assertEqual(client.post("/api/tags/delete", json={"root": "/other", "tag": "sun"}).status_code, 409)
        for tag in (None, [], "", " ", "a,b"):
            self.assertEqual(client.post("/api/tags/delete", json={"root": "/fake", "tag": tag}).status_code, 400)
        self.assertEqual(client.get("/api/tags").get_json(), ["sun"])


class TestChronologicalWall(TagBase):
    def test_all_rolls_gather_by_creation_date_not_filename_or_modified_date(self):
        photos = [dict(photo("new", "roll-a", "aaa.jpg"), created_at=300, mtime=1),
                  dict(photo("old", "roll-b", "zzz.jpg"), created_at=100, mtime=900),
                  dict(photo("middle", "roll-a"), created_at=200)]
        client = self.client(photos, {})
        wall = client.get("/api/wall?mode=chronological").get_json()
        self.assertEqual(wall["mode"], "chronological")
        self.assertEqual(wall["shown"], 3)
        self.assertEqual(len(wall["clusters"]), 1)
        self.assertEqual([p["id"] for p in wall["clusters"][0]["photos"]], ["old", "middle", "new"])
        self.assertEqual(len(client.get("/api/wall").get_json()["clusters"]), 2)

    def test_filtering_keeps_chronology_and_ignores_custom_tag_order(self):
        client = self.client([dict(photo("a"), created_at=200), dict(photo("b"), created_at=100)],
                             {"a": {"tags": ["sun"]}, "b": {"tags": ["sun"]}})
        client.post("/api/wall/order", json={"root": "/fake", "tags": ["sun"], "ids": ["a", "b"]})
        wall = client.get("/api/wall?mode=chronological&tag=sun").get_json()
        self.assertEqual([p["id"] for p in wall["clusters"][0]["photos"]], ["b", "a"])
        self.assertEqual(wall["tagOrder"], [])

    def test_missing_creation_date_falls_back_and_unknown_dates_sort_last(self):
        client = self.client([photo("unknown"), dict(photo("exif"), exif_date="2000-01-01"),
                              dict(photo("modified"), mtime=1), dict(photo("equal-a"), created_at=2),
                              dict(photo("equal-b"), created_at=2)], {})
        wall = client.get("/api/wall?mode=chronological").get_json()
        self.assertEqual([p["id"] for p in wall["clusters"][0]["photos"]],
                         ["modified", "equal-a", "equal-b", "exif", "unknown"])


if __name__ == "__main__":
    unittest.main()
