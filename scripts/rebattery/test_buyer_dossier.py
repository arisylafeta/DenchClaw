"""Tests for buyer_dossier: parsing, validation and the dossier to buyer_profile mapping.

Synthetic fixtures only. No real company data belongs in git.
"""
import json
import textwrap
import unittest
from pathlib import Path

import buyer_dossier as bd

VALID = """\
---
company_id: "company-test-1"
company: "Example Modules Ltd"
buyer_type: module_builder
intent: [reuse, cells]
countries: [DE]
products:
  - platform: MEB
    make: Volkswagen
    model: ID.4
    format: packs
    chemistry: NMC
    kwh: [82]
    status: bought
    seen: "2026-06-15"
    src: "gmail_msg_test1"
  - make: CALB
    format: cells
    chemistry: LFP
    cell_format: prismatic
    kwh: [0.23]
    status: asked
    seen: "2026-07-01"
    src: "whatsapp:message:test2"
  - make: Tesla
    format: packs
    chemistry: NMC
    status: declined
    seen: "2026-01-10"
    src: "gmail_msg_test3"
rules_out:
  chemistries: [LTO]
  formats: []
  damaged: true
  other: ["no unknown provenance"]
substitution:
  kwh_tolerance: 0.15
  same_platform_other_make: true
price:
  - eur_per_kwh: 30
    basis: paid
    seen: "2026-06-15"
    src: "gmail_msg_test1"
quantity:
  min_units: 2
  typical_units: 10
  cadence: standing
  whole_batch_ok: true
logistics:
  incoterms: [DAP]
  collects: needs_delivery
capability: [disassembly]
decision_speed: normal
last_verified: "2026-07-01"
conflicts: []
alerts:
  - label: "MEB alerts"
    filters: {make: Volkswagen, format: pack}
    status: active
    seen: "2026-07-01"
    src: "saved_search:test"
---

## How to win them
Body text.
"""


def parse_valid(**overrides):
    """Frontmatter from VALID with top-level overrides, without re-parsing YAML each time."""
    frontmatter, _ = bd.parse(VALID)
    frontmatter = json.loads(json.dumps(frontmatter))
    frontmatter.update(overrides)
    return frontmatter


class ParseTests(unittest.TestCase):
    def test_parses_frontmatter_and_body(self):
        frontmatter, body = bd.parse(VALID)
        self.assertEqual(frontmatter["company_id"], "company-test-1")
        self.assertEqual(frontmatter["products"][0]["kwh"], [82])
        self.assertTrue(body.startswith("## How to win them"))

    def test_no_frontmatter_returns_whole_text(self):
        frontmatter, body = bd.parse("Just a note.\n")
        self.assertEqual(frontmatter, {})
        self.assertEqual(body, "Just a note.\n")

    def test_unquoted_dates_become_iso_strings(self):
        markdown = "---\ncompany_id: x\nlast_verified: 2026-05-04\n---\nbody\n"
        frontmatter, _ = bd.parse(markdown)
        self.assertEqual(frontmatter["last_verified"], "2026-05-04")

    def test_broken_yaml_is_not_fatal(self):
        frontmatter, body = bd.parse("---\ncompany_id: [unclosed\n---\nbody\n")
        self.assertEqual(frontmatter, {})
        self.assertIn("unclosed", body)


