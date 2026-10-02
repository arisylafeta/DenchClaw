import datetime as dt
import importlib.util
import io
import json
import os
import tempfile
import unittest
from zoneinfo import ZoneInfo
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
    "emails": {"sam@supplier.test"}, "threads": {"gmail:thr-1"},
    "buyers": [{"id": "btb_1", "name": "Synthetic Storage", "contact": "Tess", "status": "To contact",
                "last_touch_on": "2026-09-28", "last_touch_via": "Email", "chase_on": None}],
    "fields": {"chemistry": {"value": "NMC", "status": "confirmed"}},
    "files": {"datasheet.pdf"},
    "contact_emails": {"sam@supplier.test"},
}
SOURCE = {"kind": "gmail", "id": "m1", "key": "gmail:thr-9", "thread": "thr-9", "at": NOW, "synced_at": NOW, "label": "Gmail · sam@supplier.test",
          "url": None, "inbound": True, "participants": {"sam@supplier.test"}, "title": "Stock",
          "text": "Subject: Stock\n\nManufacturing dates:  2021 to 2025. Packs are in Turin.\n\nAttachments: LC draft.docx, Datasheet.pdf, Uggc0GlP04b4Jqe4.png",
          "has_attachments": True, "from": "sam@supplier.test",
          "attachments": [{"name": "LC draft.docx", "id": "a1"}, {"name": "Datasheet.pdf", "id": "a2"}, {"name": "Uggc0GlP04b4Jqe4.png", "id": "a3"}]}


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
        self.assertEqual(check.match({**SOURCE, "participants": set(), "key": "gmail:thr-1"}, trades), {"bt_1"})
        self.assertEqual(check.match({**SOURCE, "participants": {"other@x.test", "sam@supplier.test"}}, trades), {"bt_1", "bt_2"})
        self.assertEqual(check.external({"alex@rebattery.io", "sam@supplier.test"}), {"sam@supplier.test"})

    def test_file_types_from_names(self):
        self.assertEqual(check.guess_type("20260724_113720.jpg"), "Photos")
        self.assertEqual(check.guess_type("MSDS Pack GJW2019-5954.pdf"), "Transport documents")
        self.assertEqual(check.guess_type("Datasheet eBS 37.pdf"), "Datasheet")
        self.assertEqual(check.guess_type("inventory.xlsx"), "Stock list")


class DemandScreen(unittest.TestCase):
    REPLY = ("Subject: Re: EV packs available\nFrom: fergal@buyer.test\n\nWe'd be interested in cells, not packs.\n\n"
             "On Fri, 2 Oct 2026 at 12:56, Alex Polglase <alex@rebattery.io> wrote:\n\n> We have EV packs.\n> Unsubscribe")
    OUTLOOK = ("Subject: RE: EV packs available\nFrom: pat@buyer.test\n\nWe only work with Tesla Model S packs.\n\n"
               "From: Alex Polglase <alex@rebattery.io>\nSent: Friday, October 2, 2026 4:57 AM\nTo: pat@buyer.test\n\nUnsubscribe")

    def source(self, text, sender):
        return {**SOURCE, "text": text, "from": sender, "inbound": True}

    def test_a_quoted_unsubscribe_footer_does_not_hide_a_reply(self):
        for text in (self.REPLY, self.OUTLOOK):
            own, quoted = check.split_reply(text)
            self.assertNotIn("Unsubscribe", own)
            self.assertIn("Unsubscribe", quoted)
        self.assertIn("[They are replying to:]", check.demand_text(self.source(self.REPLY, "fergal@buyer.test")))

    def test_replies_to_our_outreach_skip_the_phrase_check_and_cold_mail_needs_it(self):
        reply = self.source(self.OUTLOOK, "pat@buyer.test")
        self.assertTrue(check.demand_candidate(reply, {"pat@buyer.test"}))
        cold = self.source("Subject: Hello\nFrom: x@cold.test\n\nGreat to meet you at the show.", "x@cold.test")
        self.assertFalse(check.demand_candidate(cold, set()))
        self.assertTrue(check.demand_candidate(self.source(self.REPLY, "fergal@buyer.test"), set()))  # "interested in" + cells
        newsletter = self.source("Subject: News\nFrom: n@news.test\n\nOur battery newsletter. Unsubscribe here.", "n@news.test")
        self.assertFalse(check.demand_candidate(newsletter, {"n@news.test"}))


class Schedule(unittest.TestCase):
    def test_due_only_just_after_uk_check_times(self):
        london = check.ZoneInfo("Europe/London")
        at = lambda h, m: dt.datetime(2026, 9, 29, h, m, tzinfo=london)
        times = ["08:00", "10:30"]
        self.assertTrue(check.due_now(times, at(8, 0)))
        self.assertTrue(check.due_now(times, at(10, 44)))
        self.assertFalse(check.due_now(times, at(10, 45)))
        self.assertFalse(check.due_now(times, at(7, 59)))
        self.assertFalse(check.due_now(times, at(9, 0)))
        # In winter 08:00 UK is 08:00 UTC; in summer it is 07:00 UTC. Either way the UK time decides.
        self.assertTrue(check.due_now(["08:00"], dt.datetime(2026, 12, 1, 8, 0, tzinfo=dt.timezone.utc).astimezone(london)))
        self.assertTrue(check.due_now(["08:00"], dt.datetime(2026, 7, 1, 7, 0, tzinfo=dt.timezone.utc).astimezone(london)))


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
        self.assertEqual(kept[1]["proposed"], {"status": "Teaser sent"})  # via Email is already recorded
        self.assertIsNone(kept[2]["proposed"]["next_step_due"])

    def test_drops_what_is_already_recorded(self):
        kept = self.run_validate([
            {"kind": "field", "target": "chemistry", "proposed": {"value": "nmc"}, "quote": "Packs are in Turin", "source_id": "m1"},
            {"kind": "buyer_update", "target": "btb_1", "proposed": {"last_touch_on": "2026-09-28", "last_touch_via": "Email"},
             "quote": "Packs are in Turin", "source_id": "m1"},
            {"kind": "next_step", "proposed": {"next_step": "chase supplier"}, "quote": "Packs are in Turin", "source_id": "m1"},
        ])
        self.assertEqual(kept, [])

    def test_files_only_named_attachments_not_on_the_trade_and_not_inline_images(self):
        kept = self.run_validate([
            {"kind": "file", "target": "LC draft.docx", "proposed": {}, "quote": "LC draft.docx", "source_id": "m1"},
            {"kind": "file", "target": "LC draft.docx", "proposed": {}, "quote": "LC draft.docx", "source_id": "m1"},
            {"kind": "file", "target": "Datasheet.pdf", "proposed": {}, "quote": "Datasheet.pdf", "source_id": "m1"},
            {"kind": "file", "target": "Uggc0GlP04b4Jqe4.png", "proposed": {}, "quote": "Uggc0GlP04b4Jqe4.png", "source_id": "m1"},
            {"kind": "file", "target": "Invented.pdf", "proposed": {}, "quote": "Packs are in Turin", "source_id": "m1"},
        ])
        self.assertEqual([p["proposed"]["file_name"] for p in kept], ["LC draft.docx"])
        self.assertEqual(kept[0]["proposed"], {"file_name": "LC draft.docx", "gmail_message_id": "m1", "attachment_id": "a1", "file_type": "Other"})

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

    def test_a_bid_is_kept_and_moving_the_buyer_on_becomes_a_card(self):
        kept = self.run_validate([
            {"kind": "bid", "target": "btb_1", "proposed": {"amount": "31", "unit": "kWh", "currency": "EUR"},
             "summary": "Bid", "quote": "Packs are in Turin", "source_id": "m1"},
            {"kind": "bid", "target": "btb_1", "proposed": {"amount": 0, "unit": "kWh", "currency": "EUR"},
             "quote": "Packs are in Turin", "source_id": "m1"},
            {"kind": "bid", "target": "btb_1", "proposed": {"amount": 30, "unit": "tonne", "currency": "EUR"},
             "quote": "Packs are in Turin", "source_id": "m1"},
        ])
        self.assertEqual([p["kind"] for p in kept], ["buyer_update", "bid"])
        self.assertEqual(kept[0]["proposed"], {"status": "Bid in"})
        self.assertEqual(kept[1]["proposed"], {"amount": 31.0, "unit": "kWh", "currency": "EUR", "firmness": "indicative"})


