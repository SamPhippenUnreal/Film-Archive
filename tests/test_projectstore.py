"""Behavioural tests for the folder-backed Project workspace store.

All fixtures live under ``TemporaryDirectory``.  In particular, these tests
must never discover or mutate a user's configured Projects folder.
"""
import base64
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from app.projectstore import ProjectStore


# A real, decodable 1x1 RGBA PNG.  Keeping the fixture inline avoids depending
# on Pillow merely to construct test data; ProjectStore may still use Pillow to
# generate its disposable preview.
_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8A"
    "AQUBAScY42YAAAAASUVORK5CYII="
)


class ProjectStoreBase(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory(prefix="archive-projects-test-")
        self.tmp = Path(self._tmp.name)
        self.root = self.tmp / "projects"
        self.local = self.tmp / "local"
        self.previews = self.tmp / "previews"
        self.root.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def store(self):
        return ProjectStore(
            str(self.root), local_dir=str(self.local),
            preview_dir=str(self.previews),
        )

    @staticmethod
    def project_named(projects, name):
        for project in projects:
            if project.get("title") == name or project.get("name") == name:
                return project
        raise AssertionError("project {!r} not found in {!r}".format(
            name, projects))

    @staticmethod
    def file_named(project, name):
        for item in project.get("files", []):
            if item.get("filename") == name or item.get("name") == name:
                return item
        raise AssertionError("file {!r} not found in {!r}".format(
            name, project.get("files", [])))


class TestProjectDiscovery(ProjectStoreBase):
    def test_immediate_subfolders_are_projects(self):
        (self.root / "Film One").mkdir()
        (self.root / "Film Two").mkdir()
        (self.root / "loose.txt").write_text("not a project", encoding="utf-8")
        (self.root / "Film One" / "nested").mkdir()
        (self.root / "Film One" / "nested" / "deep.txt").write_text(
            "nested", encoding="utf-8")

        projects = self.store().list_projects()

        self.assertEqual(
            {p.get("title", p.get("name")) for p in projects},
            {"Film One", "Film Two"},
        )
        # Nested folders are contents of Film One, never additional projects.
        self.assertNotIn("nested", {p.get("title", p.get("name"))
                                     for p in projects})

    def test_root_with_files_and_no_child_folders_is_one_project(self):
        (self.root / "notes.txt").write_text("hello", encoding="utf-8")
        (self.root / "reference.bin").write_bytes(b"unknown")

        projects = self.store().list_projects()

        self.assertEqual(len(projects), 1)
        detail = self.store().get_project(projects[0]["id"])
        self.assertEqual(
            {f.get("filename", f.get("name")) for f in detail["files"]},
            {"notes.txt", "reference.bin"},
        )

    def test_all_supported_and_unknown_file_types_remain_visible(self):
        folder = self.root / "Mixed Media"
        folder.mkdir()
        names = {
            "photo.jpg", "scan.png", "print.tiff", "layers.psd",
            "motion.gif", "bitmap.bmp", "modern.webp", "notes.txt",
            "book.pdf", "draft.docx", "score.mp3", "take.wav",
            "cut.mp4", "rushes.mov", "model.blend",
        }
        for name in names:
            (folder / name).write_bytes(b"fixture")

        summary = self.project_named(self.store().list_projects(),
                                     "Mixed Media")
        project = self.store().get_project(summary["id"])

        self.assertEqual(
            {f.get("filename", f.get("name")) for f in project["files"]},
            names,
        )
        unknown = self.file_named(project, "model.blend")
        self.assertIn(unknown.get("kind", unknown.get("type")),
                      {"file", "unknown", "other"})


class TestProjectState(ProjectStoreBase):
    def setUp(self):
        super().setUp()
        self.folder = self.root / "Feature"
        self.folder.mkdir()
        (self.folder / "cover.png").write_bytes(_PNG)
        (self.folder / "notes.txt").write_text("hello", encoding="utf-8")

    def current(self, store=None):
        store = store or self.store()
        summary = self.project_named(store.list_projects(), "Feature")
        return store, store.get_project(summary["id"])

    def test_cover_positions_and_annotations_survive_restart(self):
        store, project = self.current()
        cover = self.file_named(project, "cover.png")
        notes = self.file_named(project, "notes.txt")
        positions = {
            cover["id"]: {"x": 12.5, "y": -40.0},
            notes["id"]: {"x": 320.0, "y": 80.25},
        }
        annotations = {
            "strokes": [{"brush": "ink", "points": [[1, 2], [3, 4]]}]
        }

        store.set_cover(project["id"], cover["id"])
        store.update_positions(project["id"], positions)
        store.set_annotations(project["id"], annotations)

        restarted, restored = self.current(self.store())
        cover_value = restored.get("cover_file_id", restored.get("cover"))
        if isinstance(cover_value, dict):
            cover_value = cover_value.get("id")
        self.assertEqual(cover_value, cover["id"])
        self.assertEqual(restored["positions"], positions)
        self.assertEqual(restarted.get_annotations(project["id"]), annotations)

    def test_state_sidecar_is_not_returned_as_project_material(self):
        store, project = self.current()
        cover = self.file_named(project, "cover.png")
        store.set_cover(project["id"], cover["id"])
        store.update_positions(project["id"],
                               {cover["id"]: {"x": 1, "y": 2}})
        store.set_annotations(project["id"], {"strokes": []})

        _, refreshed = self.current(store)

        self.assertEqual(
            {f.get("filename", f.get("name")) for f in refreshed["files"]},
            {"cover.png", "notes.txt"},
        )

    def test_missing_cover_falls_back_without_breaking_project(self):
        store, project = self.current()
        cover = self.file_named(project, "cover.png")
        store.set_cover(project["id"], cover["id"])
        (self.folder / "cover.png").unlink()

        refreshed = store.get_project(project["id"])

        self.assertIsNotNone(refreshed)
        self.assertEqual(
            {f.get("filename", f.get("name")) for f in refreshed["files"]},
            {"notes.txt"},
        )
        stale = refreshed.get("cover_file_id", refreshed.get("cover"))
        self.assertNotEqual(stale, cover["id"])


class TestImportsAndContainment(ProjectStoreBase):
    def setUp(self):
        super().setUp()
        self.folder = self.root / "Feature"
        self.folder.mkdir()

    def project(self, store):
        summary = self.project_named(store.list_projects(), "Feature")
        return store.get_project(summary["id"])

    def test_import_collision_never_overwrites_existing_file(self):
        (self.folder / "still.png").write_bytes(b"original")
        source_dir = self.tmp / "source"
        source_dir.mkdir()
        source = source_dir / "still.png"
        source.write_bytes(_PNG)
        store = self.store()
        project = self.project(store)

        imported = store.import_files(project["id"], [str(source)])

        self.assertEqual((self.folder / "still.png").read_bytes(), b"original")
        self.assertEqual(len(imported), 1)
        refreshed = store.get_project(project["id"])
        pngs = [f for f in refreshed["files"]
                if f.get("filename", f.get("name", "")).lower().endswith(
                    ".png")]
        self.assertEqual(len(pngs), 2)
        imported_paths = [Path(store.resolve_file(project["id"], f["id"]))
                          for f in pngs]
        self.assertIn(_PNG, [p.read_bytes() for p in imported_paths])

    def test_resolve_rejects_traversal_and_unknown_ids(self):
        (self.folder / "inside.txt").write_text("inside", encoding="utf-8")
        outside = self.root.parent / "secret.txt"
        outside.write_text("secret", encoding="utf-8")
        store = self.store()
        project = self.project(store)

        for bad_id in ("../secret.txt", "..%2fsecret.txt", str(outside),
                       "not-a-real-file-id"):
            with self.subTest(file_id=bad_id):
                try:
                    resolved = store.resolve_file(project["id"], bad_id)
                except (KeyError, ValueError, FileNotFoundError):
                    resolved = None
                self.assertIsNone(resolved)

    def test_symlink_cannot_escape_project_folder(self):
        outside = self.tmp / "secret.txt"
        outside.write_text("secret", encoding="utf-8")
        link = self.folder / "innocent.txt"
        try:
            os.symlink(str(outside), str(link))
        except (OSError, NotImplementedError) as exc:
            self.skipTest("symlink creation unavailable: {}".format(exc))
        store = self.store()
        project = self.project(store)
        linked = next((f for f in project["files"]
                       if f.get("filename", f.get("name")) == "innocent.txt"),
                      None)

        if linked is not None:
            try:
                resolved = store.resolve_file(project["id"], linked["id"])
            except (KeyError, ValueError, FileNotFoundError):
                resolved = None
            self.assertIsNone(resolved)


class TestPreviews(ProjectStoreBase):
    def test_valid_image_preview_is_disposable_and_unknown_falls_back(self):
        folder = self.root / "Visual"
        folder.mkdir()
        (folder / "pixel.png").write_bytes(_PNG)
        (folder / "scene.blend").write_bytes(b"unknown")
        store = self.store()
        summary = self.project_named(store.list_projects(), "Visual")
        project = store.get_project(summary["id"])
        image = self.file_named(project, "pixel.png")
        unknown = self.file_named(project, "scene.blend")

        preview = store.preview_for(project["id"], image["id"])
        fallback = store.preview_for(project["id"], unknown["id"])

        self.assertIsNotNone(preview)
        self.assertTrue(Path(preview).is_file())
        self.assertTrue(Path(preview).resolve().is_relative_to(
            self.previews.resolve()))
        self.assertIsNone(fallback)


if __name__ == "__main__":
    unittest.main()
