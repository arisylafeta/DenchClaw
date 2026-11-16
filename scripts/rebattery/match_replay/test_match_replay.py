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
import run_replay


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


class InterestLinesTest(unittest.TestCase):
    """Lines for the replay come only from dossier rows known before the case date."""

    def lines(self, as_of: str):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "buyer.md"
            path.write_text(DOSSIER, encoding="utf-8")
            return run_replay.lines_from_dossier(dossier.load_dossier(path, as_of))

    def test_a_row_becomes_a_dated_line_with_its_kind_and_expiry(self) -> None:
        (line,) = self.lines("2026-03-01")
        self.assertEqual((line["kind"], line["seen"], line["part_number"], line["kwh"]), ("ask", "2026-01-10", "PN-1", 80))
        self.assertEqual(line["expires_on"], "2026-04-10")

    def test_rows_seen_on_or_after_the_case_date_give_no_line(self) -> None:
        self.assertEqual(self.lines("2026-01-10"), [])
        self.assertEqual([line["part_number"] for line in self.lines("2026-07-01")], ["PN-1", "PN-2"])

    def test_a_bought_line_never_expires(self) -> None:
        bought = [line for line in self.lines("2026-07-01") if line["kind"] == "bought"]
        self.assertEqual(bought[0]["expires_on"], None)

    def test_no_dossier_no_lines(self) -> None:
        self.assertEqual(run_replay.lines_from_dossier(None), [])


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

    def test_kwh_bounds_follow_the_lots_format(self) -> None:
        profile = {"chemistries": ["NMC"], "formats": ["Packs", "Systems"], "kwh_min": 30, "kwh_max": None,
                   "kwh_by_format": {"packs": {"min": 30, "max": None}, "systems": {"min": 1500, "max": 1600}}}
        buyer = self.buyer(profile=profile)
        self.assertIsNone(rules.rule_out(self.listing(kwh=80), buyer))
        self.assertEqual(rules.rule_out(self.listing(kwh=10), buyer)[0], "kwh")
        # A 1577 kWh system is judged on the systems bounds, a 2000 kWh one is outside them.
        self.assertIsNone(rules.rule_out(self.listing(format="systems", kwh=1577), buyer))
        self.assertTrue(rules._within_profile_kwh(self.listing(format="systems", kwh=1577), buyer, 0.15))
        self.assertFalse(rules._within_profile_kwh(self.listing(format="systems", kwh=2000), buyer, 0.15))
        # No entry for the lot's format: the flat bounds apply.
        flat = self.buyer(profile={**profile, "kwh_by_format": {"systems": {"min": 1500, "max": 1600}}})
        self.assertEqual(rules.rule_out(self.listing(kwh=10), flat)[0], "kwh")

    def dossier_buyer(self, buyer_id, products):
        products = [{"format": "packs", "chemistry": "NMC", **p} for p in products]
        return self.buyer(id=buyer_id, name=buyer_id, dossier={"frontmatter": {"products": products}, "body": ""})

    def test_only_a_stated_range_rules_out_a_dossier_buyer(self) -> None:
        modual = self.dossier_buyer("modual", [{"kwh_min": 30, "status": "asked"}])
        self.assertEqual(rules.rule_out(self.listing(kwh=20), modual)[0], "kwh")
        self.assertIsNone(rules.rule_out(self.listing(kwh=60), modual))
        spagnesi = self.dossier_buyer("spagnesi", [{"kwh_min": 60, "kwh_max": 82, "status": "asked"}])
        self.assertEqual(rules.rule_out(self.listing(kwh=40), spagnesi)[0], "kwh")
        self.assertEqual(rules.rule_out(self.listing(kwh=100), spagnesi)[0], "kwh")
        self.assertIsNone(rules.rule_out(self.listing(kwh=75), spagnesi))
        zibi = self.dossier_buyer("zibi", [{"kwh": [75], "status": "bought"}])
        self.assertIsNone(rules.rule_out(self.listing(kwh=50), zibi))

    def test_size_closeness_ranks_a_dossier_buyer_and_leaves_legacy_alone(self) -> None:
        zibi = self.dossier_buyer("zibi", [{"kwh": [75], "status": "bought"}])
        fifty = self.dossier_buyer("fifty", [{"kwh": [50], "status": "bought"}])
        lot = self.listing(kwh=50)
        self.assertEqual(rules.size_gap(lot, fifty), 0.0)
        self.assertEqual(rules.size_gap(lot, zibi), 0.3333)
        ranked = rules.rank_a1(lot, [zibi, fifty], "2026-03-01")
        self.assertEqual([r["company_id"] for r in ranked], ["fifty", "zibi"])
        legacy = self.buyer(profile={"chemistries": ["NMC"], "formats": ["Packs"], "kwh_min": 60, "kwh_max": 82})
        self.assertEqual(rules.size_gap(self.listing(kwh=20), legacy), 0.0)
        self.assertEqual(rules.rule_out(self.listing(kwh=20), legacy)[0], "kwh")

    def test_chemistry_conflict_rules_out(self) -> None:
        buyer = self.buyer(profile={"chemistries": ["LFP"], "formats": ["Packs"]})
        self.assertIsNotNone(rules.rule_out(self.listing(), buyer))

    def test_missing_chemistry_does_not_rule_out(self) -> None:
        buyer = self.buyer(profile={"formats": ["Packs"]})
        self.assertIsNone(rules.rule_out(self.listing(), buyer))

    def test_dated_rules_out_entry_still_rules_out(self) -> None:
        # A dossier may date its rules as {value, seen, src}; the value still has to bite.
        buyer = self.buyer(dossier={"frontmatter": {
            "products": [{"format": "packs", "chemistry": "NMC", "status": "asked"}],
            "rules_out": {"chemistries": [{"value": "NMC", "seen": "2026-05-01", "src": "gmail_msg_test"}]},
        }})
        found = rules.rule_out(self.listing(), buyer)
        self.assertIsNotNone(found)
        self.assertEqual(found[0], "chemistry")

    def test_refused_part_number_and_low_voltage_rule_out(self) -> None:
        buyer = self.buyer(dossier={"frontmatter": {
            "min_pack_voltage": {"value": 450, "seen": "2026-08-20"},
            "rules_out": {"part_numbers": [{"value": "NCR2170M", "seen": "2026-10-24"}]},
        }})
        self.assertEqual(rules.rule_out(self.listing(format="cells", model="NCR-2170M"), buyer)[0], "part")
        self.assertEqual(rules.rule_out(self.listing(voltage="400 V"), buyer)[0], "voltage")
        self.assertIsNone(rules.rule_out(self.listing(voltage="800 V"), buyer))
        self.assertIsNone(rules.rule_out(self.listing(), buyer))

    def test_part_number_is_exact_and_never_a_vehicle_model(self) -> None:
        buyer = self.buyer(dossier={"frontmatter": {"rules_out": {"part_numbers": ["NCR2170M", "2170"]}}})
        self.assertIsNone(rules.rule_out(self.listing(format="cells", model="NCR2170M-4"), buyer))
        self.assertIsNone(rules.rule_out(self.listing(format="cells", model="Samsung 2170"), buyer))
        self.assertIsNone(rules.rule_out(self.listing(format="packs", model="NCR2170M"), buyer))
        self.assertEqual(rules.rule_out(self.listing(format="cells", part_number="ncr 2170-m"), buyer)[0], "part")

    def test_voltage_is_only_read_from_a_figure_with_v(self) -> None:
        self.assertEqual(rules.voltage_from_text("400 V", True), 400)
        self.assertEqual(rules.voltage_from_text("400", True), 400)
        self.assertEqual(rules.voltage_from_text("350-400V", True), 400)
        self.assertEqual(rules.voltage_from_text("100 / 48 V", False), 48)
        self.assertIsNone(rules.voltage_from_text("100 / 48", True))
        self.assertIsNone(rules.voltage_from_text("14.4 V", True))
        self.assertEqual(rules.voltage_from_text("14.4 V", False), 14.4)
        self.assertIsNone(rules.voltage_from_text("400 V and 800 V", True))
        buyer = self.buyer(dossier={"frontmatter": {"min_pack_voltage": {"value": 450}}})
        self.assertIsNone(rules.rule_out(self.listing(voltage="14.4 V"), buyer))

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