class Settling(unittest.TestCase):
    def test_buyer_status_waits_for_alex_and_the_rest_is_applied(self):
        update = {"kind": "buyer_update", "target": "btb_1", "proposed": {"status": "Teaser sent", "chase_on": "2026-10-02"},
                  "summary": "", "quote": "", "source": SOURCE}
        status, rest = check.split_status(update)
        self.assertEqual((status["proposed"], check.is_card(status)), ({"status": "Teaser sent"}, True))
        self.assertEqual((rest["proposed"], check.is_card(rest)), ({"chase_on": "2026-10-02"}, False))
        self.assertTrue(check.is_card({"kind": "possible_trade", "proposed": {}}))
        self.assertFalse(check.is_card({"kind": "field", "proposed": {}}))

    def test_placing_keeps_only_valid_verdicts_for_threads_it_was_shown(self):
        groups = {"gmail:a": [SOURCE], "gmail:b": [{**SOURCE, "key": "gmail:b"}], "gmail:c": [{**SOURCE, "key": "gmail:c"}]}
        reply = {"threads": [
            {"key": "gmail:a", "verdict": "trade", "trade_id": "bt_1", "reason": "same batch"},
            {"key": "gmail:b", "verdict": "none", "trade_id": "bt_1", "reason": "Serbian packs, older deal"},
            {"key": "gmail:c", "verdict": "trade", "trade_id": "bt_404"},
            {"key": "gmail:zzz", "verdict": "trade", "trade_id": "bt_1"},
        ]}
        report = {"warnings": []}
        with patch.object(check, "call_model", lambda system, user, key: reply):
            verdicts = check.place_threads(groups, {"bt_1": TRADE}, "k", report)
        self.assertEqual(verdicts, {
            "gmail:a": {"verdict": "trade", "lot_id": "bt_1", "reason": "same batch"},
            "gmail:b": {"verdict": "none", "lot_id": None, "reason": "Serbian packs, older deal"},
        })


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


class History(unittest.TestCase):
    def test_batches_respect_the_size_budget_and_order(self):
        sources = [{"id": str(i), "text": "x" * 5000} for i in range(7)]
        groups = list(check.batches(sources, budget=12000))
        self.assertEqual([[s["id"] for s in g] for g in groups], [["0", "1"], ["2", "3"], ["4", "5"], ["6"]])

    def test_later_sources_win_and_buyer_updates_merge(self):
        import copy
        trade = copy.deepcopy(TRADE)
        latest = {}
        first = {"kind": "field", "target": "quantity", "proposed": {"value": "600 packs", "status": "unverified"}, "summary": "", "quote": "", "source": SOURCE}
        later = {**first, "proposed": {"value": "580 packs", "status": "confirmed"}}
        touch = {"kind": "buyer_update", "target": "btb_1", "proposed": {"status": "Teaser sent"}, "summary": "", "quote": "", "source": SOURCE}
        touch2 = {**touch, "proposed": {"last_touch_on": "2026-09-29"}}
        check.fold(trade, [first, touch], latest)
        check.fold(trade, [later, touch2], latest)
        self.assertEqual(latest[("field", "quantity")]["proposed"]["value"], "580 packs")
        self.assertEqual(latest[("buyer_update", "btb_1")]["proposed"], {"status": "Teaser sent", "last_touch_on": "2026-09-29"})
        self.assertEqual(trade["fields"]["quantity"]["value"], "580 packs")

    def test_trade_kind_and_contacts_are_validated(self):
        import copy
        kindless = {**copy.deepcopy(TRADE), "trade_kind": None}
        kept = check.validate({"proposals": [
            {"kind": "trade_kind", "proposed": {"trade_kind": "packs"}, "quote": "Packs are in Turin", "source_id": "m1"},
            {"kind": "trade_kind", "proposed": {"trade_kind": "bikes"}, "quote": "Packs are in Turin", "source_id": "m1"},
            {"kind": "link_contact", "proposed": {"name": "Sam", "email": "sam@supplier.test"}, "quote": "Packs are in Turin", "source_id": "m1"},
            {"kind": "link_contact", "proposed": {"name": "Ghost", "email": "ghost@nowhere.test"}, "quote": "Packs are in Turin", "source_id": "m1"},
            {"kind": "link_contact", "proposed": {"name": "Alex", "email": "alex@rebattery.io"}, "quote": "Packs are in Turin", "source_id": "m1"},
        ]}, kindless, {"m1": {**SOURCE, "text": SOURCE["text"] + "\nCc: new.person@supplier.test"}})
        self.assertEqual([p["kind"] for p in kept], ["trade_kind"])
        kept = check.validate({"proposals": [
            {"kind": "link_contact", "proposed": {"name": "New Person", "email": "New.Person@supplier.test"}, "quote": "Packs are in Turin", "source_id": "m1"},
        ]}, TRADE, {"m1": {**SOURCE, "text": SOURCE["text"] + "\nCc: new.person@supplier.test"}})
        self.assertEqual(kept[0]["proposed"], {"name": "New Person", "email": "new.person@supplier.test"})


