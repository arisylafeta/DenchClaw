import importlib.util
import io
import os
import unittest
from contextlib import redirect_stdout
from pathlib import Path

spec = importlib.util.spec_from_file_location("sync", Path(__file__).with_name("bulk_trade_auction_sync.py"))
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)

SPECS = {"manufacturer": "FPT Industrial", "model": "EBS69", "chemistry": "NMC", "format": "Pack", "pack_kwh": 69.3,
         "quantity": 41, "quantity_available": 41, "year_manufacture": None, "soh": None,
         "location_address": {"city": "Torino", "country": "Italy"}}


def auction(id_, slug, specs, title, status="published", closes="2099-10-31T12:00:00+00:00", listing="lst-" ):
    return {"id": id_, "slug": slug, "status": status, "closes_at": closes, "access_scope": "public",
            "listing_id": listing + id_, "title": title, "specs": specs, "url": f"https://rebattery.test/marketplace/auctions/{slug}"}


class Helpers(unittest.TestCase):
    def test_new_trade_fields_come_from_the_listing(self):
        fields = sync.listing_fields(auction("a", "ebs69", SPECS, "FPT EBS69"))
        self.assertEqual(fields, {"model": "FPT Industrial EBS69", "chemistry": "NMC", "capacity": "69.3 kWh per pack",
                                  "quantity": "41 packs", "location": "Torino, Italy"})
        cells = sync.listing_fields(auction("b", "kokam", {**SPECS, "format": "Cell", "pack_kwh": 0.379, "quantity_available": 50000}, "Kokam"))
        self.assertEqual((cells["capacity"], cells["quantity"]), ("0.379 kWh per cell", "50000 cells"))

    def test_offer_wording(self):
        offer = {"kind": "offer", "price_per_kwh": 31.0, "currency": "EUR", "quantity": 36, "incoterm": "EXW", "site_visit": True}
        self.assertEqual(sync.offer_text(offer, "pack"), "Offer €31/kWh, 36 packs, EXW, site visit requested")
        buy = {"kind": "buy_now", "amount_per_unit": 1200.0, "currency": "USD", "quantity": 2}
        self.assertEqual(sync.offer_text(buy, "pack"), "Buy now: 2 packs at $1,200/pack")


class FakePlatform:
    def __init__(self, auctions, submissions, views=()):
        self._auctions, self._submissions, self._views = auctions, submissions, list(views)

    def auctions(self):
        return self._auctions

    def submissions(self, ids):
        return [s for s in self._submissions if s["auction_id"] in ids]

    def views(self, ids):
        return [v for v in self._views if v["auction_id"] in ids]


TEST_URL = os.environ.get("BULK_TRADES_TEST_DATABASE_URL")


