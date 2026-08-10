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