TEST_URL = os.environ.get("BULK_TRADES_TEST_DATABASE_URL")


@unittest.skipUnless(TEST_URL, "needs a disposable database: scripts/rebattery/crm-test-db.sh up")
class FullRun(unittest.TestCase):
    """End to end against a throwaway database with every migration, the model mocked."""

    def setUp(self):
        import psycopg2
        self.conn = psycopg2.connect(TEST_URL)
        with self.conn, self.conn.cursor() as cur:
            cur.execute("""
              insert into crm_users (email, display_name, password_hash) values ('alex@rebattery.io', 'Alex', 'x') on conflict do nothing;
              insert into crm_bulk_trade_lots (id, lot_kind, title, summary, observed_outcome, confidence, trade_stage, trade_kind)
                values ('bt_run', 'supply', 'Run trade', '', '', 'confirmed', 'With buyers', 'packs') on conflict do nothing;
              insert into crm_bulk_trade_contacts (id, lot_id, name, email) values ('btc_run', 'bt_run', 'Sam', 'sam-fullrun@supplier.test') on conflict do nothing;
              insert into crm_email_threads (id, subject, gmail_thread_id) values ('thr_run', 'Stock', 'g-thr-run') on conflict do nothing;
              insert into crm_email_messages (id, thread_id, subject, sent_at, body, gmail_message_id, from_email, mailbox_owner_id)
                select 'msg_run', 'thr_run', 'Stock', now(), 'Manufacturing dates: 2021 to 2025. Packs in Turin.', 'g-msg-run',
                       'sam-fullrun@supplier.test', id from crm_users where email = 'alex@rebattery.io' on conflict do nothing;
              insert into crm_email_messages (id, subject, sent_at, body, gmail_message_id, from_email, mailbox_owner_id)
                select 'msg_new', 'Offer: 400 Leaf packs in Leeds', now(), '400 Nissan Leaf battery packs available in Leeds, 40 kWh.',
                       'g-msg-new', 'seller@unknown.test', id from crm_users where email = 'alex@rebattery.io' on conflict do nothing;
              insert into crm_email_messages (id, subject, sent_at, body, gmail_message_id, from_email, mailbox_owner_id)
                select 'msg_known', 'Batch update', now(), 'More packs for the run trade batch are ready.',
                       'g-msg-known', 'new.person@supplier.test', id from crm_users where email = 'alex@rebattery.io' on conflict do nothing;
            """)

    def tearDown(self):
        self.conn.close()

    def fake_model(self, system, user, key):
        if system is check.THREAD_SYSTEM:
            return {"threads": [{"key": t["key"], "verdict": "trade", "trade_id": "bt_run"} for t in json.loads(user)["THREADS"]]}
        if system is check.POSSIBLE_SYSTEM:
            existing = [t["id"] for t in json.loads(user)["EXISTING"]]
            assert "bt_run" in existing
            return {"trades": [
                {"source_id": "g-msg-new", "title": "Leaf packs, Leeds", "trade_kind": "packs",
                 "summary": "400 Leaf packs offered", "quote": "400 Nissan Leaf battery packs available in Leeds"},
                {"source_id": "g-msg-known", "title": "Run trade", "existing_trade_id": "bt_run",
                 "summary": "About the run trade", "quote": "More packs for the run trade batch"}]}
        return {"proposals": [
            {"kind": "field", "target": "manufacture_date", "proposed": {"value": "2021 to 2025"},
             "summary": "Manufacture date", "quote": "Manufacturing dates: 2021 to 2025", "source_id": "g-msg-run"},
            {"kind": "field", "target": "location", "proposed": {"value": "Milan"},
             "summary": "Invented", "quote": "Packs are in Milan", "source_id": "g-msg-run"},
            {"kind": "field", "target": "chemistry", "proposed": {"value": "LFP"},
             "summary": "Chemistry", "quote": "Packs in Turin", "source_id": "g-msg-run"},
            {"kind": "buyer_update", "target": "btb_run", "proposed": {"status": "Teaser sent", "chase_on": "2026-10-02"},
             "summary": "Teaser went out", "quote": "Packs in Turin", "source_id": "g-msg-run"}]}

    def test_run_applies_quoted_findings_once_keeps_alexs_values_and_leaves_status_as_a_card(self):
        with self.conn, self.conn.cursor() as cur:
            cur.execute("""
              insert into crm_bulk_trade_buyers (id, lot_id, name) values ('btb_run', 'bt_run', 'Buyer') on conflict do nothing;
              insert into crm_bulk_trade_fields (lot_id, field_key, value, status) values ('bt_run', 'chemistry', 'NMC', 'confirmed')
                on conflict do nothing;
              insert into crm_bulk_trade_events (lot_id, kind, changes, actor_user_id)
                select 'bt_run', 'field_updated', '{"field": "chemistry", "value": [null, "NMC"]}', id from crm_users where email = 'alex@rebattery.io';
            """)
        args = type("Args", (), {"mailbox": "alex@rebattery.io", "since": "2026-01-01T00:00:00Z", "dry_run": False, "dsn": ""})
        started = []
        with patch.object(check, "call_model", self.fake_model), patch.object(check, "refresh_granola", lambda: None), \
             patch.object(check, "load_granola", lambda since: []), patch.dict(os.environ, {"HERMES_API_KEY": "test"}), \
             patch.object(check, "start_history", lambda lot_id, args: started.append(lot_id)):
            with redirect_stdout(io.StringIO()):
                check.run(self.conn, args)
                check.run(self.conn, args)  # same sources again: nothing new
        with self.conn.cursor() as cur:
            cur.execute("""select lot_id, kind, target, proposed->>'value', status from crm_bulk_trade_proposals
                           where source_id in ('g-msg-run', 'g-msg-new', 'g-msg-known') order by id""")
            rows = cur.fetchall()
            cur.execute("select field_key, value, status, alternatives->0->>'value' from crm_bulk_trade_fields where lot_id = 'bt_run' order by field_key")
            fields = cur.fetchall()
            cur.execute("select status, to_char(chase_on, 'YYYY-MM-DD') from crm_bulk_trade_buyers where id = 'btb_run'")
            buyer = cur.fetchone()
            cur.execute("select email from crm_bulk_trade_contacts where lot_id = 'bt_run' order by email")
            contacts = [r[0] for r in cur.fetchall()]
            cur.execute("select verdict, lot_id from crm_bulk_trade_threads where thread_key = 'gmail:g-thr-run'")
            verdict = cur.fetchone()
            cur.execute("select count(*) from crm_bulk_trade_events where lot_id = 'bt_run' and actor_user_id is null and kind = 'field_updated'")
            auto_events = cur.fetchone()[0]
            cur.execute("select status, emails_read, proposals_made from crm_bulk_trade_check_runs where kind = 'check' order by id")
            runs = cur.fetchall()
        self.assertIn(("bt_run", "field", "manufacture_date", "2021 to 2025", "applied"), rows)
        self.assertNotIn("Milan", [r[3] for r in rows])  # the unquoted claim was dropped
        self.assertIn(("bt_run", "buyer_update", "btb_run", None, "new"), rows)  # the status waits for Alex
        self.assertIn((None, "possible_trade", None, None, "new"), rows)
        self.assertIn(("bt_run", "link_contact", None, None, "applied"), rows)
        self.assertIn(("manufacture_date", "2021 to 2025", "unverified", None), fields)
        self.assertIn(("chemistry", "NMC", "conflict", "LFP"), fields)  # Alex's value stands; email's is a conflict
        self.assertEqual(buyer, ("To contact", "2026-10-02"))
        self.assertEqual(contacts, ["new.person@supplier.test", "sam-fullrun@supplier.test"])
        self.assertEqual(verdict, ("trade", "bt_run"))
        self.assertEqual(auto_events, 2)
        self.assertEqual(started, ["bt_run"])  # the new contact's past mail gets read
        self.assertEqual([r[0] for r in runs[-2:]], ["ok", "ok"])
        self.assertEqual(runs[-1][2], 0)


