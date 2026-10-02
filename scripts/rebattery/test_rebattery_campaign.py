import importlib.util
import os
import unittest
import json
import tempfile
from pathlib import Path
from unittest.mock import patch
import urllib.error
import io
from contextlib import redirect_stdout, redirect_stderr
from datetime import date
from uuid import uuid4

import psycopg2
from psycopg2.extras import RealDictCursor


spec = importlib.util.spec_from_file_location("rebattery_campaign", Path(__file__).with_name("rebattery-campaign.py"))
campaign = importlib.util.module_from_spec(spec)
spec.loader.exec_module(campaign)


MANIFEST = {
    "id": "test-campaign", "name": "Test auction", "objective": "Verify tracking",
    "success_measure": "Two accepted messages", "listing_id": "listing-1",
    "auction_url": "https://www.rebattery.io/marketplace/auctions/test-lot",
    "stock_snapshot_ref": "listing-1@2026-09-23", "message_version": "v1",
    "sender": "supply@example.com", "reply_to": "replies@example.com",
    "reply_owner": "Alex", "subject": "Auction test",
    "html": "<a href='https://www.rebattery.io/marketplace/auctions/test-lot'>Auction</a> <a href='https://form.typeform.com/to/MbMTVSu8'>Sourcing</a> <a href='{{{ pm:unsubscribe }}}'>Unsubscribe</a> {{ render_name }}",
    "text": "Auction https://www.rebattery.io/marketplace/auctions/test-lot\nSourcing https://form.typeform.com/to/MbMTVSu8\nUnsubscribe {{{ pm:unsubscribe }}}\n{{ render_name }}",
    "links": [
        {"key": "test-lot", "url": "https://www.rebattery.io/marketplace/auctions/test-lot", "listing_id": "listing-1"},
        {"key": "sourcing", "url": "https://form.typeform.com/to/MbMTVSu8"},
    ],
    "stream": "broadcasts", "person_ids": ["p1"],
    "personalization": {"render_name": "first_name"},
}
ROWS = [{"person_id": "p1", "company_id": "c1", "email": "buyer@example.com", "first_name": "Buyer",
         "personalization": {"render_name": "Buyer"}, "subject": "Auction test Buyer",
         "html": "<a href='https://www.rebattery.io/marketplace/auctions/test-lot'>Auction</a> Buyer",
         "text": "Auction https://www.rebattery.io/marketplace/auctions/test-lot\nBuyer"}]


class FakeCursor:
    def __init__(self, state):
        self.state = state
        self.result = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def execute(self, sql, params):
        if "from campaigns where id" in sql:
            self.result = (1,)
        elif "from crm_campaign_sends" in sql and "order by recipient_email" in sql:
            self.result = ROWS
        elif "state='frozen'" in sql and "order by recipient_email limit" in sql:
            self.result = ROWS[:params[-1]]
        elif "state in ('sending','unknown')" in sql:
            self.result = (0,)
        elif "returning s.id" in sql:
            if self.state["send_state"] == "frozen":
                self.state["send_state"] = "sending"
                self.result = ("send-1",)
            else:
                self.result = None
        elif "set state='unknown'" in sql:
            self.state["send_state"] = "unknown"
        elif "set state=%s where id=%s" in sql:
            self.state["send_state"] = params[0]

    def fetchone(self):
        return self.result

    def fetchall(self):
        return self.result


class FakeConnection:
    def __init__(self, state):
        self.state = state

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def cursor(self, **_):
        return FakeCursor(self.state)


