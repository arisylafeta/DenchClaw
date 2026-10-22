import unittest

from stock_opportunity_marketplace_sync import new_listings, plan, stock_row


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


    def test_new_listings_skip_linked_bundles_drafts_and_our_own_accounts(self):
        mk = lambda i, **kw: {"id": i, "listing_status": "published", "listing_kind": "individual", "reference": "1",
                              "accounts": {"name": "Seller"}, "listing_specs": [{"metadata_json": {}}], **kw}
        listings = [mk("a"), mk("b"), mk("c", listing_status="draft"), mk("d", accounts={"name": "ReBattery Sales"}),
                    mk("e", reference="bulk:x"), mk("f", listing_specs=[{"metadata_json": {"sourceUnits": [{}]}}])]
        self.assertEqual([l["id"] for l in new_listings(listings, {"b"})], ["a"])

    def test_stock_row_maps_specs(self):
        row = stock_row({"id": "x", "title": "Leaf 40kWh", "reference": "0012", "buy_now_price": 900, "currency": "GBP",
                         "published_at": "2026-10-01T10:00:00Z", "listing_specs": [{"format": "Pack", "quantity_available": 2,
                         "location_address": {"city": "Leeds", "country": "GB"}, "metadata_json": {"vin": "V1"}}]})
        self.assertEqual((row["quantity"], row["quantity_unit"], row["location"], row["supplier_ref"], row["observed_on"]),
                         (2, "pack", "Leeds, GB", "marketplace:0012", "2026-10-01"))


if __name__ == "__main__":
    unittest.main()