@unittest.skipUnless(TEST_URL, "needs a disposable database: scripts/rebattery/crm-test-db.sh up")
class HistoryRun(unittest.TestCase):
    def test_reads_all_of_a_trades_mail_oldest_first_and_keeps_the_latest_value(self):
        import psycopg2
        conn = psycopg2.connect(TEST_URL)
        with conn, conn.cursor() as cur:
            cur.execute("""
              insert into crm_users (email, display_name, password_hash) values ('alex@rebattery.io', 'Alex', 'x') on conflict do nothing;
              insert into crm_bulk_trade_lots (id, lot_kind, title, summary, observed_outcome, confidence, trade_stage)
                values ('bt_hist', 'supply', 'History trade', '', '', 'confirmed', 'Needs info') on conflict do nothing;
              insert into crm_bulk_trade_contacts (id, lot_id, name, email) values ('btc_hist', 'bt_hist', 'Nic', 'nic@oem.test') on conflict do nothing;
              insert into crm_email_messages (id, subject, sent_at, created_at, body, gmail_message_id, from_email, mailbox_owner_id)
                select v.id, 'Batch', v.at::timestamptz, now(), v.body, v.gid, 'nic@oem.test', u.id
                from crm_users u, (values
                  ('h1', '2025-05-01', 'We have 600 packs of 23.8 kWh. ' || repeat('Older context. ', 1200), 'g-h1'),
                  ('h2', '2026-09-20', 'Update: 580 packs remain available.', 'g-h2')) as v(id, at, body, gid)
                where u.email = 'alex@rebattery.io' on conflict do nothing;
              insert into crm_email_messages (id, subject, sent_at, created_at, body, gmail_message_id, from_email, mailbox_owner_id)
                select 'h-other', 'Other', now(), now(), 'Unrelated 999 packs', 'g-other', 'someone@else.test', id
                from crm_users where email = 'alex@rebattery.io' on conflict do nothing;
              insert into crm_email_messages (id, subject, sent_at, created_at, body, gmail_message_id, from_email, mailbox_owner_id)
                select 'h-serbia', 'Serbian packs for Ecovip', '2026-03-26', now(), 'Customer is Ecovip. 300 Serbian packs.', 'g-serbia',
                       'nic@oem.test', id from crm_users where email = 'alex@rebattery.io' on conflict do nothing;
            """)
        seen, placed = [], []

        def fake_model(system, user, key):
            if system is check.THREAD_SYSTEM:
                threads = json.loads(user)["THREADS"]
                placed.extend(t["key"] for t in threads)
                return {"threads": [{"key": t["key"], "verdict": "none" if "Serbian" in t["subject"] else "trade",
                                     "trade_id": "bt_hist", "reason": "older Ecovip deal" if "Serbian" in t["subject"] else "this batch"}
                                    for t in threads]}
            batch = json.loads(user)["SOURCES"]
            seen.append([s["source_id"] for s in batch])
            if batch[0]["source_id"] == "g-h1":
                return {"proposals": [
                    {"kind": "trade_kind", "proposed": {"trade_kind": "packs"}, "summary": "Packs", "quote": "We have 600 packs", "source_id": "g-h1"},
                    {"kind": "field", "target": "quantity", "proposed": {"value": "600 packs"}, "summary": "Qty", "quote": "We have 600 packs", "source_id": "g-h1"}]}
            return {"proposals": [
                {"kind": "field", "target": "quantity", "proposed": {"value": "580 packs"}, "summary": "Qty now", "quote": "580 packs remain available", "source_id": "g-h2"}]}

        args = type("Args", (), {"mailbox": "alex@rebattery.io", "history": "bt_hist", "dry_run": False})
        with patch.object(check, "call_model", fake_model), patch.object(check, "refresh_granola", lambda: None), \
             patch.object(check, "load_granola", lambda since: []), patch.dict(os.environ, {"HERMES_API_KEY": "test"}), \
             patch.object(check, "HISTORY_BATCH_CHARS", 8050):
            with redirect_stdout(io.StringIO()):
                check.history(conn, args)
        with conn.cursor() as cur:
            cur.execute("select kind, status from crm_bulk_trade_proposals where lot_id = 'bt_hist' order by id")
            rows = cur.fetchall()
            cur.execute("select value from crm_bulk_trade_fields where lot_id = 'bt_hist' and field_key = 'quantity'")
            quantity = cur.fetchone()[0]
            cur.execute("select trade_kind from crm_bulk_trade_lots where id = 'bt_hist'")
            kind = cur.fetchone()[0]
            cur.execute("select thread_key, verdict from crm_bulk_trade_threads where thread_key like 'gmail-message:g-%%' order by 1")
            verdicts = dict(cur.fetchall())
            cur.execute("select kind, status, emails_read from crm_bulk_trade_check_runs where lot_id = 'bt_hist'")
            run = cur.fetchone()
        conn.close()
        self.assertEqual(sorted(placed), ["gmail-message:g-h1", "gmail-message:g-h2", "gmail-message:g-serbia"])
        self.assertEqual(seen, [["g-h1"], ["g-h2"]])  # the older Ecovip deal is never read; oldest first
        self.assertEqual(verdicts["gmail-message:g-serbia"], "none")
        self.assertEqual(sorted(rows), [("field", "applied"), ("trade_kind", "applied")])
        self.assertEqual((quantity, kind), ("580 packs", "packs"))
        self.assertEqual(run, ("history", "ok", 3))


