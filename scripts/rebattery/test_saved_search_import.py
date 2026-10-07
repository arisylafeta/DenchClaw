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


if __name__ == "__main__":
    unittest.main()
