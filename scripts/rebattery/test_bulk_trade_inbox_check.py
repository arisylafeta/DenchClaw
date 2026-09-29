import datetime as dt
import importlib.util
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("check", Path(__file__).with_name("bulk_trade_inbox_check.py"))
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)

NOW = dt.datetime(2026, 9, 29, 12, tzinfo=dt.timezone.utc)
TRADE = {
    "id": "bt_1", "title": "Synthetic eBS37", "trade_kind": "packs", "trade_stage": "With buyers", "fact_line": None,
    "next_step": "Chase supplier", "next_step_due": "2026-09-29", "waiting_on": "us",
    "emails": {"sam@supplier.test"}, "threads": {"thr-1"},
    "buyers": [{"id": "btb_1", "name": "Synthetic Storage", "contact": "Tess", "status": "To contact"}],
    "fields": {"chemistry": {"value": "NMC", "status": "confirmed"}},
}
SOURCE = {"kind": "gmail", "id": "m1", "thread": "thr-9", "at": NOW, "synced_at": NOW, "label": "Gmail · sam@supplier.test",
          "url": None, "inbound": True, "participants": {"sam@supplier.test"}, "title": "Stock",
          "text": "Subject: Stock\n\nManufacturing dates:  2021 to 2025. Packs are in Turin.", "has_attachments": False}


class Helpers(unittest.TestCase):
    def test_quote_must_appear_in_source_ignoring_spacing_and_curly_quotes(self):
        self.assertTrue(check.quote_ok("Manufacturing dates: 2021 to 2025", SOURCE["text"]))
        self.assertTrue(check.quote_ok("packs are in turin", SOURCE["text"]))
        self.assertFalse(check.quote_ok("Manufactured in 2023", SOURCE["text"]))
        self.assertFalse(check.quote_ok("Turin", SOURCE["text"]))  # too short to prove anything
        self.assertTrue(check.quote_ok("Alex’s offer", "Alex's offer stands"))

    def test_matches_by_participant_or_known_thread_and_ignores_own_domain(self):
        trades = {"bt_1": TRADE, "bt_2": {**TRADE, "id": "bt_2", "emails": {"other@x.test"}, "threads": set()}}
        self.assertEqual(check.match(SOURCE, trades), {"bt_1"})
        self.assertEqual(check.match({**SOURCE, "participants": set(), "thread": "thr-1"}, trades), {"bt_1"})
        self.assertEqual(check.match({**SOURCE, "participants": {"other@x.test", "sam@supplier.test"}}, trades), {"bt_1", "bt_2"})
        self.assertEqual(check.external({"alex@rebattery.io", "sam@supplier.test"}), {"sam@supplier.test"})

    def test_file_types_from_names(self):
        self.assertEqual(check.guess_type("20260724_113720.jpg"), "Photos")
        self.assertEqual(check.guess_type("MSDS Pack GJW2019-5954.pdf"), "Transport documents")
        self.assertEqual(check.guess_type("Datasheet eBS 37.pdf"), "Datasheet")
        self.assertEqual(check.guess_type("inventory.xlsx"), "Stock list")


class Validate(unittest.TestCase):
    def run_validate(self, proposals):
        return check.validate({"proposals": proposals}, TRADE, {"m1": SOURCE})

    def test_keeps_well_formed_quoted_proposals(self):
        kept = self.run_validate([
            {"kind": "field", "target": "manufacture_date", "proposed": {"value": "2021 to 2025", "status": "unverified"},
             "summary": "Manufacture date given", "quote": "Manufacturing dates:  2021 to 2025", "source_id": "m1"},
            {"kind": "buyer_update", "target": "btb_1", "proposed": {"status": "Teaser sent", "last_touch_via": "Email", "junk": 1},
             "summary": "Teaser sent", "quote": "Packs are in Turin", "source_id": "m1"},
            {"kind": "next_step", "proposed": {"next_step": "Ask for the warehouse address", "next_step_due": "soon"},
             "summary": "Next", "quote": "Packs are in Turin", "source_id": "m1"},
        ])
        self.assertEqual([p["kind"] for p in kept], ["field", "buyer_update", "next_step"])
        self.assertEqual(kept[1]["proposed"], {"status": "Teaser sent", "last_touch_via": "Email"})
        self.assertIsNone(kept[2]["proposed"]["next_step_due"])

    def test_drops_unquoted_unknown_targets_and_bad_values(self):
        kept = self.run_validate([
            {"kind": "field", "target": "manufacture_date", "proposed": {"value": "2022"}, "quote": "Made in 2022", "source_id": "m1"},
            {"kind": "field", "target": "weight", "proposed": {"value": "3 t"}, "quote": "Packs are in Turin", "source_id": "m1"},
            {"kind": "buyer_update", "target": "btb_9", "proposed": {"status": "Won"}, "quote": "Packs are in Turin", "source_id": "m1"},
            {"kind": "buyer_update", "target": "btb_1", "proposed": {"status": "Maybe"}, "quote": "Packs are in Turin", "source_id": "m1"},
            {"kind": "new_buyer", "proposed": {"name": "synthetic storage"}, "quote": "Packs are in Turin", "source_id": "m1"},
            {"kind": "delete_trade", "proposed": {}, "quote": "Packs are in Turin", "source_id": "m1"},
            {"kind": "field", "target": "location", "proposed": {"value": "Turin"}, "quote": "Packs are in Turin", "source_id": "m404"},
        ])
        self.assertEqual(kept, [])


