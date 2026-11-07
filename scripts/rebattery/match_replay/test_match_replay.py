"""Focused tests for the replay rules and as-of filter. No company data."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import dossier
import rules


DOSSIER = """---
company_id: "test-1"
company: "Test Buyer"
products:
  - part_number: "PN-1"
    format: packs
    chemistry: NMC
    kwh: [80]
    status: asked
    seen: "2026-01-10"
  - part_number: "PN-2"
    format: packs
    chemistry: NMC
    kwh: [40]
    status: bought
    seen: "2026-06-10"
price:
  - eur_per_kwh: 25
    basis: paid
    seen: "2026-01-10"
rules_out:
  chemistries: [LFP]
---

## How to win them
Buys NMC packs.

## Bought from us
- 10 Jun 2026: forty kWh pack, EUR 25/kWh.
- 10 Jan 2026: eighty kWh pack, EUR 25/kWh.

## Asked for (newest first)
- 10 Jun 2026: another pack.
- 10 Jan 2026: an eighty kWh pack.

## Open threads and promises
- chase the quote.

## Sources
- gmail_msg_test.
"""


class DossierFilterTest(unittest.TestCase):
    def test_as_of_drops_later_products_and_body(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "buyer.md"
            path.write_text(DOSSIER, encoding="utf-8")
            view = dossier.load_dossier(path, "2026-03-01")
        products = view["frontmatter"]["products"]
        self.assertEqual([p["part_number"] for p in products], ["PN-1"])
        self.assertEqual(view["frontmatter"]["price"][0]["eur_per_kwh"], 25)
        self.assertNotIn("10 Jun 2026", view["body"])
        self.assertNotIn("Open threads", view["body"])
        self.assertNotIn("Sources", view["body"])
        self.assertIn("Buys NMC packs", view["body"])


class RulesTest(unittest.TestCase):
    def listing(self, **overrides):
        base = {
            "title": "80 kWh NMC packs", "make": "Test", "model": "Model T",
            "format": "packs", "chemistry": "NMC", "kwh": 80, "units": 10,
            "whole_batch": False,
        }
        base.update(overrides)
        return base

    def buyer(self, **overrides):
        base = {
            "id": "b1", "name": "Buyer One", "stage": "Qualified", "tier": "B",
            "basis": "stated", "last_touch": "2026-01-01T00:00:00+00:00",
            "profile": {"chemistries": ["NMC"], "formats": ["Packs"]},
            "dossier": None,
        }
        base.update(overrides)
        return base

    def test_chemistry_conflict_rules_out(self) -> None:
        buyer = self.buyer(profile={"chemistries": ["LFP"], "formats": ["Packs"]})
        self.assertIsNotNone(rules.rule_out(self.listing(), buyer))

    def test_missing_chemistry_does_not_rule_out(self) -> None:
        buyer = self.buyer(profile={"formats": ["Packs"]})
        self.assertIsNone(rules.rule_out(self.listing(), buyer))

    def test_whole_batch_conflict(self) -> None:
        buyer = self.buyer(dossier={"frontmatter": {"quantity": {"whole_batch_ok": False}}, "body": ""})
        self.assertIsNotNone(rules.rule_out(self.listing(whole_batch=True), buyer))

    def test_part_number_outranks_chemistry_only(self) -> None:
        part_buyer = self.buyer(dossier={"frontmatter": {"products": [{"part_number": "PN-1", "format": "packs"}]}, "body": ""})
        chem_buyer = self.buyer(id="b2", name="Buyer Two")
        listing = self.listing(part_number="PN-1")
        self.assertEqual(rules.product_tier(listing, part_buyer, "2026-03-01"), 4)
        self.assertEqual(rules.product_tier(listing, chem_buyer, "2026-03-01"), 1)
        ranked = rules.rank_a1(listing, [chem_buyer, part_buyer], "2026-03-01")
        self.assertEqual(ranked[0]["company_id"], "b1")


if __name__ == "__main__":
    unittest.main()
