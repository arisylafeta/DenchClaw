import importlib.util
import os
import unittest
import json
import tempfile
from pathlib import Path
from unittest.mock import patch
import urllib.error


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
    "html": "<a href='https://www.rebattery.io/marketplace/auctions/test-lot'>Auction</a> <a href='https://form.typeform.com/to/MbMTVSu8'>Sourcing</a> <a href='{{{ pm:unsubscribe }}}'>Unsubscribe</a>",
    "text": "Auction https://www.rebattery.io/marketplace/auctions/test-lot\nSourcing https://form.typeform.com/to/MbMTVSu8\nUnsubscribe {{{ pm:unsubscribe }}}",
    "links": [
        {"key": "test-lot", "url": "https://www.rebattery.io/marketplace/auctions/test-lot", "listing_id": "listing-1"},
        {"key": "sourcing", "url": "https://form.typeform.com/to/MbMTVSu8"},
    ],
    "stream": "broadcasts", "person_ids": ["p1"],
}
ROWS = [{"person_id": "p1", "company_id": "c1", "email": "buyer@example.com"}]


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
    def test_freeze_stores_distinct_recipient_cta_mapping(self):
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

        recipients = [ROWS[0], {"person_id": "p2", "company_id": "c2", "email": "two@example.com"}]
        with patch.object(campaign, "connection", return_value=Db()):
            campaign.freeze(MANIFEST, recipients, campaign.digest(MANIFEST, recipients))
        frozen_links = [params for sql, params in statements if "insert into crm_campaign_send_links" in sql]
        self.assertEqual(len(frozen_links), 4)
        self.assertEqual({params[2] for params in frozen_links}, {"test-lot", "sourcing"})
        self.assertEqual(len({params[0] for params in frozen_links}), 4)

    def test_manifest_digest_binds_recipient_and_body(self):
        approved = campaign.digest(MANIFEST, ROWS)
        self.assertNotEqual(approved, campaign.digest({**MANIFEST, "html": "changed"}, ROWS))
        self.assertNotEqual(approved, campaign.digest(MANIFEST, [{**ROWS[0], "email": "other@example.com"}]))
        self.assertNotEqual(approved, campaign.digest({**MANIFEST, "links": MANIFEST["links"][:1]}, ROWS))

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
            result = campaign.launch(MANIFEST, sha)
            self.assertEqual(state["send_state"], "unknown")
            self.assertEqual(result[0][1], "unknown: URLError")
            self.assertEqual(campaign.launch(MANIFEST, sha)[0][1], "skipped: already claimed or suppressed")
            self.assertEqual(send.call_count, 1)

    def test_provider_preflight_rejects_suppressed_address(self):
        responses = [{"MessageStreamType": "Broadcasts", "ArchivedAt": None,
                      "SubscriptionManagementConfiguration": {"UnsubscribeHandlingType": "Postmark"}},
                     {"Suppressions": [{"EmailAddress": "buyer@example.com"}]}]
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
            result = campaign.launch(MANIFEST, campaign.digest(MANIFEST, ROWS))
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


if __name__ == "__main__":
    unittest.main()