class Granola(unittest.TestCase):
    def test_reads_notes_updated_after_the_cursor(self):
        with tempfile.TemporaryDirectory() as tmp:
            raw = Path(tmp, "raw"); raw.mkdir()
            note = {"id": "not_1", "title": "Call with Sam", "web_url": "https://notes.granola.ai/d/1",
                    "created_at": "2026-09-29T10:00:00Z", "updated_at": "2026-09-29T11:00:00Z",
                    "attendees": [{"name": "Sam", "email": "Sam@Supplier.test"}, {"name": "Alex", "email": "alex@rebattery.io"}],
                    "calendar_event": {"invitees": [{"email": "tess@buyer.test"}]},
                    "summary_markdown": "Price agreed", "transcript": [{"text": "We can do 22 per kWh", "speaker": {"source": "microphone"}}]}
            Path(raw, "not_1.json").write_text(json.dumps(note))
            Path(raw, "old.json").write_text(json.dumps({**note, "id": "old", "updated_at": "2026-09-01T00:00:00Z"}))
            with patch.object(check, "GRANOLA_DIR", Path(tmp)):
                notes = check.load_granola(dt.datetime(2026, 9, 28, tzinfo=dt.timezone.utc))
        self.assertEqual([n["id"] for n in notes], ["not_1"])
        self.assertEqual(notes[0]["participants"], {"sam@supplier.test", "tess@buyer.test"})
        self.assertIn("We can do 22 per kWh", notes[0]["text"])


TEST_URL = os.environ.get("BULK_TRADES_TEST_DATABASE_URL")


@unittest.skipUnless(TEST_URL, "needs a disposable database: scripts/rebattery/crm-test-db.sh up")
class FullRun(unittest.TestCase):
    """End to end against a throwaway database with migrations up to 010, the model mocked."""

    def setUp(self):
        import psycopg2
        self.conn = psycopg2.connect(TEST_URL)
        with self.conn, self.conn.cursor() as cur:
            cur.execute("""
              insert into crm_users (email, display_name, password_hash) values ('alex@rebattery.io', 'Alex', 'x') on conflict do nothing;
              insert into crm_bulk_trade_lots (id, lot_kind, title, summary, observed_outcome, confidence, trade_stage, trade_kind)
                values ('bt_run', 'supply', 'Run trade', '', '', 'confirmed', 'With buyers', 'packs') on conflict do nothing;
              insert into crm_bulk_trade_contacts (id, lot_id, name, email) values ('btc_run', 'bt_run', 'Sam', 'sam@supplier.test') on conflict do nothing;
              insert into crm_email_threads (id, subject, gmail_thread_id) values ('thr_run', 'Stock', 'g-thr-run') on conflict do nothing;
              insert into crm_email_messages (id, thread_id, subject, sent_at, body, gmail_message_id, from_email, mailbox_owner_id)
                select 'msg_run', 'thr_run', 'Stock', now(), 'Manufacturing dates: 2021 to 2025. Packs in Turin.', 'g-msg-run',
                       'sam@supplier.test', id from crm_users where email = 'alex@rebattery.io' on conflict do nothing;
              insert into crm_email_messages (id, subject, sent_at, body, gmail_message_id, from_email, mailbox_owner_id)
                select 'msg_new', 'Offer: 400 Leaf packs in Leeds', now(), '400 Nissan Leaf battery packs available in Leeds, 40 kWh.',
                       'g-msg-new', 'seller@unknown.test', id from crm_users where email = 'alex@rebattery.io' on conflict do nothing;
            """)

    def tearDown(self):
        self.conn.close()

    def fake_model(self, system, user, key):
        if system is check.POSSIBLE_SYSTEM:
            return {"trades": [{"source_id": "g-msg-new", "title": "Leaf packs, Leeds", "trade_kind": "packs",
                                "summary": "400 Leaf packs offered", "quote": "400 Nissan Leaf battery packs available in Leeds"}]}
        return {"proposals": [
            {"kind": "field", "target": "manufacture_date", "proposed": {"value": "2021 to 2025"},
             "summary": "Manufacture date", "quote": "Manufacturing dates: 2021 to 2025", "source_id": "g-msg-run"},
            {"kind": "field", "target": "location", "proposed": {"value": "Milan"},
             "summary": "Invented", "quote": "Packs are in Milan", "source_id": "g-msg-run"}]}

    def test_run_records_quoted_proposals_once_and_advances_the_cursor(self):
        args = type("Args", (), {"mailbox": "alex@rebattery.io", "since": "2026-01-01T00:00:00Z", "dry_run": False})
        with patch.object(check, "call_model", self.fake_model), patch.object(check, "refresh_granola", lambda: None), \
             patch.object(check, "load_granola", lambda since: []), patch.dict(os.environ, {"HERMES_API_KEY": "test"}):
            with redirect_stdout(io.StringIO()):
                check.run(self.conn, args)
                check.run(self.conn, args)  # same sources again: nothing new
        with self.conn.cursor() as cur:
            cur.execute("select lot_id, kind, target, proposed->>'value', status from crm_bulk_trade_proposals order by id")
            rows = cur.fetchall()
            cur.execute("select status, emails_read, proposals_made from crm_bulk_trade_check_runs order by id")
            runs = cur.fetchall()
        self.assertIn(("bt_run", "field", "manufacture_date", "2021 to 2025", "new"), rows)
        self.assertNotIn("Milan", [r[3] for r in rows])  # the unquoted claim was dropped
        self.assertIn((None, "possible_trade", None, None, "new"), rows)
        self.assertEqual(len(rows), 2)
        self.assertEqual([r[0] for r in runs[-2:]], ["ok", "ok"])
        self.assertEqual(runs[-1][2], 0)


if __name__ == "__main__":
    unittest.main()
