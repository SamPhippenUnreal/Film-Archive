"""Tests for the Writing Mode document store (DocStore): a second cache domain,
kept strictly separate from the image-archive metadata, backed up by the same
crash-safe write-ahead machinery.
"""
import json
import os
import tempfile
import shutil
import unittest

from app.docstore import DocStore
from app.metastore import MetaStore


class DocBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="fa_doc_")
        self.docs = os.path.join(self.tmp, "cache", "documents")
        self.backup = os.path.join(self.tmp, "writing_backup")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def store(self):
        return DocStore(self.docs, local_dir=self.backup)

    def fail_cache_writes(self, ds):
        real = DocStore._atomic_write
        docs_root = os.path.abspath(self.docs)

        def failing(path, data):
            if os.path.abspath(path).startswith(docs_root):
                raise OSError("simulated cache offline")
            real(path, data)
        ds._atomic_write = failing


class TestCrud(DocBase):
    def test_create_and_get(self):
        ds = self.store()
        doc = ds.create_doc({"content": "<p>hello</p>", "rating": 3})
        self.assertTrue(doc["id"])
        self.assertEqual(doc["rating"], 3)
        got = ds.get_doc(doc["id"])
        self.assertEqual(got["content"], "<p>hello</p>")
        self.assertEqual(got["rating"], 3)

    def test_save_merges_and_persists(self):
        ds = self.store()
        doc = ds.create_doc()
        ds.save_doc(doc["id"], {"content": "<p>text</p>"})
        ds.save_doc(doc["id"], {"rating": 5, "tags": "beach, sunset"})
        got = ds.get_doc(doc["id"])
        self.assertEqual(got["content"], "<p>text</p>")   # merge kept content
        self.assertEqual(got["rating"], 5)
        self.assertEqual(got["tags"], "beach, sunset")

    def test_list_newest_first(self):
        ds = self.store()
        a = ds.create_doc({"content": "a"})
        b = ds.create_doc({"content": "b"})
        ids = [d["id"] for d in ds.list_docs()]
        self.assertEqual(ids[0], b["id"])   # newest at the front of the line
        self.assertIn(a["id"], ids)

    def test_duplicate_is_independent(self):
        ds = self.store()
        a = ds.create_doc({"content": "<p>orig</p>", "rating": 4,
                           "tags": "x", "groups": {"g1": {"images": ["p1"],
                                                          "bw": True,
                                                          "layout": 2}}})
        dup = ds.duplicate_doc(a["id"])
        self.assertNotEqual(dup["id"], a["id"])
        self.assertEqual(dup["content"], "<p>orig</p>")
        self.assertEqual(dup["groups"]["g1"]["bw"], True)
        # editing the copy leaves the original untouched
        ds.save_doc(dup["id"], {"content": "<p>changed</p>"})
        self.assertEqual(ds.get_doc(a["id"])["content"], "<p>orig</p>")

    def test_delete_is_permanent_and_not_resurrected(self):
        ds = self.store()
        a = ds.create_doc({"content": "<p>bye</p>"})
        ds.delete_doc(a["id"])
        self.assertIsNone(ds.get_doc(a["id"]))
        # a fresh store must not replay the deleted doc back from the backup
        ds2 = self.store()
        self.assertIsNone(ds2.get_doc(a["id"]))
        self.assertEqual([d["id"] for d in ds2.list_docs()], [])


class TestRobustness(DocBase):
    def test_malformed_fields_ignored(self):
        ds = self.store()
        doc = ds.create_doc({"content": "<p>ok</p>", "rating": "not-a-number",
                             "groups": "nope", "bogus": "dropped"})
        got = ds.get_doc(doc["id"])
        self.assertEqual(got["rating"], 0)          # bad rating fell back
        self.assertEqual(got["groups"], {})         # bad groups ignored
        self.assertNotIn("bogus", got)              # unknown key never stored

    def test_missing_folder_lists_empty(self):
        ds = self.store()
        self.assertEqual(ds.list_docs(), [])

    def test_corrupt_document_skipped_in_list(self):
        ds = self.store()
        ds.create_doc({"content": "<p>good</p>"})
        with open(os.path.join(self.docs, "broken.json"), "w",
                  encoding="utf-8") as f:
            f.write("{not valid json")
        # the corrupt file must not crash listing; the good doc still appears
        docs = ds.list_docs()
        self.assertEqual(len(docs), 1)

    def test_doc_text_strips_html(self):
        text = DocStore.doc_text({"content": "<p>Hello <b>World</b></p>",
                                  "tags": "Seaside"})
        self.assertIn("hello", text)
        self.assertIn("world", text)
        self.assertIn("seaside", text)
        self.assertNotIn("<", text)


class TestBackupSeparation(DocBase):
    def test_commit_backs_up_before_cache(self):
        ds = self.store()
        doc = ds.create_doc({"content": "<p>safe</p>"})
        bp = os.path.join(self.backup, "documents", doc["id"] + ".json")
        self.assertTrue(os.path.exists(bp))
        self.assertEqual(ds._journal.counts()["verified"], 1)

    def test_cache_failure_keeps_edit_and_replays(self):
        ds = self.store()
        self.fail_cache_writes(ds)
        # create_doc's cache write fails, but the backup keeps it
        doc_id = None
        try:
            doc = ds.create_doc({"content": "<p>survive</p>"})
            doc_id = doc["id"]
        except OSError:
            self.fail("create must not raise when a backup copy exists")
        self.assertFalse(os.path.exists(
            os.path.join(self.docs, doc_id + ".json")))
        self.assertEqual(ds._journal.counts()["pending"], 1)
        # restart with a working cache replays the pending edit
        ds2 = self.store()
        got = ds2.get_doc(doc_id)
        self.assertIsNotNone(got)
        self.assertEqual(got["content"], "<p>survive</p>")

    def test_writing_domain_is_separate_from_image_metadata(self):
        # a MetaStore and a DocStore over the same shared cache root use
        # different subtrees and different backup roots — never mixing state
        cache = os.path.join(self.tmp, "cache")
        ms = MetaStore(cache, local_dir=os.path.join(self.tmp, "backup"))
        ms.set_meta("p1", {"title": "photo note"})
        ds = self.store()   # documents/ under the same cache
        ds.create_doc({"content": "<p>doc</p>"})
        # image metadata lives under photos/, documents under documents/
        self.assertTrue(os.path.isdir(os.path.join(cache, "photos")))
        self.assertTrue(os.path.isdir(os.path.join(cache, "documents")))
        # neither store sees the other's records
        self.assertEqual(ms.get_meta("p1")["title"], "photo note")
        self.assertEqual(len(ds.list_docs()), 1)

    def test_works_without_backup_folder(self):
        ds = DocStore(self.docs)
        doc = ds.create_doc({"content": "<p>plain</p>"})
        self.assertEqual(ds.get_doc(doc["id"])["content"], "<p>plain</p>")


if __name__ == "__main__":
    unittest.main()
