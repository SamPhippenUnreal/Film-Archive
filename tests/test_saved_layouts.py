import tempfile
import unittest
from pathlib import Path

from app.server import create_app
from app.store import Store
from tests.test_server_tags import FakeArchive, FakeStore, photo


class SavedLayoutTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = str(Path(self.temp.name) / 'archive.db')
        self.db = Store(self.path, None)
        self.addCleanup(self.db._conn.close)
        self.store = FakeStore([photo('a'), photo('b'), photo('c')], {})
        self.store.saved_layouts = self.db.saved_layouts
        self.store.change_saved_layouts = self.db.change_saved_layouts
        self.client = create_app(FakeArchive(self.store)).test_client()

    def save(self, **changes):
        body = dict(root='/fake', name='My layout', rows=3, ids=['c', 'a', 'b'])
        body.update(changes)
        return self.client.post('/api/layouts', json=body)

    def test_restore_membership_order_and_rows_after_restart(self):
        saved = self.save().get_json()['layouts'][0]
        reopened = Store(self.path, None)
        try:
            self.assertEqual(reopened.saved_layouts(), [saved])
        finally:
            reopened._conn.close()
        wall = self.client.get('/api/wall?layout=' + saved['id']).get_json()
        self.assertEqual(wall['savedLayout']['rows'], 3)
        self.assertEqual(wall['tagOrder'], ['c', 'a', 'b'])
        self.assertEqual(wall['shown'], 3)
        self.store._photos.pop()  # Deleted files are skipped without adding others.
        wall = self.client.get('/api/wall?layout=' + saved['id']).get_json()
        self.assertEqual(wall['shown'], 2)
        self.assertEqual({p['id'] for p in wall['clusters'][0]['photos']}, {'a', 'b'})

    def test_eleventh_save_replaces_oldest_and_delete_persists(self):
        for i in range(13):
            layouts = self.save(name=str(i)).get_json()['layouts']
        self.assertEqual([item['name'] for item in layouts], [str(i) for i in range(3, 13)])
        target = layouts[4]['id']
        response = self.client.post('/api/layouts/delete', json={'root': '/fake', 'id': target})
        self.assertEqual(len(response.get_json()['layouts']), 9)
        self.assertEqual(self.client.get('/api/wall?layout=' + target).status_code, 404)
        self.assertEqual(len(self.db.saved_layouts()), 9)
        count = self.db._conn.execute("SELECT count(*) FROM settings WHERE key LIKE 'saved-layouts%'").fetchone()[0]
        self.assertEqual(count, 1)

    def test_invalid_snapshots_and_wrong_archive_do_not_write(self):
        for change in [dict(name=' '), dict(name='x' * 101), dict(rows=True),
                       dict(rows=0), dict(rows=6), dict(ids=[]),
                       dict(ids=['a', 'a']), dict(ids=['missing'])]:
            self.assertEqual(self.save(**change).status_code, 400, change)
        self.assertEqual(self.save(root='/other').status_code, 409)
        self.assertEqual(self.client.post('/api/layouts/delete', json={'root': '/other', 'id': 'x'}).status_code, 409)
        self.assertEqual(self.db.saved_layouts(), [])

    def test_matching_name_overwrites_without_using_another_slot(self):
        for i in range(10):
            layouts = self.save(name=f'layout {i}').get_json()['layouts']
        original_id = layouts[0]['id']
        layouts = self.save(name=' Layout 0 ', rows=5, ids=['b', 'a']).get_json()['layouts']
        self.assertEqual(len(layouts), 10)
        self.assertEqual(layouts[-1], dict(id=original_id, name='Layout 0', rows=5, ids=['b', 'a']))
        self.assertEqual(layouts[0]['name'], 'layout 1')
        recalled = self.client.get('/api/wall?layout=' + original_id).get_json()
        self.assertEqual(recalled['tagOrder'], ['b', 'a'])
        self.assertEqual(recalled['savedLayout']['rows'], 5)
