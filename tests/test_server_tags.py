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


if __name__ == "__main__":
    unittest.main()
