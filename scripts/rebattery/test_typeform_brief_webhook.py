import base64
import hashlib
import hmac
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("hook", Path(__file__).with_name("typeform_brief_webhook.py"))
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)


def field(i, title):
    return {"id": i, "title": title, "type": "x"}


def payload(**extra):
    fields = [field("f1", "What's your name?"), field("f2", "What's your email?"), field("f3", "What will you use these batteries for?"),
              field("f4", "Which country will they be delivered to?"), field("f5", "What format suits you best?"),
              field("f6", "Any vehicle or pack makes you're particularly after?"), field("f7", "Realistic first order"),
              field("f8", "In what unit?"), field("f9", "What's the most you'd pay per kWh?"), field("f10", "Currency")]
    answers = [
        {"type": "text", "text": "Arinjay", "field": {"id": "f1"}},
        {"type": "email", "email": "A@Navmat.example", "field": {"id": "f2"}},
        {"type": "choice", "choice": {"label": "Recycling feedstock"}, "field": {"id": "f3"}},
        {"type": "choice", "choice": {"label": "India"}, "field": {"id": "f4"}},
        {"type": "choice", "choice": {"label": "Complete pack"}, "field": {"id": "f5"}},
        {"type": "choices", "choices": {"labels": ["Tesla", "Nissan"]}, "field": {"id": "f6"}},
        {"type": "number", "number": 20, "field": {"id": "f7"}},
        {"type": "choice", "choice": {"label": "kWh"}, "field": {"id": "f8"}},
        {"type": "number", "number": 28, "field": {"id": "f9"}},
        {"type": "choice", "choice": {"label": "EUR"}, "field": {"id": "f10"}},
    ]
    return {"event_type": "form_response", "form_response": {"form_id": "MbMTVSu8", "token": "tok1", "submitted_at": "2026-11-16T10:00:00Z",
            "definition": {"fields": fields}, "answers": answers, "hidden": {"company": "Navmat"}, **extra}}


class TypeformBrief(unittest.TestCase):
    def test_signature_must_match_the_raw_body(self):
        body = b'{"a": 1}'
        good = "sha256=" + base64.b64encode(hmac.new(b"s3", body, hashlib.sha256).digest()).decode()
        self.assertTrue(hook.signature_ok("s3", body, good))
        self.assertFalse(hook.signature_ok("s3", body + b" ", good))
        self.assertFalse(hook.signature_ok("s3", body, None))
        self.assertFalse(hook.signature_ok("", body, good))

    def test_answers_become_the_csv_shape_the_importer_reads(self):
        header, row = hook.payload_to_table(payload())
        cell = dict(zip(header, row))
        self.assertEqual(cell["What's your email?"], "A@Navmat.example")
        self.assertEqual(cell["Realistic first order"], "20")
        self.assertEqual(cell["Tesla"], "Tesla")  # one column per picked option
        self.assertEqual(cell["company"], "Navmat")

    def test_a_recycling_brief_is_mapped_not_dropped(self):
        header, row = hook.payload_to_table(payload())
        mapped = hook.survey.map_typeform_row(header, row)
        self.assertIsNotNone(mapped)
        self.assertEqual(mapped["email"], "a@navmat.example")
        self.assertEqual(mapped["source_id"], "typeform:tok1")
        self.assertEqual(mapped["quantity"], "20 kWh")

    def test_staff_briefs_are_not_filed(self):
        p = payload()
        p["form_response"]["answers"][1]["email"] = "alex@rebattery.io"
        header, row = hook.payload_to_table(p)
        self.assertIsNone(hook.survey.map_typeform_row(header, row))


if __name__ == "__main__":
    unittest.main()