class ValidateTests(unittest.TestCase):
    def test_valid_dossier_has_no_errors(self):
        self.assertEqual(bd.validate(parse_valid()), [])

    def test_invalid_enum_is_reported(self):
        errors = bd.validate(parse_valid(buyer_type="wholesaler"))
        self.assertTrue(any("buyer_type" in e and "wholesaler" in e for e in errors), errors)

    def test_invalid_product_status_and_format_are_reported(self):
        frontmatter = parse_valid()
        frontmatter["products"][0]["status"] = "maybe"
        frontmatter["products"][0]["format"] = "crates"
        errors = bd.validate(frontmatter)
        self.assertTrue(any("products[0].status" in e for e in errors), errors)
        self.assertTrue(any("products[0].format" in e for e in errors), errors)

    def test_bad_date_is_reported(self):
        frontmatter = parse_valid(last_verified="15/06/2026")
        frontmatter["products"][0]["seen"] = "2026-13-40"
        errors = bd.validate(frontmatter)
        self.assertTrue(any(e.startswith("last_verified:") for e in errors), errors)
        self.assertTrue(any("products[0].seen" in e for e in errors), errors)

    def test_unknown_top_level_key_is_rejected(self):
        errors = bd.validate(parse_valid(notes="free text"))
        self.assertTrue(any(e.startswith("notes: unknown top-level key") for e in errors), errors)

    def test_unknown_product_key_is_rejected(self):
        frontmatter = parse_valid()
        frontmatter["products"][0]["price_hint"] = "cheap"
        errors = bd.validate(frontmatter)
        self.assertTrue(any("products[0].price_hint" in e for e in errors), errors)

    def test_numbers_must_be_numeric(self):
        frontmatter = parse_valid()
        frontmatter["price"][0]["eur_per_kwh"] = "30"
        frontmatter["quantity"]["min_units"] = "two"
        errors = bd.validate(frontmatter)
        self.assertTrue(any("price[0].eur_per_kwh" in e for e in errors), errors)
        self.assertTrue(any("quantity.min_units" in e for e in errors), errors)

    def test_product_status_and_format_are_required(self):
        frontmatter = parse_valid()
        del frontmatter["products"][0]["status"]
        del frontmatter["products"][0]["format"]
        errors = bd.validate(frontmatter)
        self.assertTrue(any("products[0].status: required" in e for e in errors), errors)
        self.assertTrue(any("products[0].format: required" in e for e in errors), errors)

    def test_empty_values_mean_not_stated(self):
        frontmatter = parse_valid(decision_speed="")
        frontmatter["quantity"]["cadence"] = ""
        frontmatter["products"][1]["chemistry"] = ""
        self.assertEqual(bd.validate(frontmatter), [])

    def test_alert_needs_label_and_filters(self):
        frontmatter = parse_valid(alerts=[{"status": "active"}])
        errors = bd.validate(frontmatter)
        self.assertTrue(any("alerts[0].label" in e for e in errors), errors)
        self.assertTrue(any("alerts[0].filters" in e for e in errors), errors)

    def test_alert_unknown_key_rejected(self):
        frontmatter = parse_valid(alerts=[{"label": "x", "filters": {}, "frequency": "daily"}])
        self.assertTrue(any("alerts[0].frequency" in e for e in bd.validate(frontmatter)))

    def test_continuity_timing_origins_and_min_soh_are_accepted(self):
        frontmatter = parse_valid(needs_continuity=True, origins=["DE", "pl"], min_soh=70,
                                  timing={"max_lead_days": 30, "notes": "wants stock within a month"})
        self.assertEqual(bd.validate(frontmatter), [])

    def test_new_keys_reject_wrong_values(self):
        errors = bd.validate(parse_valid(needs_continuity="yes", origins=["DEU"], min_soh=120))
        self.assertTrue(any(e.startswith("needs_continuity:") for e in errors), errors)
        self.assertTrue(any(e.startswith("origins[0]:") for e in errors), errors)
        self.assertTrue(any("min_soh" in e and "outside 0-100" in e for e in errors), errors)
        errors = bd.validate(parse_valid(origins="DE", min_soh="80"))
        self.assertTrue(any(e.startswith("origins: must be a list") for e in errors), errors)
        self.assertTrue(any(e.startswith("min_soh: must be a number") for e in errors), errors)

    def test_timing_rejects_unknown_keys_and_bad_lead(self):
        errors = bd.validate(parse_valid(timing={"max_lead_days": "ten", "sla": 3}))
        self.assertTrue(any(e.startswith("timing.max_lead_days:") for e in errors), errors)
        self.assertTrue(any(e.startswith("timing.sla: unknown key") for e in errors), errors)
        self.assertTrue(any(e.startswith("timing: must be a mapping") for e in bd.validate(parse_valid(timing=3))))

    def test_dated_rule_and_evidence_entries_are_valid(self):
        frontmatter = parse_valid(
            rules_out={"chemistries": [{"value": "LTO", "seen": "2026-05-01", "src": "gmail_msg_test9"}],
                       "formats": [{"value": "systems", "seen": "2026-05-02"}],
                       "other": [{"value": "no damaged stock", "seen": "2026-05-03"}]},
            evidence_required=[{"value": "tested_soh", "seen": "2026-05-04", "src": "whatsapp:message:test9"},
                               "sds"],
        )
        self.assertEqual(bd.validate(frontmatter), [])

    def test_dated_entry_errors_are_reported(self):
        errors = bd.validate(parse_valid(
            rules_out={"chemistries": [{"value": "LTO", "seen": "01/05/2026", "note": "x"}, {"value": ""}]},
            evidence_required=[{"value": "tested_soh", "seen": "2026-13-40"}],
        ))
        self.assertTrue(any("rules_out.chemistries[0].note" in e for e in errors), errors)
        self.assertTrue(any("rules_out.chemistries[0].seen" in e for e in errors), errors)
        self.assertTrue(any("rules_out.chemistries[1].value" in e for e in errors), errors)
        self.assertTrue(any("evidence_required[0].seen" in e for e in errors), errors)


