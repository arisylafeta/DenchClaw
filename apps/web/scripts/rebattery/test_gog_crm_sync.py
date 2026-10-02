import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch

MODULE_PATH = Path(__file__).with_name("gog_crm_sync.py")
SPEC = importlib.util.spec_from_file_location("gog_crm_sync", MODULE_PATH)
SYNC = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(SYNC)


class GogCrmSyncDraftTests(unittest.TestCase):
    def test_search_query_excludes_drafts_and_scopes_incremental_date(self):
        self.assertEqual(
            SYNC.build_search_query("from:buyer@example.com OR to:buyer@example.com", "2026/08/01"),
            "(from:buyer@example.com OR to:buyer@example.com) -label:DRAFT after:2026/08/01",
        )

    @patch.object(SYNC, "gog")
    def test_crm_label_search_excludes_drafts(self, gog):
        gog.return_value = []
        SYNC.search_label_crm("ari@rebattery.io")
        self.assertEqual(gog.call_args.args[4], "(label:CRM) -label:DRAFT")

    @patch.object(SYNC, "gog")
    def test_draft_search_returns_unique_authoritative_message_ids(self, gog):
        gog.return_value = {
            "messages": [{"id": "draft-1"}, {"id": "draft-1"}, {"id": "draft-2"}, {}]
        }
        self.assertEqual(
            SYNC.search_draft_message_ids("alex@rebattery.io"),
            {"draft-1", "draft-2"},
        )
        self.assertEqual(gog.call_args.args[4], "label:DRAFT")

    def test_full_message_draft_detection_is_case_insensitive(self):
        self.assertTrue(SYNC.is_draft_message({"labelIds": ["SENT", "DRAFT"]}))
        self.assertTrue(SYNC.is_draft_message({"labelIds": ["draft"]}))
        self.assertFalse(SYNC.is_draft_message({"labelIds": ["SENT"]}))
        self.assertFalse(SYNC.is_draft_message({}))


if __name__ == "__main__":
    unittest.main()


class GogCrmSyncPeopleTests(unittest.TestCase):
    """Who gets created: people at companies already in the CRM, or anyone on a thread labelled CRM."""

    class Cursor:
        def __init__(self):
            self.sql = []

        def execute(self, sql, params=None):
            self.sql.append((" ".join(sql.split()), params))

        def fetchone(self):
            return None

    def setUp(self):
        self.cur, self.people, self.stats = self.Cursor(), {}, {"auto_created": 0}

    def ensure(self, email, labelled=False):
        return SYNC.ensure_person(self.cur, "Pat", email, self.people, {"alex@rebattery.io"}, {}, self.stats,
                                  {"r3robotics.ai": "co_r3"}, labelled=labelled)

    def test_freemail_domains_are_common_providers(self):
        for domain in ("gmail.com", "yahoo.co.uk", "wp.pl", "outlook.de", "icloud.com"):
            self.assertTrue(SYNC.is_common_email_provider(domain), domain)
        self.assertFalse(SYNC.is_common_email_provider("r3robotics.ai"))

    def test_a_new_person_at_a_known_company_is_added_to_it(self):
        person_id, created = self.ensure("fec@r3robotics.ai")
        self.assertTrue(created)
        insert = next(params for sql, params in self.cur.sql if sql.startswith("INSERT INTO crm_people"))
        self.assertEqual(insert[5], "co_r3")
        self.assertFalse(any(sql.startswith("INSERT INTO crm_companies") for sql, _ in self.cur.sql))

    def test_strangers_and_cc_are_not_created_unless_the_thread_is_labelled(self):
        self.assertEqual(self.ensure("someone@unknown-co.example"), (None, False))
        self.assertEqual(self.ensure("friend@gmail.com"), (None, False))
        self.assertEqual(self.cur.sql, [])
        person_id, created = self.ensure("someone@unknown-co.example", labelled=True)
        self.assertTrue(created)
        self.assertTrue(any(sql.startswith("INSERT INTO crm_companies") for sql, _ in self.cur.sql))

