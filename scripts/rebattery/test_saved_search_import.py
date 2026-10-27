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


class GateTest(unittest.TestCase):
    def verdict(self, wants, quantity="one", details=None, **extra):
        return saved.gate({"wants": wants, "details": details, "quantity": quantity, **extra})[0]

    def test_the_seven_real_requests(self):
        self.assertEqual(self.verdict("Ig chem e101Ah", "many"), "unknown")
        self.assertEqual(self.verdict("21700 18650", "many", "ilosc 100000 sztuk."), "pass")
        self.assertEqual(self.verdict("Hyundai Kona 2018-2023 64 kWh", "many", "Energy storage"), "pass")
        self.assertEqual(self.verdict("sdfdsfsdf", "one", "xcvxcvcxv"), "unknown")
        self.assertEqual(self.verdict("nissan leaf 40kwh pack", "one", "I need 8 modules in total."), "below")
        self.assertEqual(self.verdict("Nissan", "one", "62kwh"), "below")
        self.assertEqual(self.verdict("60 volt 20 ahlithium", "one"), "below")

    def test_threshold_and_units(self):
        self.assertEqual(saved.gate({"wants": "40 kWh pack", "quantity": "few"})[1], 80)
        self.assertEqual(self.verdict("40 kWh pack", "many"), "pass")  # 10+ x 40 = 400
        self.assertEqual(self.verdict("40 kWh pack", "few", quantity_value=5), "pass")  # 200 exactly
        self.assertEqual(self.verdict("1.2 MWh container"), "pass")

    def test_fifty_thousand_dollars_also_qualifies(self):
        # 100,000 cells at EUR 1 is about USD 116k even though the cell size is unknown
        self.assertEqual(self.verdict("some cell", "many", "100000 pcs", target_price=1, target_currency="EUR"), "pass")
        self.assertEqual(self.verdict("some pack", "many", target_price=5100, target_currency="USD"), "pass")   # 10 x 5,100
        self.assertEqual(self.verdict("some pack", "many", target_price=4000, target_currency="USD"), "unknown")  # USD 40k
        self.assertEqual(self.verdict("40 kWh pack", "one", target_price=44000, target_currency="EUR"), "pass")  # USD 51k
        self.assertEqual(self.verdict("40 kWh pack", "one", target_price=2000, target_currency="GBP"), "below")

    def test_cells_are_counted_but_packs_are_not_multiplied_by_module_counts(self):
        self.assertEqual(saved.gate({"wants": "18650", "details": "20000 pcs", "quantity": "many"})[1], 220)
        self.assertEqual(saved.gate({"wants": "leaf 40kwh", "details": "8 modules", "quantity": "one"})[1], 40)


class SourcingRequestDefinitionTest(unittest.TestCase):
    def missing(self, **overrides):
        base = {"wants": "Hyundai Kona 64 kWh", "timing": "now", "target_price": 2500, "country": "PL"}
        base.update(overrides)
        return saved.missing_fields(base)

    def test_a_sourcing_request_has_model_timeline_price_and_location(self):
        self.assertEqual(self.missing(), [])
        self.assertEqual(self.missing(wants="Nissan"), ["model"])
        self.assertEqual(self.missing(wants="sdfdsfsdf"), ["model"])
        self.assertEqual(self.missing(timing="browsing"), ["timeline"])
        self.assertEqual(self.missing(target_price=None), ["price"])
        self.assertEqual(self.missing(country=None), ["location"])
        self.assertEqual(self.missing(wants="Nissan", target_price=None, country=None), ["model", "price", "location"])

    def test_the_seven_real_requests(self):
        def check(wants, timing, price, country):
            return saved.missing_fields({"wants": wants, "timing": timing, "target_price": price, "country": country})
        self.assertEqual(check("Ig chem e101Ah", "now", None, "UA"), ["price"])
        self.assertEqual(check("21700 18650", "now", 1.0, "PL"), [])
        self.assertEqual(check("nissan leaf 40kwh pack", "now", None, "GR"), ["price"])
        self.assertEqual(check("Nissan", "now", None, "GB"), ["model", "price"])
        self.assertEqual(check("60 volt 20 ahlithium", "three_months", 200.0, "GB"), [])

    def test_each_outcome_says_what_happened_to_the_request(self):
        row = {"wants": "Nissan", "email": "a@b.com", "source_url": "https://x"}
        req = request(country="GB", target_price=None, target_currency=None)
        incomplete = saved.announcement(req, row, "incomplete", None, ["model", "price"])
        self.assertIn("New enquiry, not a sourcing request", incomplete)
        self.assertIn("Missing: model, price. Not chased.", incomplete)
        self.assertIn("under 200 kWh", saved.announcement(req, row, "small", 62))
        self.assertIn("About 62 kWh. Marketplace route, not in Trades.", saved.announcement(req, row, "small", 62))
        self.assertIn("size cannot be read", saved.announcement(req, row, "review"))
        self.assertIn("In Trades.", saved.announcement(req, {**row, "company_id": None}, "imported", 640))


class FetchTest(unittest.TestCase):
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