class MappingTests(unittest.TestCase):
    def setUp(self):
        frontmatter, _ = bd.parse(VALID)
        self.profile = bd.to_buyer_profile(frontmatter)

    def test_flat_keys_the_readers_use(self):
        self.assertEqual(self.profile["chemistries"], ["LFP", "NMC"])
        self.assertEqual(self.profile["formats"], ["Cells", "Packs"])
        self.assertEqual(self.profile["makes"], ["VW Group"])
        self.assertEqual(self.profile["cell_makers"], ["CALB"])
        self.assertEqual(self.profile["part_numbers"], [])
        self.assertEqual(self.profile["kwh_min"], 0.23)
        self.assertEqual(self.profile["kwh_max"], 82)

    def test_no_invented_origins_or_min_soh(self):
        self.assertNotIn("origins", self.profile)
        self.assertNotIn("min_soh", self.profile)

    def test_origins_and_min_soh_map_to_flat_keys(self):
        frontmatter = parse_valid(origins=["de", "PL"], min_soh=70)
        profile = bd.to_buyer_profile(frontmatter)
        self.assertEqual(profile["origins"], ["DE", "PL"])
        self.assertEqual(profile["min_soh"], 70)

    def test_dated_rules_out_entry_still_removes_chemistry(self):
        frontmatter = parse_valid()
        frontmatter["rules_out"]["chemistries"] = [{"value": "NMC", "seen": "2026-05-01"}]
        profile = bd.to_buyer_profile(frontmatter)
        self.assertEqual(profile["chemistries"], ["LFP"])

    def test_full_frontmatter_kept_under_dossier(self):
        self.assertEqual(self.profile["dossier"]["company"], "Example Modules Ltd")
        self.assertEqual(self.profile["dossier"]["alerts"][0]["label"], "MEB alerts")

    def test_declined_product_is_excluded(self):
        self.assertNotIn("Tesla", self.profile["makes"])
        self.assertNotIn("Tesla", self.profile["wants"])

    def test_rules_out_removes_chemistry(self):
        frontmatter = parse_valid()
        frontmatter["rules_out"]["chemistries"] = ["NMC"]
        profile = bd.to_buyer_profile(frontmatter)
        self.assertEqual(profile["chemistries"], ["LFP"])
        self.assertNotIn("NMC", profile["chemistries"])
        self.assertNotIn("NMC", profile["wants"])

    def test_rules_out_removes_format_case_insensitively(self):
        frontmatter = parse_valid()
        frontmatter["rules_out"]["formats"] = ["PACKS"]
        profile = bd.to_buyer_profile(frontmatter)
        self.assertEqual(profile["formats"], ["Cells"])

    def test_wants_lines_are_short_and_dated(self):
        lines = self.profile["wants"].split("\n")
        self.assertEqual(
            lines,
            ["MEB 82 kWh packs (bought 2026-06-15)", "CALB 0.23 kWh cells (asked 2026-07-01)"],
        )

    def test_output_is_json_serialisable(self):
        json.dumps(self.profile)

    def test_deterministic(self):
        frontmatter, _ = bd.parse(VALID)
        self.assertEqual(bd.to_buyer_profile(frontmatter), bd.to_buyer_profile(frontmatter))

    def test_compound_makes_and_cell_makes_are_split(self):
        frontmatter = parse_valid(products=[
            {"make": "MG, Stellantis, Tesla", "format": "packs", "status": "asked"},
            {"make": "Stellantis / FPT / Kokam", "format": "cells", "status": "asked"},
        ])
        profile = bd.to_buyer_profile(frontmatter)
        self.assertEqual(profile["makes"], ["Tesla", "Stellantis", "MG or SAIC"])
        self.assertEqual(profile["cell_makers"], ["Kokam"])

    def test_unmapped_maker_is_not_guessed(self):
        frontmatter = parse_valid(products=[
            {"make": "Proterra", "format": "packs", "chemistry": "NMC", "status": "bought"},
        ])
        profile = bd.to_buyer_profile(frontmatter)
        self.assertEqual(profile["makes"], [])
        self.assertEqual(profile["cell_makers"], [])

    def test_generic_product_uses_chemistry_as_its_label(self):
        frontmatter = parse_valid(products=[
            {"format": "cells", "chemistry": "LFP", "status": "asked", "seen": "2026-03-22"},
        ])
        profile = bd.to_buyer_profile(frontmatter)
        self.assertEqual(profile["wants"], "LFP cells (asked 2026-03-22)")

    def test_products_with_nothing_but_a_format_still_read_sensibly(self):
        frontmatter = parse_valid(products=[{"format": "modules", "status": "said_interested"}])
        profile = bd.to_buyer_profile(frontmatter)
        self.assertEqual(profile["wants"], "modules (said interested)")

    def test_kwh_range_from_multiple_options(self):
        frontmatter = parse_valid(products=[
            {"make": "Renault", "format": "packs", "kwh": [55, 84], "status": "asked"},
        ])
        profile = bd.to_buyer_profile(frontmatter)
        self.assertEqual((profile["kwh_min"], profile["kwh_max"]), (55, 84))

    def test_missing_frontmatter_maps_to_empty_profile(self):
        profile = bd.to_buyer_profile({})
        self.assertEqual(profile["chemistries"], [])
        self.assertEqual(profile["formats"], [])
        self.assertEqual(profile["wants"], "")
        self.assertIsNone(profile["kwh_min"])
        self.assertEqual(profile["dossier"], {})


