"""Focused tests for the replay rules, strict as-of filter and row checks.

No company data.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import caseworker
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
  - part_number: "PN-3"
    format: packs
    chemistry: NMC
    status: asked
price:
  - eur_per_kwh: 25
    basis: paid
    seen: "2026-01-10"
  - eur_per_kwh: 30
    basis: paid
rules_out:
  chemistries: [LFP]
---

## How to win them
2026-01-05: buys NMC packs.
An undated lesson that must not survive.
2026-03-01: dated exactly on the offer, so it must not survive.
2026-06-10: a later event that must not survive.

## Bought from us
- 2026-01-10: eighty kWh pack, EUR 25/kWh.
- 2026-03-01: on the offer date, dropped.
- 2026-06-10: forty kWh pack, dropped.
- 2025-12-01: an earlier pack, kept.

## Open threads and promises
- 2026-01-01: chase the quote.

## Sources
- 2026-01-01: gmail_msg_test.
"""


class DossierFilterTest(unittest.TestCase):
    def load(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "buyer.md"
            path.write_text(DOSSIER, encoding="utf-8")
            return dossier.load_dossier(path, "2026-03-01")

    def test_frontmatter_keeps_only_dated_rows_strictly_before(self) -> None:
        view = self.load()
        products = view["frontmatter"]["products"]
        self.assertEqual([p["part_number"] for p in products], ["PN-1"])
        self.assertEqual(len(view["frontmatter"]["price"]), 1)
        self.assertEqual(view["frontmatter"]["price"][0]["eur_per_kwh"], 25)

    def test_undated_body_line_is_dropped(self) -> None:
        body = self.load()["body"]
        self.assertNotIn("undated lesson", body)

    def test_line_dated_on_as_of_is_dropped(self) -> None:
        body = self.load()["body"]
        self.assertNotIn("dated exactly on the offer", body)
        self.assertNotIn("on the offer date", body)

    def test_earlier_dated_line_is_kept(self) -> None:
        body = self.load()["body"]
        self.assertIn("2026-01-05: buys NMC packs.", body)
        self.assertIn("- 2026-01-10: eighty kWh pack", body)
        self.assertIn("2025-12-01: an earlier pack", body)

    def test_later_and_undated_sections_are_dropped(self) -> None:
        body = self.load()["body"]
        self.assertNotIn("2026-06-10", body)
        self.assertNotIn("Open threads", body)
        self.assertNotIn("Sources", body)

    def test_undated_line_parser_needs_iso_start(self) -> None:
        self.assertEqual(dossier.line_date("- 2026-01-10: x"), dossier.parse_date("2026-01-10"))
        self.assertIsNone(dossier.line_date("10 Jan 2026: x"))
        self.assertIsNone(dossier.line_date("None found. 2026-01-10: x"))


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

    def test_strict_arm_ignores_body_keywords(self) -> None:
        # Frontmatter has no matching product; only a dated body line names the part.
        buyer = self.buyer(
            profile={},
            dossier={
                "frontmatter": {"products": []},
                "body": "## Asked for\n- 2026-01-05: wanted PN-9 modules.\n",
            },
        )
        listing = self.listing(part_number="PN-9", format="modules")
        self.assertEqual(rules.product_tier(listing, buyer, "2026-03-01", body_fallback=False), 0)
        self.assertEqual(rules.product_tier(listing, buyer, "2026-03-01", body_fallback=True), 4)

    def test_undated_past_ask_is_ignored(self) -> None:
        self.assertEqual(
            rules._filtered_past_asks({"past_asks": [{"wants": "PN-9"}]}, "2026-03-01"),
            [],
        )
        self.assertEqual(
            rules._filtered_past_asks({"past_asks": [{"date": "2026-01-01", "wants": "PN-9"}]}, "2026-03-01"),
            ["PN-9"],
        )
        self.assertEqual(
            rules._filtered_past_asks({"past_asks": [{"date": "2026-03-01", "wants": "PN-9"}]}, "2026-03-01"),
            [],
        )


class CaseworkerRowsTest(unittest.TestCase):
    def parsed(self, rows):
        return {"ranked": rows}

    def row(self, company_id, reason="fits the lot", killer="price"):
        return {"company_id": company_id, "reason": reason, "deal_killer": killer, "question": "q"}

    def test_rejects_unknown_placeholder_and_duplicates(self) -> None:
        parsed = self.parsed([
            self.row("a"),
            self.row("a"),
            self.row("zzz"),
            self.row("b", reason="PLACEHOLDER"),
            self.row("c", killer=""),
            self.row("d"),
        ])
        result = caseworker.clean_rows(parsed, {"a", "b", "c", "d"})
        self.assertEqual([row["company_id"] for row in result["ranked"]], ["a", "d"])
        self.assertEqual(result["unknown_ids"], ["a", "zzz"])
        self.assertEqual(len(result["rejected_rows"]), 2)

    def test_caps_at_eight(self) -> None:
        ids = {f"b{i}" for i in range(10)}
        parsed = self.parsed([self.row(f"b{i}") for i in range(10)])
        result = caseworker.clean_rows(parsed, ids)
        self.assertEqual(len(result["ranked"]), 8)
        self.assertEqual(result["over_cap"], 2)


if __name__ == "__main__":
    unittest.main()
