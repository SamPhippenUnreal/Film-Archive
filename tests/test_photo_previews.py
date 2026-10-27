import concurrent.futures
import hashlib
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from PIL import Image
from app.previews import PreviewCache
from app.scanner import Scanner
from app.server import create_app


class PhotoPreviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'scan.tiff'
        Image.new('RGB', (1800, 1200), (40, 80, 120)).save(self.source)
        self.cache = PreviewCache(str(self.root / 'previews'))
        self.hash = hashlib.sha256(self.source.read_bytes()).digest()

    def tearDown(self):
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).digest(), self.hash)
        self.temp.cleanup()

    def test_levels_and_full_resolution(self):
        for edge, size in [(1024, (1024, 683)), (2048, (1800, 1200)), (None, (1800, 1200))]:
            with Image.open(self.cache.path(str(self.source), 'photo', edge)) as image:
                self.assertEqual(image.size, size)

    def test_unchanged_preview_reused_across_cache_instances(self):
        path = self.cache.path(str(self.source), 'photo', 1024)
        before = Path(path).read_bytes()
        stamp = os.stat(path).st_mtime_ns
        other = PreviewCache(self.cache.directory)
        with patch('app.previews.ImageOps.exif_transpose', side_effect=AssertionError('unnecessary source decode')):
            self.assertEqual(other.path(str(self.source), 'photo', 1024), path)
        self.assertEqual(os.stat(path).st_mtime_ns, stamp)
        self.assertEqual(Path(path).read_bytes(), before)

    def test_changed_source_overwrites_same_slot(self):
        path = self.cache.path(str(self.source), 'photo', 1024)
        before = Path(path).read_bytes()
        Image.new('RGB', (1800, 1200), 'red').save(self.source)
        self.hash = hashlib.sha256(self.source.read_bytes()).digest()
        self.assertEqual(self.cache.path(str(self.source), 'photo', 1024), path)
        self.assertNotEqual(Path(path).read_bytes(), before)
        self.assertEqual(len(list(Path(self.cache.directory).glob('*'))), 1)

    def test_concurrent_same_photo_decodes_once(self):
        from app.previews import ImageOps
        with patch('app.previews.ImageOps.exif_transpose', wraps=ImageOps.exif_transpose) as decode:
            with concurrent.futures.ThreadPoolExecutor(4) as pool:
                paths = list(pool.map(lambda _: self.cache.path(str(self.source), 'photo', 1024), range(4)))
        self.assertEqual(sum(not call.kwargs.get('in_place', False) for call in decode.call_args_list), 1)
        self.assertEqual(len(set(paths)), 1)

    def test_eviction_removes_only_disposable_previews(self):
        path = self.cache.path(str(self.source), 'photo', 1024)
        self.cache.budget = os.path.getsize(path) + 10
        metadata = Path(self.cache.directory) / 'notes.json'
        metadata.write_text('keep me')
        newer = self.cache.path(str(self.source), 'other', 1024)
        self.assertFalse(os.path.exists(path))
        self.assertTrue(os.path.exists(newer))
        self.assertEqual(metadata.read_text(), 'keep me')
        self.assertLessEqual(sum(p.stat().st_size for p in Path(self.cache.directory).glob('*.jpg')), self.cache.budget)

    def test_disk_budget_covers_legacy_thumbnails(self):
        thumbs = self.root / 'thumbs'
        thumbs.mkdir()
        legacy = thumbs / 'old.jpg'
        legacy.write_bytes(b'x' * 50000)
        os.utime(legacy, (1, 1))
        cache = PreviewCache(self.cache.directory, budget=60000, extra_dirs=(str(thumbs),))
        cache.path(str(self.source), 'photo', 1024)
        cache.path(str(self.source), 'other', 1024)
        self.assertFalse(legacy.exists())
        total = sum(p.stat().st_size for directory in [thumbs, Path(cache.directory)] for p in directory.glob('*.jpg'))
        self.assertLessEqual(total, cache.budget)

    def test_evicted_thumbnail_is_regenerated_on_demand(self):
        source = self.source
        class Store:
            def get_photo(self, pid):
                return {'id': 'photo', 'rel_path': source.name} if pid == 'photo' else None
        scanner = Scanner(str(self.root), Store(), str(self.root / 'data'))
        self.assertFalse(os.path.exists(scanner.thumb_path('photo')))
        path = scanner.ensure_thumb('photo')
        with Image.open(path) as image:
            self.assertEqual(max(image.size), 512)
        self.assertEqual(scanner.thumb_path('photo'), path)
        with patch('app.previews.ImageOps.exif_transpose', side_effect=AssertionError('redundant decode')):
            self.assertEqual(scanner.ensure_thumb('photo'), path)

    def test_http_wall_lod_and_full_inspection(self):
        source = self.source
        class Store:
            def get_photo(self, pid):
                return {'id': 'photo', 'rel_path': source.name} if pid == 'photo' else None
        class Archive:
            store = Store()
            scanner = Scanner(str(self.root), store, str(self.root / 'data'))
        client = create_app(Archive()).test_client()
        import io
        response = client.get('/image/photo?edge=1024')
        self.assertEqual(response.status_code, 200)
        with Image.open(io.BytesIO(response.data)) as image:
            self.assertEqual(image.size, (1024, 683))
        response.close()
        response = client.get('/image/photo')
        with Image.open(io.BytesIO(response.data)) as image:
            self.assertEqual(image.size, (1800, 1200))
        response.close()
        self.assertEqual(client.get('/image/photo?edge=999999').status_code, 400)
        self.assertEqual(client.get('/image/missing?edge=1024').status_code, 404)


if __name__ == '__main__':
    unittest.main()
