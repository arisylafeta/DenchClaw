import datetime as dt
import importlib.util
import io
import json
import unittest
from pathlib import Path
from unittest import mock

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

    def test_marks_unsubscribed_searches_for_skipping(self):
        self.assertTrue(saved.map_saved_search(search(status="unsubscribed"))["unsubscribed"])
        self.assertFalse(saved.map_saved_search(search(status="paused"))["unsubscribed"])


def request(**overrides):
    base = {
        "id": "2b7e0000-0000-4000-8000-000000000009", "email": "Jan@SolarBau.de", "wants": "Nissan Leaf 40kWh",
        "details": "For a home storage build.\nOpen to other brands.",
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
        self.assertEqual(row["status"], "qualifying")
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
        self.assertTrue(row["note"].startswith("In their words: For a home storage build.\nOpen to other brands."))

    def test_an_unclear_unit_keeps_the_price_in_the_note(self):
        row = saved.map_sourcing_request(request(filters={"q": "nissan leaf 40kwh"}, wants="nissan leaf 40kwh"))
        self.assertNotIn("max_price", row)
        self.assertIn("Target price: EUR 3,000.00 per unit", row["note"])
        # The search words are the request itself, so they aren't repeated.
        self.assertNotIn("Searched for", row["note"])

    def test_skips_staff_and_test_emails(self):
        self.assertIsNone(saved.map_sourcing_request(request(email="alex@rebattery.io")))


class AnnouncementTest(unittest.TestCase):
    def row(self, **overrides):
        row = saved.map_sourcing_request(request(**overrides))
        row.update({"buyer": "ELG Battery", "company_id": "c1"})
        return row

    def test_tells_the_team_what_was_asked_for(self):
        note = saved.announcement(request(), self.row())
        lines = note.splitlines()
        self.assertEqual(lines[0], "**New sourcing request** · 2 to 10 units · Within 3 months · Germany")
        self.assertEqual(lines[1], "**Nissan Leaf 40kWh**")
        self.assertIn("> For a home storage build.", lines)
        self.assertIn("> Open to other brands.", lines)
        self.assertIn("Target: EUR 3,000 per pack", lines)
        self.assertIn("Buyer: jan@solarbau.de · ELG Battery (in CRM)", lines)
        # Angle brackets stop Discord from unfurling the link.
        self.assertTrue(lines[-1].startswith("<https://www.rebattery.io/marketplace/listings?"))

    def test_buyer_words_cannot_ping_the_channel(self):
        note = saved.announcement(request(wants="@everyone cheap", details="hi @here <@123>"),
                                  self.row(wants="@everyone cheap"))
        self.assertNotIn("@everyone", note)
        self.assertNotIn("@here", note)
        self.assertNotIn("<@123>", note)

    def test_long_details_are_cut(self):
        note = saved.announcement(request(details="x" * 900), self.row())
        self.assertIn("x" * 600 + "…", note)
        self.assertNotIn("x" * 601, note)

    def test_only_recent_requests_are_announced(self):
        now = dt.datetime(2026, 10, 8, 12, tzinfo=dt.timezone.utc)
        self.assertTrue(saved.is_recent(request(created_at="2026-10-08T00:00:00+00:00"), now))
        self.assertFalse(saved.is_recent(request(created_at="2026-10-06T00:00:00+00:00"), now))


class JulesRequestImportTest(unittest.TestCase):
    def jules(self, **overrides):
        return request(**{**dict(source="jules", conversation_id="conversation-1", catalog_path=None,
                                quantity=None, timing=None, filters={}, chemistry="LFP", format="Module",
                                capacity_text="280 Ah", quantity_text="First batch of 40 modules",
                                quantity_value=40, quantity_unit="modules", timing_text="Next month",
                                needed_by="2026-12-01", price_unit="kWh", target_price=55,
                                sourcing_consent=True, wants="B" * 2000), **overrides})

    def test_maps_jules_without_catalogue_enums(self):
        row = saved.map_sourcing_request(self.jules())
        self.assertEqual((row["kind"], row["basis"], row["status"]), ("request", None, "qualifying"))
        self.assertEqual(row["source_kind"], "jules")
        self.assertEqual(row["source_label"], "Jules")
        self.assertEqual(row["source_url"], "https://www.rebattery.io/operations/jules/conversation-1")
        self.assertEqual(row["quantity"], "First batch of 40 modules")
        self.assertEqual(row["needed_by"], "2026-12-01")
        self.assertEqual(row["spec"], {"chemistries": ["LFP"], "formats": ["Modules"]})
        self.assertEqual((row["max_price"], row["price_currency"], row["price_unit"]), (55.0, "EUR", "kWh"))
        self.assertEqual(row["wants"], "B" * 2000)
        self.assertIn("Capacity: 280 Ah", row["note"])
        self.assertIn("When: Next month", row["note"])
        self.assertNotIn("None", row["note"])

    def test_commercial_buy_request_keeps_stock_lines(self):
        lines = [{"groupKey": "grp_0123456789abcdef", "label": "Kia e-Niro 64 kWh pack", "quantity": 4, "targetPriceEur": 3900}]
        row = saved.map_sourcing_request(self.jules(request_kind="buy_request", stock_lines=lines))
        self.assertEqual(row["source_label"], "Jules commercial buyer")
        self.assertTrue(row["spec"]["commercial_buyer"])
        self.assertIn("Stock line: 4x Kia e-Niro 64 kWh pack at EUR 3,900 each (grp_0123456789abcdef)", row["note"])
        self.assertNotIn("commercial_buyer", saved.map_sourcing_request(self.jules())["spec"])

    def test_quantity_and_timing_fallbacks(self):
        row = saved.map_sourcing_request(self.jules(quantity_text=None, timing_text=None))
        self.assertEqual(row["quantity"], "40 modules")
        self.assertIn("When: 2026-12-01", row["note"])
        row = saved.map_sourcing_request(self.jules(quantity_text=None, quantity_value=None,
                                                   quantity_unit=None, timing_text=None, needed_by=None))
        self.assertIsNone(row["quantity"])
        self.assertNotIn("When:", row["note"])
        self.assertNotIn("None", row["note"])

    def test_unsupported_prices_stay_in_notes_even_with_pack_filter(self):
        for unit, currency, price in (("module", "EUR", 55), ("total", "USD", 55),
                                      ("tonne", "GBP", 55), ("pack", "CHF", 55), ("cell", "EUR", 0)):
            with self.subTest(unit=unit, currency=currency, price=price):
                row = saved.map_sourcing_request(self.jules(price_unit=unit, target_currency=currency,
                                                           target_price=price, filters={"format": "pack"}))
                self.assertNotIn("max_price", row)
                self.assertNotIn("price_currency", row)
                self.assertNotIn("price_unit", row)
                self.assertIn(f"per {unit}", row["note"])

    def test_unknown_chemistry_and_system_format_are_preserved(self):
        row = saved.map_sourcing_request(self.jules(chemistry="unlisted chemistry", format="System"))
        self.assertIn("Chemistry: unlisted chemistry", row["note"])
        self.assertTrue("Systems" in row["spec"].get("formats", []) or "Format: System" in row["note"])

    def test_announcement_uses_jules_fields_and_price_unit(self):
        req = self.jules(price_unit="module")
        row = saved.map_sourcing_request(req)
        note = saved.announcement(req, row)
        self.assertIn("First batch of 40 modules · Next month", note)
        self.assertIn("per module", note)
        self.assertNotIn("None", note)


class FetchTest(unittest.TestCase):
    def test_sourcing_select_works_before_and_after_migration(self):
        for rows in ([request()], [JulesRequestImportTest().jules()]):
            with self.subTest(source=rows[0]["source"]), mock.patch.object(saved, "fetch_platform", return_value=rows) as fetch:
                result = saved.fetch_sourcing_requests()
                fetch.assert_called_once_with("sourcing_requests", "*", {}, saved.PLATFORM_ENV)
                self.assertIsNotNone(saved.map_sourcing_request(result[0]))

    def test_reads_every_page(self):
        pages = [[{"id": i} for i in range(1000)], [{"id": 1000}, {"id": 1001}]]
        offsets = []

        def fake_open(req, timeout):
            offsets.append(int(dict(p.split("=") for p in req.full_url.split("?")[1].split("&"))["offset"]))
            return io.BytesIO(json.dumps(pages[len(offsets) - 1]).encode())

        with mock.patch.object(saved, "read_env_value", return_value="https://platform.example"), \
                mock.patch.object(saved.urllib.request, "urlopen", side_effect=fake_open):
            rows = saved.fetch_platform("sourcing_requests", "id", {})
        self.assertEqual(len(rows), 1002)
        self.assertEqual(offsets, [0, 1000])


if __name__ == "__main__":
    unittest.main()
