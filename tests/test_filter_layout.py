import tempfile
import unittest
from pathlib import Path
from urllib.parse import urlencode
from app.metastore import MetaStore
from app.server import create_app, _filter_order_key
from tests.test_server_tags import FakeStore, FakeArchive, photo


class FilterLayoutTests(unittest.TestCase):
    def setUp(self):
        self.store = FakeStore([photo('a', 'roll1'), photo('b', 'roll2'), photo('c', 'roll3')],
            {'a': {'tags': ['trip'], 'rating': 5, 'camera': 'Leica', 'film': 'Portra', 'location': 'London'},
             'b': {'tags': ['trip'], 'rating': 4, 'camera': 'Leica', 'film': 'Portra', 'location': 'london'},
             'c': {'rating': 1, 'location': 'Paris'}}, {'a': 'mountain', 'b': 'mountain'})
        self.client = create_app(FakeArchive(self.store)).test_client()

    def test_each_filter_has_one_group_and_independent_saved_order(self):
        for filters, query in [({'tags': ['trip']}, {'tag': 'trip'}),
                               ({'stars': 4}, {'stars': 4}),
                               ({'camera': 'Leica'}, {'camera': 'Leica'}),
                               ({'film': 'Portra'}, {'film': 'Portra'}),
                               ({'q': 'mountain'}, {'q': 'mountain'}),
                               ({'tags': ['trip'], 'stars': 4, 'q': 'mountain'}, {'tag': 'trip', 'stars': 4, 'q': 'mountain'})]:
            with self.subTest(filters=filters):
                query = urlencode(query)
                wall = self.client.get('/api/wall?' + query).get_json()
                self.assertEqual(len(wall['clusters']), 1)
                self.assertEqual(set(p['id'] for p in wall['clusters'][0]['photos']), {'a', 'b'})
                response = self.client.post('/api/wall/order', json={'root': '/fake', 'filters': filters, 'ids': ['b', 'a']})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(self.client.get('/api/wall?' + query).get_json()['tagOrder'], ['b', 'a'])
        self.assertEqual(self.client.get('/api/wall').get_json()['tagOrder'], [])
        self.assertEqual(self.client.get('/api/wall?stars=5').get_json()['tagOrder'], [])

    def test_rejects_invalid_and_nonmatching_order(self):
        for filters, ids in [({'stars': 4}, ['c']), ({'camera': 'Leica'}, ['c']),
                             ({'film': 'Portra'}, ['c']), ({'q': 'mountain'}, ['c']),
                             ({}, ['a']), ({'stars': '4'}, ['a']), ({'stars': 6}, ['a']),
                             ({'q': 'mountain'}, ['a', 'a']), ({'tags': ['trip']}, ['unknown'])]:
            with self.subTest(filters=filters, ids=ids):
                self.assertEqual(self.client.post('/api/wall/order', json={'root': '/fake', 'filters': filters, 'ids': ids}).status_code, 400)
        self.assertEqual(self.client.post('/api/wall/order', json={'root': '/different', 'filters': {'stars': 4}, 'ids': ['a']}).status_code, 409)

    def test_filter_keys_canonical_search_and_case_sensitive_gear(self):
        self.assertEqual(_filter_order_key(['TRIP'], q=' Mountain  sky '), _filter_order_key(['trip'], q='mountain sky'))
        self.assertNotEqual(_filter_order_key([], camera='Leica'), _filter_order_key([], camera='leica'))
        self.assertEqual(_filter_order_key(['TRIP']), ['trip'])

    def test_locations_are_deduplicated_and_reflect_saved_metadata(self):
        self.assertEqual(self.client.get('/api/locations').get_json(), ['London', 'Paris'])
        self.store._flags['c']['location'] = 'Oslo'
        self.assertEqual(self.client.get('/api/locations').get_json(), ['London', 'Oslo'])
        with tempfile.TemporaryDirectory() as directory:
            meta = MetaStore(str(Path(directory) / 'metadata'))
            meta.set_meta('a', {'location': 'Kyoto'})
            self.assertEqual(meta.meta_flags()['a']['location'], 'Kyoto')
            reopened = MetaStore(str(Path(directory) / 'metadata'))
            self.assertEqual(reopened.meta_flags()['a']['location'], 'Kyoto')


if __name__ == '__main__':
    unittest.main()