@unittest.skipUnless(TEST_URL, "needs a disposable database: scripts/rebattery/crm-test-db.sh up")
class DemandRun(unittest.TestCase):
    def setUp(self):
        import psycopg2
        self.conn = psycopg2.connect(TEST_URL)
        with self.conn, self.conn.cursor() as cur:
            cur.execute("""
              insert into crm_bulk_trade_lots (id, lot_kind, title, summary, observed_outcome, confidence, trade_stage, trade_kind)
                values ('bt_dem', 'supply', 'Demand match trade', '', '', 'confirmed', 'With buyers', 'packs') on conflict do nothing;
              insert into crm_bulk_trade_demand (id, buyer, email, wants, confirmed_on)
                values ('btd_open', 'Green Voltage', 'adam@gv.example', 'Matched packs in repeat batches', '2026-09-18'),
                       ('btd_hid', 'Somerset EV', null, 'MEB modules', '2026-08-14') on conflict do nothing;
              insert into crm_bulk_trade_demand_matches (demand_id, lot_id, strength, reason, hidden)
                values ('btd_hid', 'bt_dem', 'partial', 'old', true) on conflict do nothing;
              update crm_bulk_trade_demand set status = 'open', closed_reason = null where id in ('btd_open', 'btd_hid');
            """)

    def tearDown(self):
        self.conn.close()

    def test_screen_turns_buy_requests_into_cards_and_updates_known_buyers(self):
        new = {**SOURCE, "id": "d1", "from": "dawid.py@revoxa.example",
               "text": "Subject: LFP\n\nWe are looking for LFP batteries from EV or BESS applications, complete packs or modules."}
        known = {**SOURCE, "id": "d2", "from": "adam@gv.example",
                 "text": "Subject: packs\n\nCan you supply matched packs or modules in repeat batches, with test data?"}
        seller = {**SOURCE, "id": "d3", "text": "Subject: stock\n\nWe have 400 packs available. Are you looking for batteries?"}
        reply = {"demands": [
            {"source_id": "d1", "buyer_company": "Revoxa py buyer", "contact_email": "dawid.py@revoxa.example", "wants": "LFP packs or modules",
             "quote": "We are looking for LFP batteries from EV or BESS applications"},
            {"source_id": "d2", "buyer_company": "Green Voltage", "wants": "Matched packs, repeat batches",
             "quote": "Can you supply matched packs or modules in repeat batches"},
            {"source_id": "d3", "buyer_company": "Seller", "wants": "packs", "quote": "an invented line that is not there"},
        ]}
        report = {"warnings": []}
        with self.conn.cursor(cursor_factory=check.psycopg2.extras.RealDictCursor) as cur, \
             patch.object(check, "call_model", lambda system, user, key: reply):
            cards = check.screen_demand(cur, [new, known, seller], "k", report)
        self.assertEqual([(c["kind"], c["proposed"]["buyer"]) for c in cards],
                         [("possible_demand", "Revoxa py buyer"), ("possible_demand", "Green Voltage")])
        self.assertEqual(cards[0]["proposed"]["email"], "dawid.py@revoxa.example")

    def test_email_demand_is_added_closes_estimates_and_a_no_opts_out(self):
        with self.conn, self.conn.cursor() as cur:
            cur.execute("""
              insert into crm_companies (id, name, purpose, relationship_stage) values
                ('co_auto', 'Auto Cells Ltd', '{Buyer}', 'Contacted'), ('co_no', 'No Thanks Ltd', '{Buyer}', 'Contacted')
                on conflict do nothing;
              insert into crm_people (id, full_name, email, company_id, tags) values
                ('p_auto', 'Fern', 'fern@autocells.example', 'co_auto', '{"Supply Update"}'),
                ('p_no', 'Nia', 'nia@nothanks.example', 'co_no', '{"Supply Update"}') on conflict do nothing;
              insert into crm_bulk_trade_demand (id, buyer, company_id, email, wants, kind, basis) values
                ('btd_est_auto', 'Auto Cells Ltd', 'co_auto', 'fern@autocells.example', 'Cells and modules', 'standing', 'estimated')
                on conflict do nothing;""")
        reply_source = {**SOURCE, "id": "r1", "from": "fern@autocells.example",
                        "text": "Subject: Re: packs\nFrom: fern@autocells.example\n\nWe'd be interested in cells, not packs."}
        no_source = {**SOURCE, "id": "r2", "from": "nia@nothanks.example",
                     "text": "Subject: Re: packs\nFrom: nia@nothanks.example\n\nNot interested, we don't buy batteries."}
        demand = {"kind": "possible_demand", "target": None, "quote": "We'd be interested in cells, not packs.", "source": reply_source,
                  "summary": "Auto Cells Ltd wants: Cells", "proposed": {"buyer": "Auto Cells Ltd", "email": "fern@autocells.example",
                  "wants": "Cells, not packs", "kind": "standing", "spec": {"formats": ["Cells"]}}}
        decline = {"kind": "decline", "target": None, "quote": "Not interested, we don't buy batteries.", "source": no_source,
                   "summary": "nia@nothanks.example is not interested",
                   "proposed": {"decision": "not_interested", "email": "nia@nothanks.example"}}
        report = {"applied": [], "cards": [], "warnings": []}
        ctx = {"warnings": report["warnings"]}
        with self.conn, self.conn.cursor(cursor_factory=check.psycopg2.extras.RealDictCursor) as cur:
            check.mark_replies(cur, [reply_source, no_source], {"fern@autocells.example", "nia@nothanks.example"}, report, False)
            check.settle_all(cur, None, None, [demand], None, ctx, report, False)
            check.settle_declines(cur, [decline], report, False)
            check.settle_all(cur, None, None, [demand], None, ctx, report, False)  # the same email again changes nothing
            cur.execute("select status, basis, wants, company_id from crm_bulk_trade_demand where company_id = 'co_auto' order by basis")
            rows = cur.fetchall()
            cur.execute("select id, relationship_stage, buyer_stage, buyer_exclusion_reason from crm_companies where id in ('co_auto', 'co_no') order by id")
            companies = {r["id"]: r for r in cur.fetchall()}
            cur.execute("select status from crm_subscriptions where person_id = 'p_no' and list = 'Supply update'")
            sub = cur.fetchone()
            cur.execute("select tags from crm_people where id = 'p_no'")
            tags = cur.fetchone()["tags"]
        self.assertEqual([(r["status"], r["basis"], r["wants"]) for r in rows],
                         [("closed", "estimated", "Cells and modules"), ("open", "stated", "Cells, not packs")])
        self.assertEqual(len(report["applied"]), 1)  # the same email a second time is already recorded
        self.assertEqual(report["declines"], ["nia@nothanks.example is not interested"])
        self.assertEqual((companies["co_auto"]["relationship_stage"], companies["co_auto"]["buyer_stage"]), ("Engaged", "Responded"))
        self.assertEqual(companies["co_no"]["relationship_stage"], "Excluded")
        self.assertIn("Not interested", companies["co_no"]["buyer_exclusion_reason"])
        self.assertEqual(sub["status"], "Opted out")
        self.assertNotIn("Supply Update", tags)

    def test_an_unknown_buyer_or_seller_becomes_a_classified_lead(self):
        buyer_src = {**SOURCE, "id": "l1", "from": "ola@newbuyer.example",
                     "text": "Subject: packs\nFrom: ola@newbuyer.example\n\nWe are looking for 20 Nissan Leaf packs."}
        demand = {"kind": "possible_demand", "target": None, "quote": "We are looking for 20 Nissan Leaf packs.",
                  "source": buyer_src, "summary": "New Buyer AS wants: Nissan Leaf packs",
                  "proposed": {"buyer": "New Buyer AS", "contact": "Ola Nordmann", "email": "ola@newbuyer.example",
                               "wants": "Nissan Leaf packs", "kind": "request"}}
        report = {"applied": [], "cards": [], "warnings": []}
        with self.conn, self.conn.cursor(cursor_factory=check.psycopg2.extras.RealDictCursor) as cur:
            check.settle_all(cur, None, None, [demand], None, {"warnings": report["warnings"]}, report, False)
            seller = check.ensure_lead(cur, "sales@newseller.example", None, None, "Supplier", "Inbox check 2026-10-02: offered 500 packs")
            cur.execute("""select c.name, c.domain, c.purpose, c.relationship_stage, c.source, p.full_name, c.buyer_main_contact_id = p.id as main
                           from crm_people p join crm_companies c on c.id = p.company_id
                           where p.email in ('ola@newbuyer.example', 'sales@newseller.example') order by p.email""")
            rows = cur.fetchall()
            cur.execute("select company_id is not null as linked from crm_bulk_trade_demand where email = 'ola@newbuyer.example'")
            linked = cur.fetchone()["linked"]
        self.assertTrue(linked)
        self.assertEqual([(r["name"], r["purpose"], r["relationship_stage"], r["source"], r["main"]) for r in rows],
                         [("New Buyer AS", ["Buyer"], "Engaged", "Inbound", True), ("Newseller", ["Supplier"], "Engaged", "Inbound", True)])
        self.assertIsNotNone(seller[1])

    def test_auto_replies_do_not_count_as_a_reply(self):
        away = {**SOURCE, "id": "r3", "from": "away@ooo.example", "title": "Automatic reply: packs",
                "text": "Subject: Automatic reply: packs\nFrom: away@ooo.example\n\nI am out of the office."}
        report = {}
        with self.conn.cursor(cursor_factory=check.psycopg2.extras.RealDictCursor) as cur:
            check.mark_replies(cur, [away], {"away@ooo.example"}, report, True)
        self.assertEqual(report["engaged"], [])

    def test_matching_judges_only_what_changed_and_keeps_not_a_fit_hidden(self):
        with self.conn, self.conn.cursor() as cur:  # start from a trade and rows never judged
            cur.execute("""update crm_bulk_trade_lots set demand_fingerprint = null where id = 'bt_dem';
                           update crm_bulk_trade_demand set match_hash = null, status = 'open', closed_reason = null,
                             wants = 'Matched packs in repeat batches' where id in ('btd_open', 'btd_hid');
                           delete from crm_bulk_trade_demand_matches where lot_id = 'bt_dem' and not hidden;""")
        calls = []

        def fake_model(system, user, key):
            payload = json.loads(user)
            calls.append(([t["title"] for t in payload["TRADES"]], [d["buyer"] for d in payload["DEMAND"]]))
            trade = next((t["trade"] for t in payload["TRADES"] if t["title"] == "Demand match trade"), None)
            label = {d["buyer"]: d["row"] for d in payload["DEMAND"]}
            return {"matches": [{"trade": trade, "row": label.get("Green Voltage"), "buyer": "Green Voltage", "strength": "strong", "reason": "A matched lot"},
                                {"trade": trade, "row": label.get("Somerset EV"), "buyer": "Somerset EV", "strength": "partial", "reason": "Packs, not modules"},
                                {"trade": trade, "row": "R999", "buyer": "Nobody", "strength": "strong", "reason": "not a real row"},
                                {"trade": "T99", "row": label.get("Green Voltage"), "buyer": "Green Voltage", "strength": "strong", "reason": "not a trade"}]}

        def ours():
            return [c for c in calls if "Demand match trade" in c[0]]

        def matches():
            with self.conn.cursor() as cur:
                cur.execute("select demand_id, strength, hidden from crm_bulk_trade_demand_matches where lot_id = 'bt_dem' order by 1")
                return cur.fetchall()

        with patch.object(check, "call_model", fake_model):
            first = check.match_demand(self.conn, "k")
            self.assertEqual(len(ours()), 1)  # the new trade, against every open row
            self.assertEqual(matches(), [("btd_hid", "partial", True), ("btd_open", "strong", False)])
            self.assertEqual(first["warnings"], [])

            calls.clear()
            again = check.match_demand(self.conn, "k")
            with self.conn, self.conn.cursor() as cur:  # "Still wanted": not a matching change
                cur.execute("update crm_bulk_trade_demand set confirmed_on = current_date, updated_at = now() where id = 'btd_open'")
            check.match_demand(self.conn, "k")
            self.assertEqual((calls, again["model_calls"]), ([], 0))

            with self.conn, self.conn.cursor() as cur:  # a changed want: that row only, against the steady trades
                cur.execute("update crm_bulk_trade_demand set wants = 'Matched packs, 300 kWh builds' where id = 'btd_open'")
            check.match_demand(self.conn, "k")
            self.assertEqual(len(calls), 1)
            self.assertIn("Demand match trade", calls[0][0])
            self.assertEqual(calls[0][1], ["Green Voltage"])

            calls.clear()
            with self.conn, self.conn.cursor() as cur:  # closed: suggestion gone, no call
                cur.execute("update crm_bulk_trade_demand set status = 'closed', closed_reason = 'other' where id = 'btd_open'")
            check.match_demand(self.conn, "k")
            self.assertEqual(calls, [])
            self.assertEqual(matches(), [("btd_hid", "partial", True)])
        with self.conn.cursor() as cur:
            cur.execute("select status from crm_bulk_trade_check_runs where kind = 'match' order by id desc limit 1")
            self.assertEqual(cur.fetchone(), ("ok",))

    def test_judge_keeps_the_first_of_a_repeated_pair(self):
        reply = {"matches": [{"row": "R1", "buyer": "Acme Energy", "strength": "strong", "reason": "first"},
                             {"row": "R1", "buyer": "Acme Energy", "strength": "partial", "reason": "again"},
                             {"row": "R2", "buyer": "Acme Energy", "strength": "strong", "reason": "names the wrong row"}]}
        sent = []
        report = {"model_calls": 0, "warnings": []}
        with patch.object(check, "call_model", lambda system, user, key: sent.append(json.loads(user)) or reply):
            pairs = check.judge([("lot1", {})], [{"id": "d1", "buyer": "Acme Energy Ltd"}, {"id": "d2", "buyer": "Volt Co"}], "k", report)
        self.assertEqual(pairs, [{"lot_id": "lot1", "demand_id": "d1", "strength": "strong", "reason": "first"}])
        self.assertEqual(report["dropped"], 1)
        self.assertEqual([r["row"] for r in sent[0]["DEMAND"]], ["R1", "R2"])
        self.assertNotIn("id", sent[0]["DEMAND"][0])  # long ids never reach the model

    def test_matching_gives_the_seller_price_and_survives_a_model_failure(self):
        with self.conn, self.conn.cursor() as cur:
            cur.execute("""insert into crm_bulk_trade_fields (lot_id, field_key, value) values ('bt_dem', 'seller_price', '€29/kWh')
                           on conflict (lot_id, field_key) do update set value = excluded.value""")
        seen = []

        def failing(system, user, key):
            seen.append(json.loads(user))
            raise TimeoutError()

        with patch.object(check, "call_model", failing):
            out = check.match_demand(self.conn, "k")
        mine = [t for payload in seen for t in payload["TRADES"] if t["title"] == "Demand match trade"]
        self.assertEqual(mine[0]["fields"]["seller_price"], "€29/kWh")
        self.assertIn("demand matching failed (TimeoutError)", out["warnings"])
        with self.conn.cursor() as cur:  # not recorded as judged, so the next pass tries again
            cur.execute("select demand_fingerprint from crm_bulk_trade_lots where id = 'bt_dem'")
            fingerprint = cur.fetchone()[0]
        with patch.object(check, "call_model", lambda system, user, key: {"matches": []}):
            retry = check.match_demand(self.conn, "k")
        self.assertGreaterEqual(retry["model_calls"], 1)
        with self.conn.cursor() as cur:
            cur.execute("select demand_fingerprint from crm_bulk_trade_lots where id = 'bt_dem'")
            self.assertNotEqual(cur.fetchone()[0], fingerprint)


    def test_screen_keeps_a_requests_date_volume_and_valid_spec_only(self):
        source = {**SOURCE, "id": "d9", "from": "rahul.py@exigo.example",
                  "text": "Subject: cells\n\nWe need 1,000 LFP cells by 20 October, max EUR 30/kWh."}
        reply = {"demands": [{"source_id": "d9", "buyer_company": "Exigo py", "wants": "1,000 LFP cells", "kind": "request",
                              "needed_by": "2026-10-20", "volume": 1000, "volume_unit": "cells", "max_price": 30,
                              "price_currency": "EUR", "price_unit": "kWh",
                              "spec": {"chemistries": ["LFP", "Graphene"], "formats": ["Cells"], "min_soh": 150},
                              "quote": "We need 1,000 LFP cells by 20 October"}]}
        with self.conn.cursor(cursor_factory=check.psycopg2.extras.RealDictCursor) as cur, \
             patch.object(check, "call_model", lambda system, user, key: reply):
            [card] = check.screen_demand(cur, [source], "k", {"warnings": []})
        self.assertEqual(card["summary"], "Exigo py needs: 1,000 LFP cells")
        self.assertEqual({k: card["proposed"][k] for k in ("kind", "needed_by", "volume", "volume_unit", "max_price", "spec")},
                         {"kind": "request", "needed_by": "2026-10-20", "volume": 1000, "volume_unit": "cells", "max_price": 30,
                          "spec": {"chemistries": ["LFP"], "formats": ["Cells"]}})

    def test_clean_structured_drops_dates_on_standing_rows_and_half_prices(self):
        self.assertEqual(check.clean_structured({"kind": "standing", "needed_by": "2026-10-20", "volume": 8, "volume_unit": "packs",
                                                 "max_price": 20, "price_currency": "EUR"}),
                         {"kind": "standing", "volume": 8, "volume_unit": "packs"})
        self.assertEqual(check.clean_structured({"kind": "weekly", "volume": True, "volume_unit": "packs",
                                                 "spec": {"kwh_min": 60, "kwh_max": 30, "mixed_ok": "yes"}}), {})

    def test_matching_sends_kind_basis_and_spec_and_skips_requests_past_their_date(self):
        with self.conn, self.conn.cursor() as cur:
            cur.execute("""insert into crm_bulk_trade_demand (id, kind, basis, buyer, wants, needed_by, spec) values
                             ('btd_req', 'request', null, 'Live request', 'LFP cells', '2099-01-01', '{"chemistries": ["LFP"]}'),
                             ('btd_late', 'request', null, 'Late request', 'LFP cells', '2020-01-01', '{}'),
                             ('btd_est', 'standing', 'estimated', 'Gridturn', 'EV modules', null, '{}')
                           on conflict do nothing""")
        seen = []

        def fake_model(system, user, key):
            seen.extend(json.loads(user)["DEMAND"])
            return {"matches": []}

        with patch.object(check, "call_model", fake_model):
            check.match_demand(self.conn, "k", {"warnings": []})
        rows = {r["buyer"]: r for r in seen}
        self.assertNotIn("Late request", rows)
        self.assertEqual({k: rows["Live request"][k] for k in ("kind", "needed_by", "spec")},
                         {"kind": "request", "needed_by": "2099-01-01", "spec": {"chemistries": ["LFP"]}})
        self.assertEqual(rows["Gridturn"]["basis"], "estimated")
        self.assertNotIn("spec", rows["Gridturn"])  # empty values are left out

    def test_matching_sees_where_the_buyer_is(self):
        with self.conn, self.conn.cursor() as cur:
            cur.execute("""insert into crm_companies (id, name, country, region) values ('co_where', 'Where Buyer', 'Poland', 'CEE')
                           on conflict do nothing;
                           insert into crm_bulk_trade_demand (id, kind, basis, buyer, company_id, wants) values
                             ('btd_where', 'standing', 'stated', 'Where Buyer', 'co_where', 'NMC modules')
                           on conflict do nothing""")
        seen = []

        def fake_model(system, user, key):
            seen.extend(json.loads(user)["DEMAND"])
            return {"matches": []}

        with patch.object(check, "call_model", fake_model):
            check.match_demand(self.conn, "k", {"warnings": []})
        row = next(r for r in seen if r["buyer"] == "Where Buyer")
        self.assertEqual((row["buyer_country"], row["buyer_region"]), ("Poland", "CEE"))

    def test_summary_flags_new_companies_missing_purpose_source_or_country(self):
        with self.conn, self.conn.cursor() as cur:
            cur.execute("""insert into crm_companies (id, name, purpose, source, country) values
                             ('co_sum_bare', 'Bare New Co', null, null, null),
                             ('co_sum_full', 'Full New Co', '{Buyer}', 'Inbound', 'Germany')
                           on conflict do nothing;
                           insert into crm_companies (id, name, tags) values ('co_sum_auto', 'Auto.com', '{auto-created}')
                           on conflict do nothing;
                           insert into crm_companies (id, name, source, source_detail) values
                             ('co_sum_lead', 'Lead Co', 'Inbound', 'Inbox check 2026-10-02: wants packs') on conflict do nothing""")
        with self.conn.cursor(cursor_factory=check.psycopg2.extras.RealDictCursor) as cur:
            names = check.unclassified_companies(cur)
        self.assertIn("Bare New Co", names)
        self.assertNotIn("Full New Co", names)
        self.assertNotIn("Auto.com", names)
        self.assertNotIn("Lead Co", names)  # listed under "New leads from email" instead
        out = io.StringIO()
        with redirect_stdout(out):
            check.summary(self.conn)
        self.assertIn("- Lead Co: wants packs", out.getvalue().split("New leads from email:", 1)[1])

    def test_matching_sees_the_note(self):
        with self.conn, self.conn.cursor() as cur:
            cur.execute("""insert into crm_bulk_trade_demand (id, buyer, wants, note) values
                             ('btd_note', 'Volt buyer', 'EV packs', 'Voltage: 48V') on conflict do nothing""")
        seen = []
        with patch.object(check, "call_model", lambda system, user, key: seen.extend(json.loads(user)["DEMAND"]) or {"matches": []}):
            check.match_demand(self.conn, "k", {"warnings": []})
        self.assertEqual({r["buyer"]: r.get("note") for r in seen}["Volt buyer"], "Voltage: 48V")

    def test_summary_lists_buyers_waiting_requests_due_and_buy_boxes_to_reconfirm(self):
        today = dt.datetime.now(ZoneInfo("Europe/London")).date()
        with self.conn, self.conn.cursor() as cur:
            cur.execute("""
              insert into crm_companies (id, name) values ('co_wait', 'Waiting Energy') on conflict do nothing;
              insert into crm_people (id, full_name, email, company_id) values
                ('p_wait', 'Wanda Waiting', 'wanda@waiting.example', 'co_wait'),
                ('p_done', 'Dan Answered', 'dan@answered.example', null),
                ('p_ooo', 'Otto Away', 'otto@away.example', null) on conflict do nothing;
              insert into crm_bulk_trade_lots (id, lot_kind, title, summary, observed_outcome, confidence, trade_stage, trade_kind)
                values ('bt_sum', 'supply', 'Summary trade', '', '', 'confirmed', 'With buyers', 'cells') on conflict do nothing;
              insert into crm_bulk_trade_demand (id, kind, basis, buyer, person_id, company_id, wants, needed_by, confirmed_on) values
                ('btd_w', 'standing', 'agreed', 'Waiting Energy', 'p_wait', 'co_wait', 'LFP packs', null, '2026-01-05'),
                ('btd_d', 'standing', 'stated', 'Answered Ltd', 'p_done', null, 'Modules', null, %(today)s),
                ('btd_o', 'request', null, 'Away GmbH', 'p_ooo', null, 'CATL cells', %(soon)s, %(today)s) on conflict do nothing;
              insert into crm_email_messages (id, subject, sent_at, from_person_id, from_email) values
                ('m_out_w', 'Offer', now() - interval '5 days', null, 'alex@rebattery.io'),
                ('m_in_w', 'Re: Offer, can you do 40 packs?', now() - interval '3 days', 'p_wait', 'wanda@waiting.example'),
                ('m_in_d', 'Question', now() - interval '3 days', 'p_done', 'dan@answered.example'),
                ('m_out_d', 'Re: Question', now() - interval '2 days', null, 'ari@rebattery.io'),
                ('m_out_o', 'Cells', now() - interval '2 days', null, 'alex@rebattery.io'),
                ('m_in_o', 'Automatic reply: Cells', now() - interval '1 day', 'p_ooo', 'otto@away.example') on conflict do nothing;
              insert into crm_email_message_recipients (message_id, person_id, recipient_type) values
                ('m_out_w', 'p_wait', 'to'), ('m_out_d', 'p_done', 'cc'), ('m_out_o', 'p_ooo', 'to') on conflict do nothing;
              -- Added to a trade but not contacted yet: still no offer.
              insert into crm_bulk_trade_buyers (id, lot_id, name, status, demand_id) values ('b_sum', 'bt_sum', 'Away GmbH', 'To contact', 'btd_o')
                on conflict do nothing;
            """, {"today": today, "soon": today + dt.timedelta(days=3)})
        out = io.StringIO()
        with redirect_stdout(out):
            check.summary(self.conn)
        text = out.getvalue()
        self.assertIn("Buyers waiting on you:\n- Wanda Waiting (Waiting Energy): Re: Offer, can you do 40 packs? [3d]", text)
        self.assertNotIn("Dan Answered", text)  # Ari answered from the other mailbox
        self.assertNotIn("Otto Away", text)  # an auto-reply is not waiting on us
        self.assertIn("- Request from Away GmbH: CATL cells, needed in 3d, no offer yet", text)
        self.assertIn("Buy-boxes to reconfirm: Waiting Energy (agreed)", text)
        self.assertNotIn("Answered Ltd", text.split("Buy-boxes to reconfirm:")[1])

if __name__ == "__main__":
    unittest.main()

