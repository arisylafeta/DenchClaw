import unittest

from stock_opportunity_marketplace_sync import bundle_links, details_v1, new_listings, plan, stock_row


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

    def test_stale_and_rejected_rows_keep_their_status_unless_live_again(self):
        rows = [
            {"id": "s", "status": "stale", "marketplace_status": "withdrawn", "marketplace_listing_id": "m1"},
            {"id": "r", "status": "rejected", "marketplace_status": None, "marketplace_listing_id": None},
            {"id": "p", "status": "rejected", "marketplace_status": "draft", "marketplace_listing_id": "m3"},
        ]
        statuses = {"m1": "withdrawn", "m3": "published"}
        self.assertEqual(plan(rows, statuses), [
            ("r", "rejected", "missing", "rejected", None),
            ("p", "listed", "published", "rejected", "draft"),
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


    def test_bundle_units_link_stock_rows_by_supplier_tag(self):
        listings = [{"id": "m1", "listing_specs": [{"metadata_json": {"sourceUnits": [{"sourceReference": "0012090971"}, {"sourceReference": "999"}]}}]},
                    {"id": "m2", "listing_specs": [{"metadata_json": {"sourceUnits": [{"sourceReference": "12090971"}]}}]}]
        self.assertEqual(bundle_links(listings, {"12090971": ["s1"]}, {"m1": "deal1"}), [("s1", "deal1")])


if __name__ == "__main__":
    unittest.main()


class DetailsV1(unittest.TestCase):
    def test_marketplace_facts_land_on_schema_keys_with_their_source(self):
        spec = {"manufacturer": "Nissan", "model": "Leaf", "format": "Pack", "chemistry": "NMC", "pack_kwh": 40,
                "year_manufacture": 2019, "soh": None, "metadata_json": {"partNumber": "295B0-5SA0A"}}
        details = details_v1(spec, {"seo_slug": "nissan-leaf-40"})
        self.assertEqual(details["format"], "pack")
        self.assertEqual(details["part_numbers"], ["295B0-5SA0A"])
        self.assertEqual(details["capacity_basis"], "marketed")
        self.assertEqual(details["marketplace"], {"slug": "nissan-leaf-40"})
        self.assertNotIn("part_number", details)
        self.assertNotIn("soh_percent", details)
        self.assertEqual(set(details["field_source"]), {"make", "model", "format", "chemistry", "capacity_kwh", "capacity_basis", "year", "part_numbers"})
