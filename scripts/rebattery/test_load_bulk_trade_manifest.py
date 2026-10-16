import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from contextlib import closing

MODULE_PATH = Path(__file__).with_name("load_bulk_trade_manifest.py")
SPEC = importlib.util.spec_from_file_location("bulk_trade_manifest", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class BulkTradeManifestTest(unittest.TestCase):
    def valid_manifest(self):
        return {
            "lots": [{
                "id": "lot-1", "title": "Lot", "lot_kind": "supply",
                "summary": "Observed supply", "stage": "Sourced",
                "people_sent_count": 0, "observed_outcome": "available",
                "confidence": "confirmed",
            }],
            "parties": [{
                "id": "party-1", "lot_id": "lot-1", "role": "buyer",
                "display_name": "Buyer",
            }],
            "evidence_links": [{
                "lot_id": "lot-1", "evidence_kind": "gmail_thread",
                "evidence_id": "thread-1",
            }],
        }

    def test_accepts_a_minimal_source_backed_manifest(self):
        manifest = self.valid_manifest()
        MODULE.validate_manifest(manifest)

    def test_rejects_unknown_lot_references(self):
        manifest = self.valid_manifest()
        manifest["evidence_links"][0]["lot_id"] = "missing"
        with self.assertRaisesRegex(ValueError, "unknown lot"):
            MODULE.validate_manifest(manifest)

    def test_accepts_payment_and_collection_stages(self):
        for stage in ("In Payment", "In Collection"):
            manifest = self.valid_manifest()
            manifest["lots"][0]["stage"] = stage
            MODULE.validate_manifest(manifest)

    def test_rejects_unknown_kanban_stages(self):
        manifest = self.valid_manifest()
        manifest["lots"][0]["stage"] = "Negotiating"
        with self.assertRaisesRegex(ValueError, "invalid stage"):
            MODULE.validate_manifest(manifest)

    def test_rejects_transaction_state_as_a_lot_outcome(self):
        manifest = self.valid_manifest()
        manifest["lots"][0]["observed_outcome"] = "offer_accepted"
        manifest["lots"][0]["source_manifest"] = {"marketplace_status": "accepted"}
        with self.assertRaisesRegex(ValueError, "marketplace transaction state"):
            MODULE.validate_manifest(manifest)

    def test_rejects_unknown_origin(self):
        manifest = self.valid_manifest()
        manifest["lots"][0]["origin"] = "unknown"
        with self.assertRaisesRegex(ValueError, "invalid origin"):
            MODULE.validate_manifest(manifest)

    @unittest.skipUnless(os.environ.get("BULK_TRADES_TEST_DATABASE_URL"), "requires disposable Postgres")
    def test_loads_and_updates_the_origin_of_demand_lots(self):
        import psycopg2

        url = os.environ["BULK_TRADES_TEST_DATABASE_URL"]
        if "_test" not in url:
            self.fail("Use a disposable test database")
        connect = psycopg2.connect
        manifest = self.valid_manifest()
        manifest["lots"][0]["id"] = "manifest_origin_regression"
        manifest["parties"] = []
        manifest["evidence_links"] = []
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "manifest.json"
            for kind, origin in (("demand", None), ("supply", None), ("supply", "demand")):
                lot = manifest["lots"][0]
                lot["lot_kind"] = kind
                if origin is not None:
                    lot["origin"] = origin
                path.write_text(json.dumps(manifest))
                # Redirect only the loader's connection; it must never reach the live hardcoded database.
                with patch("psycopg2.connect", side_effect=lambda **kwargs: connect(url)):
                    MODULE.load_manifest(path)
                with closing(connect(url)) as connection, connection.cursor() as cursor:
                    cursor.execute("select origin from crm_bulk_trade_lots where id = %s", (lot["id"],))
                    self.assertEqual(cursor.fetchone()[0], origin or kind)


if __name__ == "__main__":
    unittest.main()
