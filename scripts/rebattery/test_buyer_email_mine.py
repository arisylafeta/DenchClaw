import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("mine", Path(__file__).with_name("buyer_email_mine.py"))
mine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mine)

MESSAGES = [
    {"message_id": "m1", "date": "2026-07-01", "from": "theirs", "sender": "dan@ser.example", "subject": "LFP",
     "text": "We need LFP packs by the full truck, around 20 packs a month. We pay 30% deposit and collect with our own ADR truck."},
    {"message_id": "m2", "date": "2026-08-10", "from": "ours", "sender": "alex@rebattery.io", "subject": "Re: LFP",
     "text": "We have 40 Tesla modules available at EUR 60/kWh."},
    {"message_id": "m3", "date": "2026-08-20", "from": "theirs", "sender": "dan@ser.example", "subject": "Loading",
     "text": "The load was rejected at loading because the test reports did not match the packs."},
]


class CleanBody(unittest.TestCase):
    def test_cuts_quoted_replies_and_signatures(self):
        text = "Thanks, 30 packs works for us.\n\nOn Mon, 3 Aug 2026 at 10:00, Alex <alex@rebattery.io> wrote:\n> Offer attached"
        self.assertEqual(mine.clean_body(text), "Thanks, 30 packs works for us.")
        self.assertEqual(mine.clean_body("Yes please send specs.\n--\nDan Mo\nSER Limited"), "Yes please send specs.")
        self.assertEqual(len(mine.clean_body("x" * 9000)), mine.MAX_MESSAGE_CHARS)


class Validate(unittest.TestCase):
    def test_keeps_quoted_values_in_the_lists_and_drops_the_rest(self):
        raw = {
            "role": "buyer", "summary": "Trader buying LFP by the truck.",
            "buy_boxes": [
                {"kind": "standing", "wants": "LFP packs by the full truck", "volume": 20, "volume_unit": "packs",
                 "spec": {"chemistries": ["LFP", "Graphene"], "formats": ["Packs"]}, "status": "open",
                 "evidence": [{"message_id": "m1", "quote": "We need LFP packs by the full truck"}]},
                {"kind": "request", "wants": "Tesla modules", "status": "open",  # our own offer, quote not theirs
                 "evidence": [{"message_id": "m2", "quote": "an invented line that is nowhere"}]},
            ],
            "profile": {
                "capabilities": ["Recycle", "Teleport"], "collection": "Own ADR truck", "payment_terms": "30% deposit",
                "accepts_standard_terms": "Maybe", "stage": "Customer", "main_contact_email": "dan@ser.example",
                "past_issues": [{"date": "2026-08-20", "what": "Load rejected: test reports did not match",
                                 "message_id": "m3", "quote": "The load was rejected at loading"}],
                "evidence": [{"field": "collection", "message_id": "m1", "quote": "collect with our own ADR truck"},
                             {"field": "payment_terms", "message_id": "m1", "quote": "We pay 30% deposit"},
                             {"field": "capabilities", "message_id": "m9", "quote": "no such message here"}],
            },
            "other_facts": [{"topic": "Truck size", "value": "Buys by the full truck", "message_id": "m1",
                             "quote": "by the full truck"}],
        }
        r = mine.validate(raw, MESSAGES)
        self.assertEqual(r["dropped"], 1)
        [box] = r["buy_boxes"]
        self.assertEqual((box["kind"], box["volume"], box["spec"], box["observed_on"]),
                         ("standing", 20, {"chemistries": ["LFP"], "formats": ["Packs"]}, "2026-07-01"))
        p = r["profile"]
        self.assertEqual(p["collection"], "Own ADR truck")
        self.assertEqual(p["payment_terms"], "30% deposit")
        self.assertNotIn("capabilities", p)  # its only evidence cites a message that does not exist
        self.assertNotIn("accepts_standard_terms", p)  # not an allowed value
        self.assertNotIn("stage", p)  # no quote for it
        self.assertEqual(p["main_contact_email"], "dan@ser.example")
        self.assertEqual(p["past_issues"][0]["date"], "2026-08-20")
        self.assertEqual(r["other_facts"][0]["topic"], "Truck size")

    def test_profile_values_date_the_text_fields(self):
        values = mine.profile_values({"collection": "Own ADR truck", "payment_terms": "30% deposit", "stage": "Customer",
                                      "past_issues": [{"date": "2026-08-20", "what": "Load rejected"}]})
        self.assertEqual(values["buyer_collection"], "Own ADR truck")
        self.assertEqual(values["buyer_stage"], "Customer")
        self.assertTrue(values["buyer_outreach_notes"].startswith("From email review "))
        self.assertIn("Payment: 30% deposit", values["buyer_outreach_notes"])
        self.assertEqual(values["buyer_past_issues"], "2026-08-20: Load rejected")


if __name__ == "__main__":
    unittest.main()
