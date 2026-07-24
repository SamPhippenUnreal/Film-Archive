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
            cover["id"]: {"x": 12.5, "y": -40.0,
                          "width": 410.0, "height": 280.0, "z": 8.0},
            notes["id"]: {"x": 320.0, "y": 80.25,
                          "width": 230.0, "height": 298.0, "z": 4.0},
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

    def test_invalid_dimensions_and_stacking_are_rejected(self):
        store, project = self.current()
        cover = self.file_named(project, "cover.png")
        for position in (
                {"x": 1, "y": 2, "width": -1, "height": 80, "z": 1},
                {"x": 1, "y": 2, "width": 200, "height": 80, "z": 100001},
                {"x": 1, "y": 2, "width": float("inf"), "height": 80}):
            with self.subTest(position=position):
                self.assertFalse(store.update_positions(
                    project["id"], {cover["id"]: position}))

    def test_project_cover_layout_survives_restart_and_new_projects_do_not_move_it(self):
        store, project = self.current()
        layout = {project["id"]: {"x": 44.5, "y": 81.0, "z": 7.0}}
        self.assertTrue(store.update_index_layout(layout))

        (self.root / "Second Feature").mkdir()
        restarted = self.store()

        self.assertEqual(restarted.get_index_layout()[project["id"]], layout[project["id"]])
        self.assertEqual({p["title"] for p in restarted.list_projects()},
                         {"Feature", "Second Feature"})

    def test_invalid_project_cover_layout_is_rejected(self):
        store, project = self.current()
        self.assertFalse(store.update_index_layout({
            project["id"]: {"x": 1, "y": 2, "z": 100001},
        }))
        self.assertFalse(store.update_index_layout({
            "not-a-project": {"x": 1, "y": 2, "z": 1},
        }))

    def test_project_text_document_can_be_edited_without_touching_other_files(self):
        store, project = self.current()
        notes = self.file_named(project, "notes.txt")
        before_cover = (self.folder / "cover.png").read_bytes()

        saved = store.save_document(project["id"], notes["id"], {
            "content": "<div>edited project notes</div>",
            "editor_state": {
                "content": "<div>edited project notes</div>",
                "groups": {}, "annotations": {"cells": []},
                "rating": 3, "tags": "draft",
            },
        })

        self.assertIsNotNone(saved)
        self.assertEqual((self.folder / "notes.txt").read_text(encoding="utf-8"),
                         "edited project notes")
        self.assertEqual((self.folder / "cover.png").read_bytes(), before_cover)
        reopened = self.store().get_document(project["id"], notes["id"])
        self.assertIn("edited project notes", reopened["content"])
        self.assertEqual(reopened["rating"], 3)

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

    def test_writing_import_carries_page_preview_state(self):
        source_dir = self.tmp / "writing"
        source_dir.mkdir()
        source = source_dir / "Draft.txt"
        source.write_text("portable text", encoding="utf-8")
        state = {
            "content": '<div>portable text</div><div class="doc-group" '
                       'data-gid="g1"></div>',
            "groups": {"g1": {"images": ["photo-1"]}},
            "annotations": {"cells": [[1, 2, "#333333"]]},
        }
        store = self.store()
        project = self.project(store)
        imported, errors = store.import_files_with_errors(project["id"], [{
            "path": str(source), "writing_state": state,
        }])
        self.assertEqual(errors, [])
        self.assertEqual(len(imported), 1)
        refreshed = store.get_project(project["id"])
        record = next(f for f in refreshed["files"]
                      if f["filename"] == "Draft.txt")
        self.assertEqual(record["document"]["groups"], state["groups"])
        self.assertIn("portable text", record["document"]["content"])
        self.assertNotIn(".archive-writing",
                         {f["filename"] for f in refreshed["files"]})

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

    def test_pdf_preview_is_a_raster_of_the_first_page_only(self):
        from PIL import Image

        folder = self.root / "PDF"
        folder.mkdir()
        first = Image.new("RGB", (306, 396), (210, 45, 35))
        second = Image.new("RGB", (306, 396), (35, 65, 210))
        first.save(folder / "pages.pdf", "PDF", save_all=True,
                   append_images=[second])
        store = self.store()
        project = store.get_project(
            self.project_named(store.list_projects(), "PDF")["id"])
        pdf = self.file_named(project, "pages.pdf")

        preview = store.preview_for(project["id"], pdf["id"])

        self.assertIsNotNone(preview)
        with Image.open(preview) as image:
            self.assertEqual(image.format, "JPEG")
            pixel = image.convert("RGB").getpixel(
                (image.width // 2, image.height // 2))
        self.assertGreater(pixel[0], pixel[2] * 3)


class TestProjectFilesystemMutations(ProjectStoreBase):
    def setUp(self):
        super().setUp()
        self.folder = self.root / "Feature"
        self.folder.mkdir()
        (self.folder / "cover.png").write_bytes(_PNG)
        (self.folder / "notes.txt").write_text("keep", encoding="utf-8")
        self.store_obj = self.store()
        self.project = self.store_obj.list_projects()[0]

    def detail(self):
        return self.store_obj.get_project(self.project["id"])

    def test_create_project_makes_a_unique_empty_folder(self):
        first, error = self.store_obj.create_project()
        second, second_error = self.store_obj.create_project()

        self.assertIsNone(error)
        self.assertIsNone(second_error)
        self.assertEqual(first["title"], "Untitled Project")
        self.assertEqual(second["title"], "Untitled Project 2")
        self.assertTrue((self.root / "Untitled Project").is_dir())
        self.assertTrue((self.root / "Untitled Project 2").is_dir())
        self.assertEqual(first["files"], [])

    def test_project_with_images_stays_uncovered_until_cover_is_chosen(self):
        detail = self.detail()
        cover = self.file_named(detail, "cover.png")

        self.assertIsNone(detail["cover_file_id"])
        self.assertFalse(detail["cover_explicit"])
        self.assertTrue(self.store_obj.set_cover(detail["id"], cover["id"]))
        chosen = self.detail()
        self.assertEqual(chosen["cover_file_id"], cover["id"])
        self.assertTrue(chosen["cover_explicit"])

    def test_create_project_refuses_to_change_single_project_discovery_mode(self):
        single = self.tmp / "single-project"
        single.mkdir()
        source = single / "irreplaceable.txt"
        source.write_text("safe", encoding="utf-8")
        store = ProjectStore(str(single), preview_dir=str(self.previews))

        project, error = store.create_project()

        self.assertIsNone(project)
        self.assertIn("containing", error)
        self.assertEqual(source.read_text(encoding="utf-8"), "safe")
        self.assertEqual(
            [path.name for path in single.iterdir() if path.name != "cache"],
            ["irreplaceable.txt"])

    def test_project_document_rename_preserves_editor_and_canvas_state(self):
        detail = self.detail()
        notes = self.file_named(detail, "notes.txt")
        self.store_obj.update_positions(detail["id"], {
            notes["id"]: {"x": 125, "y": 240, "width": 230, "height": 298},
        })
        self.store_obj.save_document(detail["id"], notes["id"], {
            "content": "<div>renamed body</div>",
            "editor_state": {
                "content": "<div>renamed body</div>",
                "rating": 3,
                "tags": "project",
            },
        })

        renamed, error = self.store_obj.rename_document(
            detail["id"], notes["id"], "Research Notes")

        self.assertIsNone(error)
        self.assertEqual(renamed["title"], "Research Notes")
        self.assertIn("renamed body", renamed["content"])
        self.assertEqual(renamed["rating"], 3)
        self.assertFalse((self.folder / "notes.txt").exists())
        self.assertTrue((self.folder / "Research Notes.txt").exists())
        refreshed = self.store_obj.get_project(detail["id"])
        moved = self.file_named(refreshed, "Research Notes.txt")
        self.assertEqual(moved["position"]["x"], 125)
        self.assertEqual(moved["position"]["y"], 240)

    def test_rename_preserves_cover_layout_rotation_annotations_and_index(self):
        detail = self.detail()
        cover = self.file_named(detail, "cover.png")
        position = {"x": 12, "y": 30, "width": 240, "height": 180,
                    "z": 4, "rotation": 270}
        self.assertTrue(self.store_obj.set_cover(detail["id"], cover["id"]))
        self.assertTrue(self.store_obj.update_positions(
            detail["id"], {cover["id"]: position}))
        self.assertTrue(self.store_obj.set_annotations(
            detail["id"], {"cells": [[1, 2, "#333333"]]}))
        self.assertTrue(self.store_obj.update_index_layout(
            {detail["id"]: {"x": 90, "y": 40, "z": 1}}))

        renamed, error = self.store_obj.rename_project(detail["id"], "New Name")

        self.assertIsNone(error)
        self.assertFalse(self.folder.exists())
        self.assertTrue((self.root / "New Name").is_dir())
        self.assertNotEqual(renamed["id"], detail["id"])
        restored_cover = self.file_named(renamed, "cover.png")
        self.assertEqual(renamed["cover_file_id"], restored_cover["id"])
        self.assertEqual(renamed["positions"][restored_cover["id"]], position)
        self.assertEqual(renamed["annotations"],
                         {"cells": [[1, 2, "#333333"]]})
        self.assertNotIn(detail["id"], self.store_obj.get_index_layout())
        self.assertIn(renamed["id"], self.store_obj.get_index_layout())

    def test_rename_rejects_invalid_reserved_conflicting_and_single_root(self):
        (self.root / "Existing").mkdir()
        for name in ("", "../escape", "bad:name", "CON", "cache", "Existing"):
            with self.subTest(name=name):
                project, error = self.store_obj.rename_project(
                    self.project["id"], name)
                self.assertIsNone(project)
                self.assertTrue(error)
                self.assertTrue(self.folder.is_dir())

        single = self.tmp / "single"
        single.mkdir()
        (single / "file.txt").write_text("x", encoding="utf-8")
        single_store = ProjectStore(str(single), preview_dir=str(self.previews))
        only = single_store.list_projects()[0]
        project, error = single_store.rename_project(only["id"], "Elsewhere")
        self.assertIsNone(project)
        self.assertIn("linked", error)
        self.assertTrue(single.is_dir())
        ok, error = single_store.delete_project(only["id"])
        self.assertFalse(ok)
        self.assertIn("linked", error)
        self.assertTrue((single / "file.txt").is_file())

    def test_removing_a_file_only_takes_it_off_the_canvas(self):
        # the project workspace never deletes from disk: the file stays exactly
        # where it is and is only filtered out of the canvas, into the trash
        detail = self.detail()
        cover = self.file_named(detail, "cover.png")
        self.store_obj.set_cover(detail["id"], cover["id"])
        self.store_obj.update_positions(
            detail["id"], {cover["id"]: {"x": 1, "y": 2, "rotation": 90}})

        ok, error = self.store_obj.remove_file(detail["id"], cover["id"])

        self.assertTrue(ok, error)
        self.assertTrue((self.folder / "cover.png").is_file())   # still on disk
        refreshed = self.store_obj.get_project(detail["id"])
        self.assertNotIn("cover.png",
                         [f["filename"] for f in refreshed["files"]])
        self.assertIsNone(refreshed["cover_file_id"])
        # and it is waiting in the project's trash
        trash = self.store_obj.get_removed(detail["id"])
        self.assertEqual([f["filename"] for f in trash["files"]], ["cover.png"])

    def test_restoring_returns_material_to_the_canvas_in_its_place(self):
        detail = self.detail()
        cover = self.file_named(detail, "cover.png")
        self.store_obj.update_positions(
            detail["id"], {cover["id"]: {"x": 12, "y": 34}})
        self.store_obj.remove_file(detail["id"], cover["id"])
        trashed = self.store_obj.get_removed(detail["id"])["files"][0]

        ok, error = self.store_obj.restore_files(detail["id"], [trashed["id"]])

        self.assertTrue(ok, error)
        refreshed = self.store_obj.get_project(detail["id"])
        self.assertIn("cover.png", [f["filename"] for f in refreshed["files"]])
        self.assertEqual(self.store_obj.get_removed(detail["id"])["files"], [])
        # the place it held on the canvas was kept for it
        restored = self.file_named(refreshed, "cover.png")
        self.assertEqual(restored["position"]["x"], 12)
        self.assertEqual(restored["position"]["y"], 34)

    def test_removed_material_uses_the_same_position_update_path(self):
        detail = self.detail()
        cover = self.file_named(detail, "cover.png")
        self.store_obj.remove_file(detail["id"], cover["id"])

        self.assertTrue(self.store_obj.update_positions(detail["id"], {
            cover["id"]: {
                "x": 321, "y": 222, "width": 180, "height": 140, "z": 7,
                "rotation": 90,
            },
        }))

        trashed = self.file_named(
            self.store_obj.get_removed(detail["id"]), "cover.png")
        self.assertEqual(trashed["position"]["x"], 321)
        self.assertEqual(trashed["position"]["y"], 222)
        self.assertEqual(trashed["position"]["z"], 7)

    def test_delete_project_only_removes_exact_immediate_child(self):
        outside = self.tmp / "outside.txt"
        outside.write_text("safe", encoding="utf-8")

        ok, error = self.store_obj.delete_project(self.project["id"])

        self.assertTrue(ok, error)
        self.assertFalse(self.folder.exists())
        self.assertTrue(self.root.is_dir())
        self.assertEqual(outside.read_text(encoding="utf-8"), "safe")

    def test_rotation_must_be_a_quarter_turn(self):
        detail = self.detail()
        cover = self.file_named(detail, "cover.png")
        self.assertFalse(self.store_obj.update_positions(
            detail["id"], {cover["id"]: {"x": 1, "y": 2, "rotation": 45}}))
        self.assertTrue(self.store_obj.update_positions(
            detail["id"], {cover["id"]: {"x": 1, "y": 2, "rotation": 450}}))
        restored = self.store_obj.get_project(detail["id"])
        self.assertEqual(restored["positions"][cover["id"]]["rotation"], 90)


if __name__ == "__main__":
    unittest.main()
