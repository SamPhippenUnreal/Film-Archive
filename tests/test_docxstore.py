"""Tests for the folder-backed .docx Writing store and its write-ahead backup.

Exercises the HTML<->docx round trip (text formatting, bullet lists, embedded
images), the folder CRUD (a document IS a .docx on disk), and the backup that
stages a durable local copy, verifies the linked folder holds it, then purges —
including crash recovery via reconcile().
"""
import io
import os
import tempfile
import unittest

from docx import Document

from app import docxstore
from app.docxstore import (DocxStore, html_to_docx_bytes, docx_bytes_to_html)


def _png_bytes():
    from PIL import Image
    im = Image.new("RGB", (8, 8), (200, 120, 60))
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


class TestHtmlDocxRoundTrip(unittest.TestCase):
    def test_text_and_formatting_round_trip(self):
        html = ("<div>Hello <b>bold</b> and <i>italic</i> and <u>under</u>.</div>"
                "<ul><li>one</li><li>two</li></ul>")
        data = html_to_docx_bytes(html)
        # it is a real, openable .docx
        doc = Document(io.BytesIO(data))
        text = " ".join(p.text for p in doc.paragraphs)
        self.assertIn("Hello", text)
        self.assertIn("bold", text)
        self.assertIn("one", text)
        self.assertIn("two", text)
        # bold/italic/underline survive as runs
        runs = [r for p in doc.paragraphs for r in p.runs]
        self.assertTrue(any(r.bold and "bold" in r.text for r in runs))
        self.assertTrue(any(r.italic and "italic" in r.text for r in runs))
        self.assertTrue(any(r.underline and "under" in r.text for r in runs))
        # and back to html, the list and text return
        back = docx_bytes_to_html(data)
        self.assertIn("<li>", back)
        self.assertIn("bold", back)

    def test_embedded_image_round_trips_to_data_uri(self):
        png = _png_bytes()
        html = '<div>see <img src="/image/abc"></div>'
        data = html_to_docx_bytes(html, {"/image/abc": (png, "png")})
        # the image is embedded in the docx package
        doc = Document(io.BytesIO(data))
        image_parts = [p for p in doc.part.package.iter_parts()
                       if "image" in (p.content_type or "")]
        self.assertTrue(image_parts, "expected an embedded image part")
        # reading it back yields an inline data: URI image
        back = docx_bytes_to_html(data)
        self.assertIn("<img", back)
        self.assertIn("data:image", back)

    def test_data_uri_image_embeds_without_a_resolver(self):
        import base64
        png = _png_bytes()
        uri = "data:image/png;base64," + base64.b64encode(png).decode()
        data = html_to_docx_bytes(f'<div><img src="{uri}"></div>')
        doc = Document(io.BytesIO(data))
        image_parts = [p for p in doc.part.package.iter_parts()
                       if "image" in (p.content_type or "")]
        self.assertTrue(image_parts)


class TestImageDownscaling(unittest.TestCase):
    """A full-resolution photograph embedded verbatim makes a many-megabyte
    .docx that every save rewrites and every open re-encodes; embedding is
    capped to a document-appropriate size instead."""

    def _jpeg(self, w, h):
        from PIL import Image
        im = Image.new("RGB", (w, h), (120, 160, 90))
        buf = io.BytesIO()
        im.save(buf, format="JPEG", quality=95)
        return buf.getvalue()

    def _embedded(self, data):
        from PIL import Image
        doc = Document(io.BytesIO(data))
        for p in doc.part.related_parts.values():
            if "image" in (getattr(p, "content_type", "") or ""):
                return Image.open(io.BytesIO(p.blob)), p.content_type
        return None, None

    def test_oversized_image_is_capped(self):
        import base64
        uri = ("data:image/jpeg;base64,"
               + base64.b64encode(self._jpeg(3200, 2000)).decode())
        data = html_to_docx_bytes(f'<div><img src="{uri}"></div>')
        im, _ = self._embedded(data)
        self.assertLessEqual(max(im.size), docxstore.EMBED_MAX_DIM)
        # aspect ratio is preserved
        self.assertAlmostEqual(im.size[0] / im.size[1], 3200 / 2000, places=2)

    def test_within_cap_image_is_left_untouched(self):
        # a small image is embedded verbatim — not resized, not recompressed to
        # a different format (so no needless generation loss)
        import base64
        uri = ("data:image/png;base64,"
               + base64.b64encode(_png_bytes()).decode())
        data = html_to_docx_bytes(f'<div><img src="{uri}"></div>')
        im, ct = self._embedded(data)
        self.assertEqual(im.size, (8, 8))
        self.assertIn("png", ct)

    def test_downscaling_is_idempotent(self):
        # re-saving an already-capped document does not shrink it further
        import base64
        uri = ("data:image/jpeg;base64,"
               + base64.b64encode(self._jpeg(3200, 2000)).decode())
        once = html_to_docx_bytes(f'<div><img src="{uri}"></div>')
        twice = html_to_docx_bytes(docx_bytes_to_html(once))
        self.assertEqual(self._embedded(once)[0].size,
                         self._embedded(twice)[0].size)