class CampaignTest(unittest.TestCase):
    def test_freeze_stores_personalized_bodies_and_bounded_launch(self):
        statements = []

        class Cursor:
            def __enter__(self):
                return self
            def __exit__(self, *_):
                pass
            def execute(self, sql, params):
                statements.append((sql, params))
            def fetchone(self):
                return None

        class Db:
            def __enter__(self):
                return self
            def __exit__(self, *_):
                pass
            def cursor(self):
                return Cursor()

        recipients = [{**row, "first_name": "Buyer", "personalization": {"render_name": "Buyer"},
                       "subject": f"Auction test Buyer {row['person_id']}",
                       "html": f"Frozen personalized body {row['person_id']}",
                       "text": f"Frozen personalized text {row['person_id']}"} for row in
                      (ROWS[0], {"person_id": "p2", "company_id": "c2", "email": "two@example.com"})]
        with patch.object(campaign, "connection", return_value=Db()):
            campaign.freeze(MANIFEST, recipients, campaign.digest(MANIFEST, recipients))
        frozen_sends = [params for sql, params in statements if "insert into crm_campaign_sends" in sql]
        self.assertEqual(len(frozen_sends), 2)
        self.assertEqual({params[8] for params in frozen_sends},
                         {"Auction test Buyer p1", "Auction test Buyer p2"})
        self.assertIn("Frozen personalized body p1", {params[9] for params in frozen_sends})
        self.assertIn("Frozen personalized text p2", {params[10] for params in frozen_sends})
        frozen_links = [params for sql, params in statements if "insert into crm_campaign_send_links" in sql]
        self.assertEqual(len(frozen_links), 4)
        self.assertEqual({params[2] for params in frozen_links}, {"test-lot", "sourcing"})
        self.assertEqual(len({params[0] for params in frozen_links}), 4)
        with patch.dict(os.environ, {"DENCH_CAMPAIGN_LIVE_SEND": "1"}):
            with self.assertRaisesRegex(ValueError, "at least one"):
                campaign.launch(MANIFEST, campaign.digest(MANIFEST, recipients[:1]), 0)

    def test_manifest_digest_binds_recipient_and_body(self):
        approved = campaign.digest(MANIFEST, ROWS)
        self.assertNotEqual(approved, campaign.digest({**MANIFEST, "html": "changed"}, ROWS))
        self.assertNotEqual(approved, campaign.digest(MANIFEST, [{**ROWS[0], "email": "other@example.com"}]))
        self.assertNotEqual(approved, campaign.digest({**MANIFEST, "links": MANIFEST["links"][:1]}, ROWS))

    def test_digest_ignores_cohort_order_but_binds_every_identity(self):
        rows = [
            {"person_id": "p1", "company_id": "c1", "email": "a.b@example.com"},
            {"person_id": "p2", "company_id": "c2", "email": "ab@example.com"},
        ]
        approved = campaign.digest(MANIFEST, rows)
        self.assertEqual(approved, campaign.digest(MANIFEST, list(reversed(rows))))
        self.assertNotEqual(approved, campaign.digest(MANIFEST, rows[:1]))
        self.assertNotEqual(approved, campaign.digest(MANIFEST, [
            rows[0], {**rows[1], "person_id": "different-person"},
        ]))
        self.assertNotEqual(approved, campaign.digest(MANIFEST, [
            rows[0], {**rows[1], "company_id": "different-company"},
        ]))

    def test_manifest_requires_explicit_links_and_unsubscribe_in_both_bodies(self):
        for invalid in (
            {**MANIFEST, "text": MANIFEST["text"].replace("{{{ pm:unsubscribe }}}", "")},
            {**MANIFEST, "links": MANIFEST["links"][:1]},
            {**MANIFEST, "links": [*MANIFEST["links"], {"key": "extra", "url": "https://evil.test/path"}]},
        ):
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "manifest.json"
                path.write_text(json.dumps(invalid))
                with self.assertRaises(ValueError):
                    campaign.load_manifest(path)

    def test_unknown_send_stops_and_cannot_be_retried(self):
        state = {"send_state": "frozen"}
        sha = campaign.digest(MANIFEST, ROWS)
        with patch.dict(os.environ, {"DENCH_CAMPAIGN_LIVE_SEND": "1"}), \
             patch.object(campaign, "connection", side_effect=lambda **_: FakeConnection(state)), \
             patch.object(campaign, "provider_preflight"), \
             patch.object(campaign, "postmark", side_effect=urllib.error.URLError("timeout")) as send:
            result = campaign.launch(MANIFEST, sha, 1)
            self.assertEqual(state["send_state"], "unknown")
            self.assertEqual(result[0][1], "unknown: URLError")
            self.assertEqual(campaign.launch(MANIFEST, sha, 1)[0][1], "skipped: already claimed or suppressed")
            self.assertEqual(send.call_count, 1)

    def test_provider_preflight_rejects_suppressed_address(self):
        responses = [{"MessageStreamType": "Broadcasts", "ArchivedAt": None,
                      "SubscriptionManagementConfiguration": {"UnsubscribeHandlingType": "Postmark"}},
                     {"Suppressions": [{"EmailAddress": "buyer@example.com", "SuppressionReason": "HardBounce",
                                        "Origin": "Recipient", "CreatedAt": "2026-10-01T23:30:00-05:00"}]}]
        with patch.object(campaign, "postmark", side_effect=responses):
            with self.assertRaisesRegex(ValueError, "suppressed"):
                campaign.provider_preflight(MANIFEST, ROWS)

    def test_definite_provider_rejection_is_failed_not_unknown(self):
        state = {"send_state": "frozen"}
        rejected = urllib.error.HTTPError("https://api.postmarkapp.com/email", 401, "Unauthorized", {}, None)
        with patch.dict(os.environ, {"DENCH_CAMPAIGN_LIVE_SEND": "1"}), \
             patch.object(campaign, "connection", side_effect=lambda **_: FakeConnection(state)), \
             patch.object(campaign, "provider_preflight"), \
             patch.object(campaign, "postmark", side_effect=rejected):
            result = campaign.launch(MANIFEST, campaign.digest(MANIFEST, ROWS), 1)
        self.assertEqual(state["send_state"], "failed")
        self.assertIn("HTTP 401", result[0][1])

    def test_clicks_attribute_each_frozen_destination_and_ignore_unsubscribe(self):
        events = [
            {"Type": "LinkClicked", "ReceivedAt": "2026-09-23T10:00:00Z",
             "Details": {"Link": "https://example.com/unsubscribe"}},
            {"Type": "LinkClicked", "ReceivedAt": "2026-09-23T10:01:00Z",
             "Details": {"Link": MANIFEST["auction_url"]}},
            {"Type": "LinkClicked", "ReceivedAt": "2026-09-23T10:02:00Z",
             "Details": {"Link": MANIFEST["links"][1]["url"]}},
        ]
        links = [{"cta_key": link["key"], "destination_url": link["url"]} for link in MANIFEST["links"]]
        self.assertEqual(campaign.observed_clicks(events, links), {
            "test-lot": "2026-09-23T10:01:00Z", "sourcing": "2026-09-23T10:02:00Z"})


