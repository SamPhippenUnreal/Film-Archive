"""HTTP contract tests for the Project workspace.

The real ProjectStore is used behind lightweight archive adapters.  Every
source and destination is a temporary directory, so the suite cannot touch a
folder linked in the desktop application.
"""
import base64
import io
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest import mock
from urllib.parse import quote

from app.projectstore import ProjectStore
from app.server import create_app


_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8A"
    "AQUBAScY42YAAAAASUVORK5CYII="
)


def _image_data_url(fmt="JPEG", size=(64, 48)):
    from PIL import Image
    output = io.BytesIO()
    Image.new("RGB", size, (180, 130, 90)).save(output, format=fmt)
    mime = "jpeg" if fmt == "JPEG" else "png"
    return "data:image/{};base64,{}".format(
        mime, base64.b64encode(output.getvalue()).decode("ascii"))


class FakePhotoStore:
    def __init__(self, photos, titles=None):
        self.photos = photos
        self.titles = titles or {}

    def get_photo(self, photo_id):
        photo = self.photos.get(photo_id)
        return dict(photo) if photo else None

    def all_photos(self):
        return [dict(photo) for photo in self.photos.values()]

    def meta_titles(self):
        return dict(self.titles)


class FakeScanner:
    @staticmethod
    def display_path(photo):
        return photo["path"]


class FakeArchive:
    def __init__(self, root, photos=None, titles=None):
        self.root = str(root)
        self.store = FakePhotoStore(photos or {}, titles)
        self.scanner = FakeScanner()
        self.docstore = None

    def status(self):
        return {"linked": True, "root": self.root}


class FakeWritingStore:
    def __init__(self, root, documents):
        self.dir = str(root)
        self.documents = documents

    def get_doc(self, document_id):
        doc = self.documents.get(document_id)
        return dict(doc) if doc else None

    def source_path(self, document_id):
        doc = self.documents.get(document_id)
        if not doc:
            return None
        return str(Path(self.dir) / doc["filename"])

    def export_state(self, document_id):
        doc = self.documents.get(document_id)
        if not doc:
            return None
        return {"content": doc.get("content", "<div>draft</div>"),
                "groups": doc.get("groups", {}), "annotations": {}}

    def rename_doc(self, document_id, title):
        doc = self.documents.get(document_id)
        if not doc or not isinstance(title, str) or not title.strip():
            return None, "document could not be renamed"
        extension = Path(doc["filename"]).suffix
        old_path = Path(self.dir) / doc["filename"]
        new_filename = title.strip() + extension
        new_path = Path(self.dir) / new_filename
        old_path.rename(new_path)
        renamed = dict(doc, id=title.strip(), title=title.strip(),
                       filename=new_filename)
        del self.documents[document_id]
        self.documents[renamed["id"]] = renamed
        return dict(renamed), None


class FakeWritingArchive:
    def __init__(self, root, documents=None):
        self.root = str(root)
        self.store = FakeWritingStore(root, documents or {})

    def status(self):
        return {"linked": True, "root": self.root, "pending": 0}


class FakeProjectArchive:
    def __init__(self, root, store):
        self.root = str(root)
        self.store = store

    def status(self):
        return {"linked": True, "root": self.root}


