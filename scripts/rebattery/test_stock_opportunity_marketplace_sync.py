import unittest

from stock_opportunity_marketplace_sync import plan


class Plan(unittest.TestCase):
    def test_published_is_listed_and_anything_else_or_gone_is_an_opportunity(self):
        rows = [
            {"id": "a", "status": "listed", "marketplace_status": "published", "marketplace_listing_id": "m1"},
            {"id": "b", "status": "listed", "marketplace_status": "published", "marketplace_listing_id": "m2"},
            {"id": "c", "status": "opportunity", "marketplace_status": "draft", "marketplace_listing_id": "m3"},
            {"id": "d", "status": "listed", "marketplace_status": "published", "marketplace_listing_id": "m4"},
        ]
        statuses = {"m1": "published", "m2": "completed", "m3": "published"}
        self.assertEqual(plan(rows, statuses), [
            ("b", "opportunity", "completed", "listed", "published"),
            ("c", "listed", "published", "opportunity", "draft"),
            ("d", "opportunity", "missing", "listed", "published"),
        ])


if __name__ == "__main__":
    unittest.main()