TEST_URL = os.environ.get("BULK_TRADES_TEST_DATABASE_URL")


@unittest.skipUnless(TEST_URL, "needs a disposable database: scripts/rebattery/crm-test-db.sh up")
class SuppressionSyncTest(unittest.TestCase):
    def setUp(self):
        self.prefix = "suppression_" + uuid4().hex
        self.ids = [self.prefix + "_" + str(i) for i in range(8)]
        self.emails = [f"{person_id}@example.test" for person_id in self.ids]
        self.campaign_id = self.prefix + "_campaign"
        self.manifest = {**MANIFEST, "id": self.campaign_id, "person_ids": self.ids[:6]}
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.env = patch.dict(os.environ, {"DENCH_CAMPAIGN_DSN": TEST_URL})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.addCleanup(self.cleanup_rows)
        with psycopg2.connect(TEST_URL) as db, db.cursor() as cur:
            for person_id, email in zip(self.ids, self.emails):
                cur.execute("insert into crm_people (id, full_name, email) values (%s,'Synthetic buyer',%s)",
                            (person_id, email))
        self.dump = []

    def cleanup_rows(self):
        with psycopg2.connect(TEST_URL) as db, db.cursor() as cur:
            cur.execute("""delete from crm_campaign_send_links where send_id in
                           (select id from crm_campaign_sends where campaign_id=%s)""", (self.campaign_id,))
            cur.execute("delete from crm_campaign_sends where campaign_id=%s", (self.campaign_id,))
            cur.execute("delete from campaigns where id=%s", (self.campaign_id,))
            cur.execute("delete from crm_people where id=any(%s::text[])", (self.ids,))

    def provider(self, path, method="GET", payload=None):
        self.assertEqual(method, "GET")  # No suppression creation or email submission.
        if path == "/message-streams/broadcasts":
            return {"MessageStreamType": "Broadcasts", "ArchivedAt": None,
                    "SubscriptionManagementConfiguration": {"UnsubscribeHandlingType": "Postmark"}}
        if path == "/message-streams/broadcasts/suppressions/dump":
            return {"Suppressions": self.dump}
        self.fail(f"Unexpected provider request: {path}")

    def suppression(self, index, reason="ManualSuppression", origin="Recipient"):
        return {"EmailAddress": self.emails[index].upper(), "SuppressionReason": reason,
                "Origin": origin, "CreatedAt": "2026-10-01T23:30:00-05:00"}

    def query(self, sql, params=()):
        with psycopg2.connect(TEST_URL) as db, db.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql, params)
            return [dict(row) for row in cur.fetchall()]

    def snapshot(self):
        return self.query("""select p.id, p.email_opted_out, p.updated_at as person_updated,
                                   s.list, s.status, s.since, s.how, s.updated_at as subscription_updated
                            from crm_people p left join crm_subscriptions s on s.person_id=p.id
                            where p.id=any(%s::text[]) order by p.id,s.list""", (self.ids,))

    def run_cli(self, *args):
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch("sys.argv", ["rebattery-campaign.py", *args]), \
             patch.object(campaign, "postmark", side_effect=self.provider), \
             redirect_stdout(stdout), redirect_stderr(stderr):
            code = campaign.main()
        return code, json.loads(stdout.getvalue()) if stdout.getvalue() else None, stderr.getvalue()

    def freeze_cli(self):
        path = Path(self.directory.name) / "manifest.json"
        path.write_text(json.dumps(self.manifest))
        return self.run_cli("freeze", "--manifest", str(path), "--apply")

    def test_reason_mapping_dates_idempotence_and_removed_suppression_never_resubscribes(self):
        # Recipient unsubscribe is ManualSuppression/Recipient in the dump API.
        self.dump = [self.suppression(0), self.suppression(1, "SpamComplaint"),
                     self.suppression(2, "HardBounce"), self.suppression(3, origin="Customer"),
                     self.suppression(6, "FutureReason", "Admin")]
        with psycopg2.connect(TEST_URL) as db, db.cursor() as cur:
            cur.execute("""insert into crm_subscriptions (person_id,list,status,since,how) values
                           (%s,'Newsletter','Subscribed','2026-09-01','Existing consent'),
                           (%s,'Supply update','Subscribed','2026-09-01','Existing consent')""",
                        (self.ids[0], self.ids[1]))
            cur.execute("update crm_people set email_opted_out=true where id=%s", (self.ids[3],))
            cur.execute("update crm_people set email=%s where id=%s", ("  " + self.emails[2].upper() + "  ", self.ids[7]))
        # Also reconcile people outside the selected campaign; don't create unmatched contacts.
        self.dump.append({**self.suppression(0), "EmailAddress": "unmatched@example.test"})
        code, output, error = self.run_cli("sync-suppressions", "--stream", "broadcasts", "--apply")
        self.assertEqual((code, error), (0, ""))
        subscriptions = {row["person_id"]: row for row in self.query(
            "select * from crm_subscriptions where person_id=any(%s::text[]) and list='Supply update'", (self.ids,))}
        expected = {0: ("ManualSuppression", False), 1: ("SpamComplaint", True),
                    2: ("HardBounce", True), 3: ("ManualSuppression", True), 6: ("FutureReason", False),
                    7: ("HardBounce", True)}
        global_flags = {row["id"]: row["email_opted_out"] for row in self.query(
            "select id,email_opted_out from crm_people where id=any(%s::text[])", (self.ids,))}
        self.assertEqual(set(subscriptions), {self.ids[i] for i in expected})
        for index, (reason, opted_out) in expected.items():
            row = subscriptions[self.ids[index]]
            self.assertEqual((row["status"], row["since"]), ("Opted out", date(2026, 10, 1)))
            self.assertIn(f"reason={reason}", row["how"])
            self.assertIn("stream=broadcasts", row["how"])
            self.assertEqual(bool(global_flags[self.ids[index]]), opted_out)
        self.assertIn("origin=Recipient", subscriptions[self.ids[0]]["how"])
        self.assertIn("origin=Customer", subscriptions[self.ids[3]]["how"])
        newsletter = self.query("select status,since,how from crm_subscriptions where person_id=%s and list='Newsletter'",
                                (self.ids[0],))[0]
        self.assertEqual(newsletter, {"status": "Subscribed", "since": date(2026, 9, 1), "how": "Existing consent"})
        unmatched = next(row for row in output["suppressions"] if row["email"] == "unmatched@example.test")
        self.assertEqual(unmatched["person_ids"], [])
        before = self.snapshot()
        self.run_cli("sync-suppressions", "--stream", "broadcasts", "--apply")
        self.assertEqual(self.snapshot(), before)
        self.dump = []
        self.run_cli("sync-suppressions", "--stream", "broadcasts", "--apply")
        self.assertEqual(self.snapshot(), before)

    def test_dry_run_reports_changes_without_writing(self):
        self.dump = [self.suppression(0), self.suppression(1, "SpamComplaint")]
        before = self.snapshot()
        code, output, error = self.run_cli("sync-suppressions", "--stream", "broadcasts")
        self.assertEqual((code, error), (0, ""))
        self.assertTrue(output["dry_run"])
        self.assertEqual(next(row for row in output["suppressions"] if row["email"] == self.emails[1])["global_opt_out"], True)
        self.assertEqual(self.snapshot(), before)

    def test_suppression_only_sync_does_not_change_campaign_receipts(self):
        self.dump = [self.suppression(0, "HardBounce")]
        with psycopg2.connect(TEST_URL) as db, db.cursor() as cur:
            cur.execute("insert into campaigns (id,campaign_name) values (%s,'Synthetic receipt')", (self.campaign_id,))
            cur.execute("""insert into crm_campaign_sends
                           (id,campaign_id,person_id,listing_id,auction_url,recipient_email,
                            provider_message_id,state,delivered_at,last_synced_at)
                           values (%s,%s,%s,'listing-1',%s,%s,%s,'accepted',
                                   '2026-10-01T12:00:00Z','2026-10-01T13:00:00Z')""",
                        (self.prefix, self.campaign_id, self.ids[0], MANIFEST["auction_url"], self.emails[0], self.prefix))
            cur.execute("""insert into crm_campaign_send_links
                           (id,send_id,cta_key,destination_url,first_clicked_at)
                           values (%s,%s,'lot',%s,'2026-10-01T14:00:00Z')""",
                        (self.prefix, self.prefix, MANIFEST["auction_url"]))
        receipts_sql = """select s.*,l.first_clicked_at from crm_campaign_sends s
                          join crm_campaign_send_links l on l.send_id=s.id where s.campaign_id=%s"""
        before = self.query(receipts_sql, (self.campaign_id,))
        code, _, error = self.run_cli("sync-suppressions", "--stream", "broadcasts", "--apply")
        self.assertEqual((code, error), (0, ""))
        self.assertEqual(self.query(receipts_sql, (self.campaign_id,)), before)
        state = self.query("""select p.email_opted_out,s.status from crm_people p
                              join crm_subscriptions s on s.person_id=p.id
                              where p.id=%s and s.list='Supply update'""", (self.ids[0],))
        self.assertEqual(state, [{"email_opted_out": True, "status": "Opted out"}])

    def test_next_freeze_filters_both_cohort_sources_before_sends_and_digest(self):
        for use_sql in (False, True):
            with self.subTest(use_sql=use_sql):
                with psycopg2.connect(TEST_URL) as db, db.cursor() as cur:
                    cur.execute("""insert into crm_subscriptions (person_id,list,status,since,how)
                                   values (%s,'Supply update','Opted out','2026-09-30','Reply decline')
                                   on conflict do nothing""", (self.ids[4],))
                self.dump = [self.suppression(0)]
                self.run_cli("sync", "--campaign-id", self.campaign_id, "--stream", "broadcasts", "--apply")
                # Arrived after sync: provider-only suppression must still be omitted.
                self.dump.append(self.suppression(1, "HardBounce"))
                if use_sql:
                    sql_path = Path(self.directory.name) / "cohort.sql"
                    sql_path.write_text(f"select id as person_id from crm_people where id in ({','.join(repr(i) for i in self.ids[:6])})")
                    self.manifest = {key: value for key, value in self.manifest.items() if key != "person_ids"}
                    self.manifest["cohort_sql"] = str(sql_path)
                before = self.snapshot()
                code, output, error = self.freeze_cli()
                self.assertEqual((code, error), (0, ""))
                expected_ids = {self.ids[2], self.ids[3], self.ids[5]}
                self.assertEqual({row["person_id"] for row in output["cohort"]}, expected_ids)
                self.assertEqual({row["person_id"] for row in output["exclusions"]}, {self.ids[0], self.ids[1], self.ids[4]})
                with psycopg2.connect(TEST_URL) as db:
                    frozen = campaign.frozen_rows(db, self.campaign_id)
                self.assertEqual({row["person_id"] for row in frozen}, expected_ids)
                self.assertEqual(output["sha256"], campaign.digest(self.manifest, frozen))
                self.assertNotEqual(output["sha256"], campaign.digest(self.manifest, [
                    *frozen, {"person_id": self.ids[1], "company_id": None, "email": self.emails[1]}]))
                links = self.query("""select s.person_id,l.cta_key,l.destination_url from crm_campaign_send_links l
                                      join crm_campaign_sends s on s.id=l.send_id where s.campaign_id=%s""", (self.campaign_id,))
                self.assertEqual({(r["person_id"], r["cta_key"], r["destination_url"]) for r in links},
                                 {(i, l["key"], l["url"]) for i in expected_ids for l in self.manifest["links"]})
                self.assertEqual(self.snapshot(), before)  # Freeze doesn't reconcile or change consent.
                # Preserve launch's guard for a suppression added after freeze.
                self.dump.append(self.suppression(2, "SpamComplaint"))
                with patch.object(campaign, "postmark", side_effect=self.provider):
                    with self.assertRaisesRegex(ValueError, "suppressed"):
                        campaign.provider_preflight(self.manifest, frozen)
                self.cleanup_rows()
                with psycopg2.connect(TEST_URL) as db, db.cursor() as cur:
                    for person_id, email in zip(self.ids, self.emails):
                        cur.execute("insert into crm_people (id,full_name,email) values (%s,'Synthetic buyer',%s)", (person_id,email))

    def test_incomplete_dump_or_provider_failure_stops_freeze_before_writes(self):
        path = Path(self.directory.name) / "manifest.json"
        path.write_text(json.dumps(self.manifest))
        for response in ({}, {"Suppressions": None}, {"Suppressions": [{}]},
                         {"Suppressions": [self.suppression(0), {**self.suppression(1), "CreatedAt": "bad"}]},
                         urllib.error.URLError("Synthetic outage")):
            with self.subTest(response=response):
                def provider(request, **_):
                    if request.endswith("/suppressions/dump"):
                        if isinstance(response, Exception):
                            raise response
                        return response
                    return self.provider(request)
                with patch.object(campaign, "postmark", side_effect=provider), \
                     patch("sys.argv", ["rebattery-campaign.py", "freeze", "--manifest", str(path), "--apply"]), \
                     redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                    self.assertEqual(campaign.main(), 1)
                self.assertEqual(self.query("select id from campaigns where id=%s", (self.campaign_id,)), [])
                self.assertEqual(self.query("select id from crm_campaign_sends where campaign_id=%s", (self.campaign_id,)), [])

    def test_fully_suppressed_cohort_is_not_frozen(self):
        self.dump = [self.suppression(i) for i in range(6)]
        code, _, error = self.freeze_cli()
        self.assertEqual(code, 1)
        self.assertIn("No eligible recipients", error)
        self.assertEqual(self.query("select id from campaigns where id=%s", (self.campaign_id,)), [])


if __name__ == "__main__":
    unittest.main()
