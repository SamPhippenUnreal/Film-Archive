"""HTTP contract tests for the Project workspace.

The real ProjectStore is used behind lightweight archive adapters.  Every
source and destination is a temporary directory, so the suite cannot touch a
folder linked in the desktop application.
"""
import base64
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from urllib.parse import quote

from app.projectstore import ProjectStore
from app.server import create_app


_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8A"
    "AQUBAScY42YAAAAASUVORK5CYII="
)


class FakePhotoStore:
    def __init__(self, photos):
        self.photos = photos

    def get_photo(self, photo_id):
        photo = self.photos.get(photo_id)
        return dict(photo) if photo else None


class FakeScanner:
    @staticmethod
    def display_path(photo):
        return photo["path"]


class FakeArchive:
    def __init__(self, root, photos=None):
        self.root = str(root)
        self.store = FakePhotoStore(photos or {})
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
                           "name": "Draft.docx"},
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


if __name__ == "__main__":
    unittest.main()
