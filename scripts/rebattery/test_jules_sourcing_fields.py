import unittest
from unittest.mock import patch
import saved_search_import as saved

FIXTURE = {"id":"d571610c-975b-4650-bbbf-6cafe8900410","email":"qa+x-buyer@qa.rebattery.io","wants":"LFP battery packs for a stationary storage project in the UK. Mixed formats acceptable if they are LFP and suitable for stationary storage. Target price around £60 per kWh.","filters":{},"quantity":None,"timing":None,"target_price":60,"target_currency":"GBP","country":None,"source":"jules","chemistry":"LFP","format":"Pack","capacity_text":"About 500 kWh total, UK delivery","quantity_text":"About 500 kWh total","quantity_value":500,"quantity_unit":"kWh","timing_text":"Needed by March 2027","needed_by":"2027-03-01","price_unit":"kWh","conversation_id":"c8f204b4-c0e9-4ac2-87c5-39c818901883","created_at":"2026-10-22T16:38:48+00:00","status":"new"}


class JulesFieldsTests(unittest.TestCase):
    def test_real_staging_shape(self):
        row = saved.map_sourcing_request(FIXTURE)
        self.assertEqual(row['quantity'], 'About 500 kWh total')
        self.assertEqual(row['needed_by'], '2027-03-01')
        self.assertEqual(row['spec'], {'chemistries': ['LFP'], 'formats': ['Packs']})
        self.assertEqual((row['max_price'], row['price_currency'], row['price_unit']), (60, 'GBP', 'kWh'))
        self.assertIn('Capacity: About 500 kWh total, UK delivery', row['note'])
        self.assertIn('When: Needed by March 2027', row['note'])
        self.assertIsNone(row['location'])
        self.assertEqual(row['source_id'], 'sourcing_request:' + FIXTURE['id'])

    def test_jules_country_and_numeric_quantity_fallback(self):
        row = saved.map_sourcing_request({**FIXTURE, 'country': 'GB', 'quantity_text': None})
        self.assertEqual(row['location'], 'United Kingdom')
        self.assertEqual(row['quantity'], '500 kWh')

    def test_legacy_request_and_saved_search_unchanged(self):
        row = saved.map_sourcing_request({'id': 'legacy', 'email': 'buyer@example.com',
            'wants': 'Packs', 'quantity': 'few', 'timing': 'now', 'country': 'GB',
            'created_at': '2026-10-22', 'filters': {'format': 'pack'}, 'source': 'no_results'})
        self.assertEqual((row['quantity'], row['location'], row['source_kind']), ('2 to 10 units', 'GB', 'import'))
        self.assertIn('When: Now', row['note'])
        row = saved.map_saved_search({'id': 'saved', 'email': 'buyer@example.com',
            'confirmed_at': '2026-10-22', 'filters': {'format': 'pack'}})
        self.assertEqual((row['kind'], row['spec'], row['source_id']), ('standing', {'formats': ['Packs']}, 'saved_search:saved'))

    def test_internal_rebattery_address_skipped(self):
        self.assertIsNone(saved.map_sourcing_request({**FIXTURE, 'email': 'qa+buyer@rebattery.io'}))

    def test_fetch_includes_new_columns(self):
        with patch.object(saved, 'fetch_platform', return_value=[]) as fetch:
            saved.fetch_sourcing_requests('unused')
        selected = fetch.call_args.args[1]
        self.assertTrue(selected == '*' or all(key in selected.split(',') for key in
            ('chemistry', 'format', 'capacity_text', 'quantity_text', 'quantity_value', 'quantity_unit',
             'timing_text', 'needed_by', 'price_unit', 'country', 'sourcing_consent', 'conversation_id')))