class ProjectServerBase(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory(prefix="archive-project-api-test-")
        self.tmp = Path(self._tmp.name)
        self.projects_root = self.tmp / "projects"
        self.project_dir = self.projects_root / "Feature"
        self.photo_root = self.tmp / "pictures"
        self.writing_root = self.tmp / "writing"
        for folder in (self.project_dir, self.photo_root, self.writing_root):
            folder.mkdir(parents=True)
        (self.project_dir / "board.png").write_bytes(_PNG)
        (self.project_dir / "notes.txt").write_text("project notes",
                                                     encoding="utf-8")
        self.photo_path = self.photo_root / "still.png"
        self.photo_path.write_bytes(_PNG)
        self.doc_path = self.writing_root / "Draft.docx"
        self.doc_path.write_bytes(b"docx fixture")
        self.project_store = ProjectStore(
            str(self.projects_root),
            local_dir=str(self.tmp / "project-local"),
            preview_dir=str(self.tmp / "project-previews"),
        )
        archive = FakeArchive(self.photo_root, {
            "photo-1": {"id": "photo-1", "filename": "still.png",
                        "path": str(self.photo_path)},
        })
        writing = FakeWritingArchive(self.writing_root, {
            "document-1": {"id": "document-1", "filename": "Draft.docx",
                           "name": "Draft.docx", "content": "<div>draft</div>"},
        })
        projects = FakeProjectArchive(self.projects_root, self.project_store)
        app = create_app(archive, projects, writing)
        app.testing = True
        self.client = app.test_client()

        listing = self.client.get("/api/project/projects")
        self.assertEqual(listing.status_code, 200, listing.get_data(as_text=True))
        payload = listing.get_json()
        self.assertTrue(payload["linked"])
        self.assertEqual(len(payload["projects"]), 1)
        self.project_id = payload["projects"][0]["id"]

    def tearDown(self):
        self._tmp.cleanup()

    def endpoint(self, suffix=""):
        return "/api/project/projects/{}{}".format(
            quote(self.project_id, safe=""), suffix)

    def detail(self):
        response = self.client.get(self.endpoint())
        self.assertEqual(response.status_code, 200,
                         response.get_data(as_text=True))
        return response.get_json()

    @staticmethod
    def file_named(project, filename):
        for item in project["files"]:
            if item["filename"] == filename:
                return item
        raise AssertionError("{} missing from {}".format(
            filename, [f["filename"] for f in project["files"]]))


class TestProjectReads(ProjectServerBase):
    def test_list_and_detail_expose_every_file_with_urls(self):
        project = self.detail()

        self.assertEqual(project["id"], self.project_id)
        self.assertEqual({f["filename"] for f in project["files"]},
                         {"board.png", "notes.txt"})
        for item in project["files"]:
            self.assertTrue(item.get("file_url"), item)
            self.assertIn("position", item)
        image = self.file_named(project, "board.png")
        self.assertTrue(image.get("preview_url"), image)

    def test_project_api_is_never_browser_cached(self):
        response = self.client.get("/api/project/projects")
        self.assertEqual(response.headers.get("Cache-Control"), "no-store")


class TestProjectPictureTitles(ProjectServerBase):
    """A picture in a project goes by its filename, unless the same photograph
    was given a title in the image gallery — then the project calls it that."""

    def _client(self, titles):
        # the gallery holds a photograph whose file is the project's board.png
        archive = FakeArchive(self.photo_root, {
            "photo-1": {"id": "photo-1", "filename": "board.png",
                        "path": str(self.photo_path)},
        }, titles=titles)
        app = create_app(
            archive,
            FakeProjectArchive(self.projects_root, self.project_store),
            FakeWritingArchive(self.writing_root, {}))
        app.testing = True
        return app.test_client()

    def _image(self, client, filename):
        return self.file_named(client.get(self.endpoint()).get_json(), filename)

    def test_a_gallery_title_names_the_picture(self):
        image = self._image(self._client({"photo-1": "Nate Swimming"}),
                            "board.png")
        self.assertEqual(image.get("gallery_title"), "Nate Swimming")

    def test_an_untitled_picture_keeps_its_filename(self):
        image = self._image(self._client({}), "board.png")
        self.assertIsNone(image.get("gallery_title"))

    def test_a_second_imported_copy_still_finds_its_title(self):
        # importing the same photograph twice stores it as "board 2.png";
        # it is the same picture and answers to the same name
        (self.project_dir / "board 2.png").write_bytes(_PNG)
        image = self._image(self._client({"photo-1": "Nate Swimming"}),
                            "board 2.png")
        self.assertEqual(image.get("gallery_title"), "Nate Swimming")

    def test_material_that_is_not_a_picture_is_never_retitled(self):
        project = self._client({"photo-1": "Nate Swimming"}).get(
            self.endpoint()).get_json()
        self.assertIsNone(
            self.file_named(project, "notes.txt").get("gallery_title"))

    def test_file_and_preview_routes_serve_only_known_material(self):
        project = self.detail()
        image = self.file_named(project, "board.png")
        text = self.file_named(project, "notes.txt")

        file_response = self.client.get(
            "/project/file/{}/{}".format(
                quote(self.project_id, safe=""), quote(text["id"], safe="")))
        preview_response = self.client.get(
            "/project/preview/{}/{}".format(
                quote(self.project_id, safe=""), quote(image["id"], safe="")))
        self.assertEqual(file_response.status_code, 200)
        self.assertEqual(file_response.data, b"project notes")
        self.assertEqual(preview_response.status_code, 200)
        self.assertTrue(preview_response.mimetype.startswith("image/"))
        file_response.close()
        preview_response.close()

        unknown = quote("../secret.txt", safe="")
        self.assertEqual(self.client.get(
            "/project/file/{}/{}".format(
                quote(self.project_id, safe=""), unknown)).status_code, 404)
        self.assertEqual(self.client.get(
            "/project/preview/{}/{}".format(
                quote(self.project_id, safe=""), unknown)).status_code, 404)


class TestProjectStateEndpoints(ProjectServerBase):
    def test_photo_project_has_no_cover_url_until_one_is_explicitly_chosen(self):
        listing = self.client.get("/api/project/projects").get_json()
        uncovered = listing["projects"][0]
        image = self.file_named(self.detail(), "board.png")

        self.assertFalse(uncovered["cover_explicit"])
        self.assertIsNone(uncovered["cover_file_id"])
        self.assertIsNone(uncovered["cover_url"])

        response = self.client.post(
            self.endpoint("/cover"), json={"file_id": image["id"]})
        covered = self.client.get(
            "/api/project/projects").get_json()["projects"][0]

        self.assertEqual(response.status_code, 200)
        self.assertTrue(covered["cover_explicit"])
        self.assertEqual(covered["cover_file_id"], image["id"])
        self.assertIn("/project/preview/", covered["cover_url"])

    def test_cover_positions_and_annotations_persist_through_http(self):
        project = self.detail()
        image = self.file_named(project, "board.png")
        text = self.file_named(project, "notes.txt")
        positions = {
            image["id"]: {"x": 10, "y": -20, "width": 300},
            text["id"]: {"x": 450.5, "y": 90.25},
        }
        annotations = {
            "strokes": [{"brush": "wiggly", "points": [[1, 2], [4, 8]]}]
        }

        cover_response = self.client.post(
            self.endpoint("/cover"), json={"file_id": image["id"]})
        positions_response = self.client.post(
            self.endpoint("/positions"), json={"positions": positions})
        annotations_response = self.client.post(
            self.endpoint("/annotations"), json=annotations)

        self.assertEqual(cover_response.status_code, 200)
        self.assertEqual(positions_response.status_code, 200)
        self.assertEqual(annotations_response.status_code, 200)
        restored = self.detail()
        cover = restored.get("cover_file_id", restored.get("cover"))
        if isinstance(cover, dict):
            cover = cover.get("id")
        self.assertEqual(cover, image["id"])
        self.assertEqual(restored["positions"], positions)
        self.assertEqual(restored["annotations"], annotations)

        fetched = self.client.get(self.endpoint("/annotations"))
        self.assertEqual(fetched.status_code, 200)
        payload = fetched.get_json()
        self.assertEqual(payload.get("annotations", payload), annotations)

    def test_invalid_project_or_file_is_not_mutated(self):
        missing_project = "/api/project/projects/not-a-project"
        self.assertEqual(self.client.post(
            missing_project + "/positions", json={"positions": {}}
        ).status_code, 404)
        self.assertIn(self.client.post(
            self.endpoint("/cover"), json={"file_id": "../notes.txt"}
        ).status_code, {400, 404})

    def test_project_cover_layout_round_trips_through_http(self):
        layout = {self.project_id: {"x": 30.5, "y": 75, "z": 4}}

        saved = self.client.post("/api/project/layout",
                                 json={"positions": layout})
        listing = self.client.get("/api/project/projects").get_json()

        self.assertEqual(saved.status_code, 200, saved.get_data(as_text=True))
        self.assertEqual(listing["layout"], layout)

    def test_project_text_document_opens_edits_and_reopens(self):
        project = self.detail()
        notes = self.file_named(project, "notes.txt")
        endpoint = self.endpoint("/documents/{}".format(
            quote(notes["id"], safe="")))

        opened = self.client.get(endpoint)
        saved = self.client.post(endpoint, json={
            "content": "<div>edited through writing</div>",
            "groups": {}, "annotations": {"cells": []},
            "rating": 2, "tags": "project",
        })
        reopened = self.client.get(endpoint)

        self.assertEqual(opened.status_code, 200)
        self.assertIn("project notes", opened.get_json()["content"])
        self.assertEqual(saved.status_code, 200, saved.get_data(as_text=True))
        self.assertIn("edited through writing", reopened.get_json()["content"])
        self.assertEqual(reopened.get_json()["rating"], 2)
        self.assertEqual((self.project_dir / "notes.txt").read_text(encoding="utf-8"),
                         "edited through writing")

    def test_project_document_endpoint_rejects_non_documents_and_unknown_ids(self):
        project = self.detail()
        image = self.file_named(project, "board.png")
        for file_id in (image["id"], "../notes.txt", "missing"):
            with self.subTest(file_id=file_id):
                response = self.client.post(self.endpoint(
                    "/documents/{}".format(quote(file_id, safe=""))),
                    json={"content": "<div>no</div>"})
                self.assertEqual(response.status_code, 404)


class TestProjectImports(ProjectServerBase):
    def test_picture_ids_are_resolved_server_side_and_copied_once(self):
        # Force the collision path: existing user material must remain intact.
        (self.project_dir / "still.png").write_bytes(b"original")

        response = self.client.post(
            self.endpoint("/import/pictures"),
            json={"photo_ids": ["photo-1"]},
        )

        self.assertEqual(response.status_code, 200,
                         response.get_data(as_text=True))
        payload = response.get_json()
        self.assertTrue(payload["ok"])
        self.assertEqual(len(payload["imported"]), 1)
        self.assertEqual((self.project_dir / "still.png").read_bytes(),
                         b"original")
        pngs = list(self.project_dir.glob("still*.png"))
        self.assertEqual(len(pngs), 2)
        self.assertIn(_PNG, [path.read_bytes() for path in pngs])

    def test_writing_ids_are_resolved_server_side_and_copied(self):
        response = self.client.post(
            self.endpoint("/import/writing"),
            json={"document_ids": ["document-1"]},
        )

        self.assertEqual(response.status_code, 200,
                         response.get_data(as_text=True))
        payload = response.get_json()
        self.assertTrue(payload["ok"])
        self.assertEqual(len(payload["imported"]), 1)
        self.assertEqual((self.project_dir / "Draft.docx").read_bytes(),
                         b"docx fixture")
        detail = self.client.get(self.endpoint()).get_json()
        record = next(f for f in detail["files"]
                      if f["filename"] == "Draft.docx")
        self.assertIn("draft", record["document"]["content"])

    def test_unknown_ids_report_quiet_errors_without_partial_import(self):
        response = self.client.post(
            self.endpoint("/import/pictures"),
            json={"photo_ids": ["missing-photo"]},
        )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["imported"], [])
        self.assertTrue(payload["errors"])

    def test_client_supplied_paths_are_never_accepted(self):
        secret = self.tmp / "secret.txt"
        secret.write_text("must not copy", encoding="utf-8")

        for suffix in ("/import/pictures", "/import/writing"):
            with self.subTest(endpoint=suffix):
                response = self.client.post(
                    self.endpoint(suffix), json={"paths": [str(secret)]})
                self.assertIn(response.status_code, {200, 400})
        self.assertFalse((self.project_dir / "secret.txt").exists())