class TestDocxStoreCrud(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.folder = os.path.join(self.tmp, "docs")
        self.backup = os.path.join(self.tmp, "writing_backup")
        self.store = DocxStore(self.folder, local_dir=self.backup)

    def _docx_files(self):
        return sorted(n for n in os.listdir(self.folder)
                      if n.lower().endswith(".docx"))

    def test_create_writes_a_docx_file(self):
        doc = self.store.create_doc({"content": "<div>first note</div>"})
        self.assertTrue(doc["filename"].endswith(".docx"))
        self.assertIn(doc["filename"], self._docx_files())
        self.assertIn("first note", doc["content"])

    def test_save_updates_the_same_file_and_delete_removes_it(self):
        doc = self.store.create_doc({"content": "<div>draft</div>"})
        did = doc["id"]
        self.store.save_doc(did, {"content": "<div>revised text</div>"})
        got = self.store.get_doc(did)
        self.assertIn("revised text", got["content"])
        self.assertEqual(len(self._docx_files()), 1)   # same file, not a new one
        self.store.delete_doc(did)
        self.assertEqual(self._docx_files(), [])
        self.assertIsNone(self.store.get_doc(did))

    def test_dropped_in_docx_appears_as_a_document(self):
        # a file authored elsewhere, dropped straight into the folder
        d = Document()
        d.add_paragraph("written in Word")
        d.save(os.path.join(self.folder, "From Word.docx"))
        docs = self.store.list_docs()
        titles = {x["title"] for x in docs}
        self.assertIn("From Word", titles)
        match = next(x for x in docs if x["title"] == "From Word")
        self.assertIn("written in Word", match["content"])

    def test_unique_names_avoid_clobbering(self):
        a = self.store.create_doc({"content": "<div>a</div>"})
        b = self.store.create_doc({"content": "<div>b</div>"})
        self.assertNotEqual(a["filename"], b["filename"])
        self.assertEqual(len(self._docx_files()), 2)

    def test_save_returns_light_metadata_but_file_has_content(self):
        # the editor discards the save response, so save_doc skips the expensive
        # re-read+reparse and returns light metadata — the document on disk still
        # holds the new content, readable back through get_doc
        did = self.store.create_doc({"content": "<div>alpha</div>"})["id"]
        res = self.store.save_doc(did, {"content": "<div>beta text</div>"})
        self.assertEqual(res["content"], "")
        self.assertEqual(res["id"], did)
        self.assertIn("beta text", self.store.get_doc(did)["content"])

    def test_read_reflects_a_file_changed_on_disk(self):
        # the docx->html shape is cached, but keyed by the file's mtime+size, so
        # a document rewritten outside the app (in Word, or by another instance)
        # is re-read rather than served stale from the cache
        doc = self.store.create_doc({"content": "<div>one</div>"})
        did = doc["id"]
        self.assertIn("one", self.store.get_doc(did)["content"])   # caches it
        import time
        time.sleep(0.02)
        docxstore._atomic_write_bytes(
            os.path.join(self.folder, doc["filename"]),
            html_to_docx_bytes("<div>a wholly different body</div>"))
        self.assertIn("wholly different", self.store.get_doc(did)["content"])


class TestWritingBackup(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.folder = os.path.join(self.tmp, "docs")
        self.backup_dir = os.path.join(self.tmp, "writing_backup")

    def test_backup_purges_after_a_confirmed_commit(self):
        store = DocxStore(self.folder, local_dir=self.backup_dir)
        store.create_doc({"content": "<div>safe</div>"})
        # once the linked folder holds the file, the local copy is gone
        journal = os.path.join(self.backup_dir, "journal")
        docs = os.path.join(self.backup_dir, "docs")
        self.assertEqual([n for n in os.listdir(journal)
                          if n.endswith(".json")], [])
        self.assertEqual([n for n in os.listdir(docs)
                          if n.endswith(".docx")], [])

    def test_reconcile_replays_a_staged_file_the_folder_is_missing(self):
        # simulate a crash: bytes staged locally, never written to the folder
        os.makedirs(os.path.join(self.backup_dir, "docs"), exist_ok=True)
        os.makedirs(os.path.join(self.backup_dir, "journal"), exist_ok=True)
        data = html_to_docx_bytes("<div>recovered</div>")
        name = "Recovered.docx"
        docxstore._atomic_write_bytes(
            os.path.join(self.backup_dir, "docs", name), data)
        docxstore._atomic_write_json(
            os.path.join(self.backup_dir, "journal", name + ".json"),
            {"name": name, "checksum": docxstore._sha(data),
             "ts": 0, "state": "pending"})
        # launching the store reconciles: the folder gets the file, backup purges
        store = DocxStore(self.folder, local_dir=self.backup_dir)
        self.assertTrue(os.path.exists(os.path.join(self.folder, name)))
        self.assertEqual([n for n in os.listdir(
            os.path.join(self.backup_dir, "journal")) if n.endswith(".json")], [])
        # and it is readable as a document
        got = store.get_doc("Recovered")
        self.assertIsNotNone(got)
        self.assertIn("recovered", got["content"])


if __name__ == "__main__":
    unittest.main()
