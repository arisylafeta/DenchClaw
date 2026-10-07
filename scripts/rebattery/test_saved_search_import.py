import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("saved_search_import", Path(__file__).with_name("saved_search_import.py"))
saved = importlib.util.module_from_spec(spec)
spec.loader.exec_module(saved)


def search(**overrides):
    base = {
        "id": "8d0f6c1e-0000-4000-8000-000000000001", "email": "Jan@SolarBau.de", "label": "Tesla · Kokam · NMC · 80%+ health",
        "catalog_path": "/marketplace/listings?manufacturer=Tesla&chemistry=nmc&soh_min=80", "frequency": "daily",
        "status": "active", "confirmed_at": "2026-10-07T06:00:00+00:00",
        "filters": {"manufacturer": ["Tesla", "Kokam"], "chemistry": "nmc", "format": ["pack", "module"],
                    "condition": ["new", "great"], "soh_min": 80, "kwh_min": 30, "year_from": 2020,
                    "location_country": "DE", "q": "model 3", "buy_now_only": True,
                    "ppkwh_max": 60},
    }
    base.update(overrides)
    return base


class SavedSearchImportTest(unittest.TestCase):
    def test_maps_filters_onto_the_shared_buy_box_lists(self):
        row = saved.map_saved_search(search())
        self.assertEqual(row["kind"], "standing")
        self.assertEqual(row["basis"], "stated")
        self.assertEqual(row["email"], "jan@solarbau.de")
        self.assertEqual(row["wants"], "Tesla · Kokam · NMC · 80%+ health")
        self.assertEqual(row["spec"], {
            "chemistries": ["NMC"], "formats": ["Packs", "Modules"], "conditions": ["New or surplus"],
            "makes": ["Tesla"], "min_soh": 80, "kwh_min": 30,
        })
        self.assertEqual(row["source_id"], "saved_search:8d0f6c1e-0000-4000-8000-000000000001")
        self.assertEqual(row["source_label"], "Saved search")
        self.assertTrue(row["source_url"].startswith("https://www.rebattery.io/marketplace/listings?"))
        self.assertEqual(row["observed_on"], "2026-10-07")

    def test_keeps_what_does_not_map_in_the_note(self):
        note = saved.map_saved_search(search())["note"]
        self.assertIn("Searched for: model 3", note)
        self.assertIn("Brands: Kokam", note)
        self.assertIn("Condition grade: Great", note)
        self.assertIn("Made: 2020 to now", note)
        self.assertIn("Located in:", note)
        self.assertIn("Buy-now price only", note)
        self.assertIn("Price per kWh: up to 60", note)
        self.assertIn("alerts daily", note)

    def test_cell_makers_land_in_their_own_list(self):
        row = saved.map_saved_search(search(filters={"manufacturer": "CATL"}))
        self.assertEqual(row["spec"], {"cell_makers": ["CATL"]})

    def test_skips_unconfirmed_staff_and_test_saves(self):
        self.assertIsNone(saved.map_saved_search(search(confirmed_at=None)))
        self.assertIsNone(saved.map_saved_search(search(email="alex@rebattery.io")))
        self.assertIsNone(saved.map_saved_search(search(email="qa-buyer@example.com")))

    def test_marks_unsubscribed_searches_for_closing(self):
        self.assertTrue(saved.map_saved_search(search(status="unsubscribed"))["unsubscribed"])
        self.assertFalse(saved.map_saved_search(search(status="paused"))["unsubscribed"])


def request(**overrides):
    base = {
        "id": "2b7e0000-0000-4000-8000-000000000009", "email": "Jan@SolarBau.de", "wants": "Nissan Leaf 40kWh",
        "filters": {"q": "leaf", "chemistry": "nmc", "format": "pack", "soh_min": 80},
        "catalog_path": "/marketplace/listings?chemistry=nmc&format=pack&q=leaf&soh_min=80",
        "quantity": "few", "timing": "three_months", "target_price": 3000, "target_currency": "EUR",
        "country": "DE", "source": "search_suggestion", "status": "new", "created_at": "2026-10-08T12:00:00+00:00",
    }
    base.update(overrides)
    return base


class SourcingRequestImportTest(unittest.TestCase):
    def test_a_request_becomes_a_request_buy_box(self):
        row = saved.map_sourcing_request(request())
        self.assertEqual(row["kind"], "request")
        self.assertIsNone(row["basis"])
        self.assertEqual(row["email"], "jan@solarbau.de")
        self.assertEqual(row["wants"], "Nissan Leaf 40kWh")
        self.assertEqual(row["quantity"], "2 to 10 units")
        self.assertEqual(row["location"], "DE")
        self.assertEqual(row["spec"], {"chemistries": ["NMC"], "formats": ["Packs"], "min_soh": 80})
        # One format makes the per-unit price a per-pack price.
        self.assertEqual((row["max_price"], row["price_currency"], row["price_unit"]), (3000.0, "EUR", "pack"))
        self.assertEqual(row["source_id"], "sourcing_request:2b7e0000-0000-4000-8000-000000000009")
        self.assertEqual(row["source_label"], "Sourcing request")
        self.assertEqual(row["observed_on"], "2026-10-08")
        self.assertIn("Searched for: leaf", row["note"])
        self.assertIn("When: Within 3 months", row["note"])
        self.assertIn("from the search box", row["note"])

    def test_an_unclear_unit_keeps_the_price_in_the_note(self):
        row = saved.map_sourcing_request(request(filters={"q": "nissan leaf 40kwh"}, wants="nissan leaf 40kwh"))
        self.assertNotIn("max_price", row)
        self.assertIn("Target price: EUR 3,000.00 per unit", row["note"])
        # The search words are the request itself, so they aren't repeated.
        self.assertNotIn("Searched for", row["note"])

    def test_skips_staff_and_test_emails(self):
        self.assertIsNone(saved.map_sourcing_request(request(email="alex@rebattery.io")))


if __name__ == "__main__":
    unittest.main()