class ReaderCompatibilityTests(unittest.TestCase):
    """The flats must be values today's readers match.

    scoreBuyer (apps/web/lib/buyer-suggestions.ts): chemistry compared upper-cased, format
    compared case-insensitively, makes and cell_makers matched as normalised words, at least one
    chemistry or format match required.
    """

    @staticmethod
    def score(supply, profile):
        chem = supply.get("chemistry")
        fmt = supply.get("format")
        chems = [c.upper() for c in profile.get("chemistries", [])]
        formats = profile.get("formats", [])
        matched = []
        if chems:
            if not chem:
                pass
            elif chem.upper() in chems:
                matched.append("chemistry")
            else:
                return None
        if formats:
            if not fmt:
                pass
            elif any(f.lower() == fmt.lower() for f in formats):
                matched.append("format")
            else:
                return None
        if not matched:
            return None
        return matched

    def test_derived_values_match_a_supply(self):
        profile = bd.to_buyer_profile(bd.parse(VALID)[0])
        self.assertIsNotNone(self.score({"chemistry": "NMC", "format": "Packs"}, profile))
        self.assertIsNotNone(self.score({"chemistry": "lfp", "format": "cells"}, profile))

    def test_other_chemistry_still_rules_out(self):
        profile = bd.to_buyer_profile(bd.parse(VALID)[0])
        self.assertIsNone(self.score({"chemistry": "LTO", "format": "Packs"}, profile))

    def test_rules_out_makes_the_reader_rule_out(self):
        frontmatter = parse_valid()
        frontmatter["rules_out"]["chemistries"] = ["NMC"]
        profile = bd.to_buyer_profile(frontmatter)
        self.assertIsNone(self.score({"chemistry": "NMC", "format": "Packs"}, profile))

    def test_makes_are_canonical_group_names(self):
        profile = bd.to_buyer_profile(bd.parse(VALID)[0])
        self.assertTrue(set(profile["makes"]) <= set(bd.MAKES))
        self.assertTrue(set(profile["cell_makers"]) <= set(bd.CELL_MAKERS + bd.EXTRA_CELL_MAKERS))