class TestProjectMutationEndpoints(ProjectServerBase):
    def test_create_project_route_creates_an_empty_folder(self):
        response = self.client.post("/api/project/projects", json={})

        self.assertEqual(response.status_code, 201,
                         response.get_data(as_text=True))
        project = response.get_json()["project"]
        self.assertEqual(project["title"], "Untitled Project")
        self.assertEqual(project["files"], [])
        self.assertTrue((self.projects_root / "Untitled Project").is_dir())

    def test_create_project_route_uses_the_confirmed_title(self):
        response = self.client.post(
            "/api/project/projects", json={"name": "Summer Research"})

        self.assertEqual(response.status_code, 201,
                         response.get_data(as_text=True))
        project = response.get_json()["project"]
        self.assertEqual(project["title"], "Summer Research")
        self.assertTrue((self.projects_root / "Summer Research").is_dir())
        self.assertFalse((self.projects_root / "Untitled Project").exists())

    def test_rename_returns_new_identity_and_preserves_files(self):
        response = self.client.post(
            self.endpoint("/rename"), json={"name": "Renamed Feature"})
        self.assertEqual(response.status_code, 200,
                         response.get_data(as_text=True))
        project = response.get_json()["project"]
        self.assertNotEqual(project["id"], self.project_id)
        self.assertTrue((self.projects_root / "Renamed Feature").is_dir())
        self.assertFalse(self.project_dir.exists())
        self.assertEqual({f["filename"] for f in project["files"]},
                         {"board.png", "notes.txt"})

    def test_project_document_rename_route_returns_the_new_file_identity(self):
        notes = self.file_named(self.detail(), "notes.txt")
        response = self.client.post(self.endpoint(
            "/documents/{}/rename".format(quote(notes["id"], safe=""))),
            json={"title": "Interview Notes"})

        self.assertEqual(response.status_code, 200,
                         response.get_data(as_text=True))
        document = response.get_json()["document"]
        self.assertEqual(document["title"], "Interview Notes")
        self.assertNotEqual(document["id"], notes["id"])
        self.assertFalse((self.project_dir / "notes.txt").exists())
        self.assertTrue((self.project_dir / "Interview Notes.txt").exists())

    def test_writing_document_rename_route_moves_the_portable_file(self):
        response = self.client.post(
            "/api/writing/documents/document-1/rename",
            json={"title": "Renamed Draft"})

        self.assertEqual(response.status_code, 200,
                         response.get_data(as_text=True))
        document = response.get_json()["document"]
        self.assertEqual(document["id"], "Renamed Draft")
        self.assertEqual(document["filename"], "Renamed Draft.docx")
        self.assertFalse(self.doc_path.exists())
        self.assertTrue((self.writing_root / "Renamed Draft.docx").exists())

    def test_removing_an_element_moves_it_to_project_trash(self):
        project = self.detail()
        text = self.file_named(project, "notes.txt")
        response = self.client.post(self.endpoint(
            "/files/{}/delete".format(quote(text["id"], safe=""))))
        self.assertEqual(response.status_code, 200)
        # off the canvas, but safely retained on disk in project trash
        self.assertFalse((self.project_dir / "notes.txt").exists())
        self.assertTrue((self.project_dir / "trash" / "notes.txt").is_file())
        self.assertTrue((self.project_dir / "board.png").is_file())
        self.assertNotIn("notes.txt",
                         [f["filename"] for f in self.detail()["files"]])

        trash = self.client.get(self.endpoint("/trash")).get_json()
        self.assertEqual([f["filename"] for f in trash["files"]], ["notes.txt"])

        restored = self.client.post(
            self.endpoint("/restore"),
            json={"file_ids": [trash["files"][0]["id"]]})
        self.assertEqual(restored.status_code, 200)
        self.assertIn("notes.txt",
                      [f["filename"] for f in self.detail()["files"]])
        self.assertTrue((self.project_dir / "notes.txt").is_file())
        self.assertFalse((self.project_dir / "trash" / "notes.txt").exists())
        self.assertEqual(
            self.client.get(self.endpoint("/trash")).get_json()["files"], [])

    def test_project_delete_route_is_scoped(self):
        refused = self.client.post(self.endpoint("/delete"), json={})
        self.assertEqual(refused.status_code, 400)
        self.assertTrue(self.project_dir.exists())
        mismatched = self.client.post(self.endpoint("/delete"), json={
            "confirm_project_id": self.project_id,
            "rel_path": "A Different Project",
        })
        self.assertEqual(mismatched.status_code, 400)
        self.assertTrue(self.project_dir.exists())

        response = self.client.post(self.endpoint("/delete"), json={
            "confirm_project_id": self.project_id,
            "rel_path": "Feature",
        })
        self.assertEqual(response.status_code, 200)
        self.assertFalse(self.project_dir.exists())
        self.assertTrue(self.projects_root.exists())

    def test_direct_multi_file_import_reuses_collision_safe_copy(self):
        source_dir = self.tmp / "native-selection"
        source_dir.mkdir()
        first = source_dir / "one.dat"
        second = source_dir / "two.dat"
        first.write_bytes(b"one")
        second.write_bytes(b"two")
        response = self.client.post(
            self.endpoint("/import/files"),
            json={"paths": [str(first), str(second), str(first)]})
        self.assertEqual(response.status_code, 200,
                         response.get_data(as_text=True))
        payload = response.get_json()
        self.assertTrue(payload["ok"])
        self.assertEqual(len(payload["imported"]), 2)
        self.assertEqual((self.project_dir / "one.dat").read_bytes(), b"one")
        self.assertEqual((self.project_dir / "two.dat").read_bytes(), b"two")

    def test_snapshot_saves_unique_verified_jpeg_to_project_canvas(self):
        first = self.client.post(self.endpoint("/snapshot"), json={
            "data_url": _image_data_url("JPEG")})
        second = self.client.post(self.endpoint("/snapshot"), json={
            "data_url": _image_data_url("JPEG")})
        self.assertEqual(first.status_code, 200, first.get_data(as_text=True))
        self.assertEqual(second.status_code, 200, second.get_data(as_text=True))
        self.assertEqual(first.get_json()["message"],
                         "project canvas saved to project folder")
        paths = list((self.project_dir / "project canvas").glob("*.jpg"))
        self.assertEqual(len(paths), 2)
        self.assertNotEqual(paths[0].name.casefold(), paths[1].name.casefold())
        self.assertTrue(all(path.read_bytes().startswith(b"\xff\xd8")
                            for path in paths))

    def test_snapshot_rejects_non_jpeg_data(self):
        response = self.client.post(self.endpoint("/snapshot"), json={
            "data_url": _image_data_url("PNG")})
        self.assertEqual(response.status_code, 400)


class TestWritingPdfExport(ProjectServerBase):
    def test_native_pdf_export_has_letter_media_box(self):
        destination = self.tmp / "exports" / "Draft"
        destination.parent.mkdir()
        page = _image_data_url("PNG", (1632, 2112))

        response = self.client.post("/api/writing/export-pdf", json={
            "path": str(destination), "pages": [page]})

        self.assertEqual(response.status_code, 200,
                         response.get_data(as_text=True))
        path = Path(response.get_json()["path"])
        self.assertEqual(path.suffix.lower(), ".pdf")
        pdf = path.read_bytes()
        self.assertTrue(pdf.startswith(b"%PDF"))
        self.assertRegex(pdf, rb"/MediaBox\s*\[\s*0\s+0\s+612(?:\.0)?\s+792(?:\.0)?\s*\]")

    def test_browser_pdf_export_is_an_attachment(self):
        response = self.client.post("/api/writing/export-pdf", json={
            "filename": "My Draft", "pages": [_image_data_url("PNG")]})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "application/pdf")
        self.assertIn("My Draft.pdf", response.headers.get(
            "Content-Disposition", ""))
        self.assertTrue(response.data.startswith(b"%PDF"))


if __name__ == "__main__":
    unittest.main()