@unittest.skipUnless(TEST_URL, "needs a disposable database: scripts/rebattery/crm-test-db.sh up")
class SyncRun(unittest.TestCase):
    def test_links_or_creates_trades_and_adds_engaged_people_as_buyers_once(self):
        import psycopg2
        conn = psycopg2.connect(TEST_URL)
        with conn, conn.cursor() as cur:
            cur.execute("""
              insert into crm_bulk_trade_lots (id, lot_kind, title, summary, observed_outcome, confidence, trade_stage, trade_kind)
                values ('bt_auc_69', 'supply', 'Iveco FPT eBS69 sync', '', '', 'confirmed', 'With buyers', 'packs'),
                       ('bt_auc_k1', 'supply', 'Kokam KCL-SYNC1 cells A', '', '', 'confirmed', 'With buyers', 'cells'),
                       ('bt_auc_k2', 'supply', 'Kokam KCL-SYNC1 cells B', '', '', 'confirmed', 'Needs info', 'cells')
                on conflict do nothing;
              insert into crm_bulk_trade_buyers (id, lot_id, name, contact, status)
                values ('btb_auc_known', 'bt_auc_69', 'Known Buyer', 'tess@known.test.example', 'Teaser sent') on conflict do nothing;
            """)
        auctions = [
            auction("a69", "fpt-ebs69-sync", {**SPECS, "model": "eBS69 sync"}, "FPT Industrial EBS69 69.3kWh"),
            auction("amega", "tesla-megapack-sync", {**SPECS, "manufacturer": "Tesla", "model": "Megapack SYNC", "format": "System"}, "Tesla Megapack"),
            auction("akok", "kokam-sync", {**SPECS, "model": "KCL-SYNC1", "format": "Cell"}, "Kokam KCL-SYNC1"),
            auction("aold", "old-closed-sync", {**SPECS, "model": "Nothing Like It"}, "Closed lot", closes="2020-01-01T00:00:00+00:00"),
        ]
        submissions = [
            {"id": "s1", "auction_id": "a69", "submission_kind": "offer", "email": "Buyer@Newco.example", "price_per_kwh": "31.5",
             "amount_per_unit": "2183", "quantity_requested": 36, "currency": "EUR", "incoterm": "EXW", "site_visit_requested": True,
             "message": None, "created_at": "2026-09-28T10:00:00+00:00"},
            {"id": "s2", "auction_id": "a69", "submission_kind": "offer", "email": "tess@known.test.example", "price_per_kwh": "30",
             "amount_per_unit": "2079", "quantity_requested": 41, "currency": "EUR", "incoterm": "FCA", "site_visit_requested": False,
             "message": None, "created_at": "2026-09-28T11:00:00+00:00"},
            {"id": "s3", "auction_id": "a69", "submission_kind": "offer", "email": "alex@rebattery.io", "price_per_kwh": "1",
             "amount_per_unit": "1", "quantity_requested": 1, "currency": "EUR", "incoterm": "EXW", "site_visit_requested": False,
             "message": None, "created_at": "2026-09-28T12:00:00+00:00"},
        ]
        views = [{"auction_id": "a69", "first_viewed_at": "2026-09-27T09:00:00+00:00", "last_viewed_at": "2026-09-29T09:00:00+00:00",
                  "view_count": 3, "users": {"email": "looker@viewco.example"}}]
        platform = FakePlatform(auctions, submissions, views)
        args = type("Args", (), {"dry_run": False})
        with redirect_stdout(io.StringIO()):
            sync.run(conn, args, platform)
            sync.run(conn, args, platform)  # nothing new the second time
        with conn.cursor() as cur:
            cur.execute("select id, auction_slug, listing_id from crm_bulk_trade_lots where auction_slug like '%%sync' order by id")
            lots = cur.fetchall()
            cur.execute("select name, status, last_touch_via from crm_bulk_trade_buyers where lot_id = 'bt_auc_69' order by name")
            buyers = cur.fetchall()
            cur.execute("""select b.name, bid.amount::float, bid.unit, bid.delivery_terms from crm_bulk_trade_bids bid
                           join crm_bulk_trade_buyers b on b.id = bid.buyer_id where bid.lot_id = 'bt_auc_69' order by 1""")
            bids = cur.fetchall()
            cur.execute("select kind, status from crm_bulk_trade_proposals where lot_id = 'bt_auc_69' and status = 'new'")
            cards = cur.fetchall()
            cur.execute("select kind, lot_id from crm_bulk_trade_proposals where kind = 'link_auction' and target = 'akok'")
            link_cards = cur.fetchall()
            cur.execute("select email, view_count, offer_count, buyer_id is not null from crm_bulk_trade_auction_people where lot_id = 'bt_auc_69' order by 1")
            people = cur.fetchall()
            cur.execute("select value from crm_bulk_trade_fields where lot_id = 'bulk-tesla-megapack-sync' and field_key = 'energy'")
            energy = cur.fetchone()
        conn.close()
        self.assertEqual(lots, [("bt_auc_69", "fpt-ebs69-sync", "lst-a69"),
                                ("bulk-tesla-megapack-sync", "tesla-megapack-sync", "lst-amega")])  # closed lot skipped, Kokam ambiguous
        self.assertEqual(link_cards, [("link_auction", "bt_auc_k1")])
        self.assertEqual(energy, ("69.3 kWh per system",))
        self.assertEqual(buyers, [("Known Buyer", "Teaser sent", "Auction"), ("Newco", "Bid in", "Auction"), ("Viewco", "Teaser sent", "Auction")])
        self.assertEqual(bids, [("Known Buyer", 30.0, "kWh", "FCA, 41 packs"), ("Newco", 31.5, "kWh", "EXW, 36 packs, site visit requested")])
        self.assertEqual(cards, [("buyer_update", "new")])  # the known buyer's move to Bid in waits for Alex
        self.assertEqual(people, [("buyer@newco.example", 0, 1, True), ("looker@viewco.example", 3, 0, True),
                                  ("tess@known.test.example", 0, 1, True)])


if __name__ == "__main__":
    unittest.main()