class DiffTests(unittest.TestCase):
    def test_added_and_removed_lists(self):
        old = {"chemistries": ["NMC", "LFP"], "formats": ["Packs"], "origins": ["Passenger EV"]}
        new = {"chemistries": ["LFP", "NCA"], "formats": ["Packs"], "kwh_min": 30}
        diff = bd.diff_profiles(old, new)
        self.assertEqual(diff["chemistries"], {"added": ["NCA"], "removed": ["NMC"]})
        self.assertNotIn("formats", diff)
        self.assertEqual(diff["origins"], {"added": [], "removed": ["Passenger EV"]})
        self.assertEqual(diff["kwh_min"], {"old": None, "new": 30})

    def test_wants_compared_line_by_line(self):
        diff = bd.diff_profiles({"wants": "a\nb"}, {"wants": "b\nc"})
        self.assertEqual(diff["wants"], {"added": ["c"], "removed": ["a"]})

    def test_no_change_is_empty(self):
        self.assertEqual(bd.diff_profiles({"wants": "a"}, {"wants": "a"}), {})


class SharedFixtureTests(unittest.TestCase):
    """The same fixtures drive apps/web/lib/buyer-dossier.test.ts, so the two derivers cannot drift."""

    FIXTURES = Path(__file__).resolve().parent / "fixtures" / "buyer_dossier"

    def cases(self):
        for markdown in sorted(self.FIXTURES.glob("*.md")):
            yield markdown.stem, json.loads(markdown.with_suffix(".json").read_text(encoding="utf-8"))

    def test_the_fixture_set_is_present(self):
        self.assertEqual([name for name, _ in self.cases()], ["full", "invalid", "minimal", "no-frontmatter"])

    def test_parse_matches_the_expected_frontmatter_and_body(self):
        for name, expected in self.cases():
            with self.subTest(name=name):
                frontmatter, body = bd.load(self.FIXTURES / f"{name}.md")
                self.assertEqual(frontmatter, expected["frontmatter"])
                self.assertEqual(body, expected["body"])

    def test_validation_matches_the_expected_errors(self):
        for name, expected in self.cases():
            with self.subTest(name=name):
                frontmatter, _ = bd.load(self.FIXTURES / f"{name}.md")
                self.assertEqual(bd.validate(frontmatter), expected["errors"])

    def test_mapping_matches_the_expected_profile(self):
        for name, expected in self.cases():
            if expected["profile"] is None:
                continue
            with self.subTest(name=name):
                frontmatter, _ = bd.load(self.FIXTURES / f"{name}.md")
                self.assertEqual(bd.to_buyer_profile(frontmatter), expected["profile"])


if __name__ == "__main__":
    unittest.main()
