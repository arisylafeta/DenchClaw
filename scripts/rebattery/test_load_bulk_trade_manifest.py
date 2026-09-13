import importlib.util
import unittest
from pathlib import Path

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
                "summary": "Observed supply", "observed_outcome": "available",
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

    def test_rejects_transaction_state_as_a_lot_outcome(self):
        manifest = self.valid_manifest()
        manifest["lots"][0]["observed_outcome"] = "offer_accepted"
        manifest["lots"][0]["source_manifest"] = {"marketplace_status": "accepted"}
        with self.assertRaisesRegex(ValueError, "marketplace transaction state"):
            MODULE.validate_manifest(manifest)


if __name__ == "__main__":
    unittest.main()
