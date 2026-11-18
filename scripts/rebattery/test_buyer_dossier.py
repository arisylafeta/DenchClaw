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

    def test_company_id_is_required_and_must_be_text(self):
        frontmatter = parse_valid()
        del frontmatter["company_id"]
        self.assertIn("company_id: required (the company the dossier belongs to)", bd.validate(frontmatter))
        self.assertIn("company_id: required (the company the dossier belongs to)",
                      bd.validate(parse_valid(company_id="   ")))
        self.assertTrue(any(e == "company_id: must be a string" for e in bd.validate(parse_valid(company_id=["a"]))))

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
        frontmatter = parse_valid(needs_continuity=True, origins=["Passenger EV", "bus or truck"],
                                  source_countries=["DE", "pl"], min_soh=70,
                                  timing={"max_lead_days": 30, "notes": "wants stock within a month"})
        self.assertEqual(bd.validate(frontmatter), [])

    def test_min_pack_voltage_part_numbers_and_reason(self):
        fm = parse_valid(min_pack_voltage={"value": 450, "seen": "2026-08-20", "src": "x"})
        fm["rules_out"] = {"part_numbers": [{"value": "NCR2170M", "seen": "2026-10-24"}]}
        fm["products"][0]["reason"] = "needs wire bonding"
        self.assertEqual(bd.validate(fm), [])
        self.assertEqual(bd.to_buyer_profile(fm)["min_pack_voltage"], 450)
        bad = parse_valid(min_pack_voltage={"value": "high", "colour": 1})
        bad["products"][0]["reason"] = 3
        errors = bd.validate(bad)
        self.assertTrue(any(e.startswith("min_pack_voltage.value") for e in errors), errors)
        self.assertTrue(any(e.startswith("min_pack_voltage.colour") for e in errors), errors)
        self.assertTrue(any(e.startswith("products[0].reason") for e in errors), errors)
        self.assertNotIn("min_pack_voltage", bd.to_buyer_profile(parse_valid()))

    def test_one_off_is_a_boolean_on_a_product(self):
        fm = parse_valid()
        fm["products"][0]["one_off"] = True
        self.assertEqual(bd.validate(fm), [])
        fm["products"][0]["one_off"] = "yes"
        self.assertTrue(any(e.startswith("products[0].one_off") for e in bd.validate(fm)))

    def test_model_with_kwh_brackets_or_list_warns_but_validates(self):
        fm = parse_valid()
        fm["products"][0]["model"] = "Zoe 52 kWh (ZE50)"
        fm["products"].append({"model": "ID.3, ID.4", "format": "Packs", "status": "asked"})
        self.assertEqual(bd.validate(fm), [])
        found = bd.warnings(fm)
        self.assertEqual(len(found), 2, found)
        self.assertIn("kWh figure", found[0])
        self.assertIn("brackets", found[0])
        self.assertIn("list", found[1])
        self.assertEqual(bd.warnings(parse_valid()), [])

    def test_new_keys_reject_wrong_values(self):
        errors = bd.validate(parse_valid(needs_continuity="yes", origins=["Germany"], min_soh=120))
        self.assertTrue(any(e.startswith("needs_continuity:") for e in errors), errors)
        self.assertTrue(any(e.startswith("origins[0]:") for e in errors), errors)
        self.assertTrue(any("min_soh" in e and "outside 0-100" in e for e in errors), errors)
        errors = bd.validate(parse_valid(origins="DE", min_soh="80"))
        self.assertTrue(any(e.startswith("origins: must be a list") for e in errors), errors)
        self.assertTrue(any(e.startswith("min_soh: must be a number") for e in errors), errors)

    def test_origins_is_an_application_origin_and_source_countries_is_iso2(self):
        # A country in `origins` is a real mistake: the buy box reads it as the battery's application.
        errors = bd.validate(parse_valid(origins=["DE"], source_countries=["DEU", "D"]))
        self.assertTrue(any(e.startswith("origins[0]:") for e in errors), errors)
        self.assertTrue(any(e.startswith("source_countries[0]:") for e in errors), errors)
        self.assertTrue(any(e.startswith("source_countries[1]:") for e in errors), errors)
        self.assertTrue(any(e.startswith("source_countries: must be a list") for e in
                            bd.validate(parse_valid(source_countries="DE"))))

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

    def test_rules_out_cell_formats_and_product_cell_format_validate(self):
        ok = parse_valid(rules_out={"cell_formats": ["pouch", {"value": "4680", "seen": "2026-05-01"}]})
        self.assertEqual(bd.validate(ok), [])
        bad = bd.validate(parse_valid(rules_out={"cell_formats": ["square"]}))
        self.assertTrue(any(e.startswith("rules_out.cell_formats[0]") for e in bad), bad)
        products = [{"format": "Cells", "chemistry": "LFP", "cell_format": "prismatic", "status": "asked"},
                    {"format": "Cells", "chemistry": "NMC", "cell_format": "26650", "status": "asked"}]
        self.assertEqual(bd.validate(parse_valid(products=products)), [])
        products[0]["cell_format"] = "square"
        self.assertTrue(any("cell_format" in e for e in bd.validate(parse_valid(products=products))))

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
        # The sizes are what they ask for (CALB 0.23 kWh), not the 82 kWh pack they once bought, and a point
        # size is not a stated range, so the flat bounds stay empty.
        self.assertIsNone(self.profile["kwh_min"])
        self.assertIsNone(self.profile["kwh_max"])
        self.assertEqual(self.profile["kwh_by_format"]["cells"], {"min": 0.23, "max": 0.23, "stated": False})

    def test_no_invented_origins_or_min_soh(self):
        self.assertNotIn("origins", self.profile)
        self.assertNotIn("min_soh", self.profile)

    def test_origins_and_min_soh_map_to_flat_keys(self):
        frontmatter = parse_valid(origins=["bus or truck", "Passenger EV"], min_soh=70,
                                  source_countries=["DE", "PL"])
        profile = bd.to_buyer_profile(frontmatter)
        # Registry spelling and registry order, whatever order the dossier lists them in.
        self.assertEqual(profile["origins"], ["Passenger EV", "Bus or truck"])
        self.assertEqual(profile["min_soh"], 70)
        # Where the goods come from is not a buy-box value: it stays in the dossier copy only.
        self.assertNotIn("source_countries", profile)
        self.assertEqual(profile["dossier"]["source_countries"], ["DE", "PL"])

    def test_a_country_in_origins_is_not_derived(self):
        profile = bd.to_buyer_profile(parse_valid(origins=["DE", "PL"]))
        self.assertNotIn("origins", profile)

    def test_kwh_range_prefers_the_asks_over_an_older_smaller_purchase(self):
        frontmatter = parse_valid(products=[
            {"format": "packs", "chemistry": "LFP", "kwh": [30], "status": "asked"},
            {"make": "Renault", "format": "packs", "chemistry": "LMO", "kwh": [22], "status": "bought"},
        ])
        profile = bd.to_buyer_profile(frontmatter)
        # Point sizes from asks are not a stated range: the flat bounds stay null, the sizes stay for ranking.
        self.assertEqual((profile["kwh_min"], profile["kwh_max"]), (None, None))
        self.assertEqual(profile["kwh_by_format"], {"packs": {"min": 30, "max": 30, "stated": False}})

    def test_kwh_range_falls_back_to_bought_when_no_ask_states_a_capacity(self):
        frontmatter = parse_valid(products=[
            {"make": "BYD", "format": "systems", "status": "said_interested"},
            {"make": "Renault", "format": "packs", "chemistry": "LMO", "kwh": [22], "status": "bought"},
        ])
        profile = bd.to_buyer_profile(frontmatter)
        self.assertEqual((profile["kwh_min"], profile["kwh_max"]), (None, None))
        self.assertEqual(profile["kwh_by_format"], {"packs": {"min": 22, "max": 22, "stated": False}})

    def test_a_declined_product_never_sets_the_range(self):
        frontmatter = parse_valid(products=[
            {"make": "Tesla", "format": "packs", "chemistry": "NMC", "kwh": [75], "status": "declined"},
            {"make": "Renault", "format": "packs", "chemistry": "LMO", "kwh": [22], "status": "bought"},
        ])
        profile = bd.to_buyer_profile(frontmatter)
        self.assertEqual(profile["kwh_by_format"], {"packs": {"min": 22, "max": 22, "stated": False}})

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

    def test_fpt_and_iveco_are_not_stellantis(self):
        frontmatter = parse_valid(products=[
            {"make": "FPT Industrial", "format": "packs", "status": "bought"},
            {"make": "Iveco", "format": "packs", "status": "asked"},
            {"make": "PSA", "format": "packs", "status": "asked"},
        ])
        self.assertEqual(bd.to_buyer_profile(frontmatter)["makes"], ["Stellantis"])
        frontmatter = parse_valid(products=[{"make": "FPT", "format": "packs", "status": "bought"}])
        self.assertEqual(bd.to_buyer_profile(frontmatter)["makes"], [])

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
        self.assertEqual((profile["kwh_min"], profile["kwh_max"]), (None, None))
        self.assertEqual(profile["kwh_by_format"]["packs"], {"min": 55, "max": 84, "stated": False})

    def _bounds(self, products):
        profile = bd.to_buyer_profile(parse_valid(products=products))
        return profile["kwh_min"], profile["kwh_max"], profile.get("kwh_by_format")

    def test_kwh_bounds_keep_packs_and_systems_apart(self):
        # Modual-like: open-ended LFP packs from 30 kWh next to a 1,577 kWh containerised system.
        lo, hi, by_format = self._bounds([
            {"format": "packs", "chemistry": "LFP", "kwh_min": 30, "status": "asked"},
            {"make": "BYD", "format": "systems", "chemistry": "LFP", "kwh": [1577], "status": "asked"},
        ])
        self.assertEqual((lo, hi), (30, None))
        self.assertEqual(by_format, {"packs": {"min": 30, "max": None, "stated": True},
                                     "systems": {"min": 1577, "max": 1577, "stated": False}})

    def test_systems_only_buyer_uses_the_systems_bounds_at_top_level(self):
        lo, hi, by_format = self._bounds([
            {"make": "BYD", "format": "systems", "kwh": [1577], "status": "asked"}])
        self.assertEqual((lo, hi), (None, None))
        self.assertEqual(by_format, {"systems": {"min": 1577, "max": 1577, "stated": False}})
        lo, hi, by_format = self._bounds([
            {"make": "BYD", "format": "systems", "kwh_min": 1500, "kwh_max": 1600, "status": "asked"}])
        self.assertEqual((lo, hi), (1500, 1600))
        self.assertEqual(by_format, {"systems": {"min": 1500, "max": 1600, "stated": True}})

    def test_systems_never_set_top_level_when_the_buyer_also_wants_other_formats(self):
        lo, hi, by_format = self._bounds([
            {"format": "modules", "status": "asked"},
            {"format": "systems", "kwh": [500], "status": "asked"}])
        self.assertEqual((lo, hi), (None, None))
        self.assertEqual(by_format, {"systems": {"min": 500, "max": 500, "stated": False}})

    def test_pack_figures_41_and_52_give_both_bounds(self):
        lo, hi, by_format = self._bounds([
            {"make": "Renault", "model": "ZOE", "format": "packs", "kwh": [41], "status": "asked"},
            {"make": "Renault", "model": "ZOE", "format": "packs", "kwh": [52], "status": "asked"}])
        # Bought or asked point sizes keep both bounds for ranking but are not stated, so no flat bounds.
        self.assertEqual((lo, hi), (None, None))
        self.assertEqual(by_format, {"packs": {"min": 41, "max": 52, "stated": False}})

    def test_open_kwh_min_leaves_the_max_null_and_wins_over_a_closed_sibling(self):
        lo, hi, _ = self._bounds([
            {"format": "packs", "kwh_min": 30, "status": "asked"},
            {"format": "packs", "kwh": [60], "status": "asked"}])
        self.assertEqual((lo, hi), (30, None))

    def test_open_kwh_max_leaves_the_min_null(self):
        lo, hi, by_format = self._bounds([{"format": "modules", "kwh_max": 5, "status": "asked"}])
        self.assertEqual((lo, hi), (None, 5))
        self.assertEqual(by_format, {"modules": {"min": None, "max": 5, "stated": True}})

    def test_no_capacity_gives_no_by_format_key(self):
        profile = bd.to_buyer_profile(parse_valid(products=[{"format": "packs", "status": "asked"}]))
        self.assertNotIn("kwh_by_format", profile)

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
            if markdown.name == "README.md":
                continue
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


class MergeFixtureTests(unittest.TestCase):
    """The merge fixtures drive apps/web/lib/buyer-dossier.test.ts too: one merge rule, both languages."""

    FIXTURES = Path(__file__).resolve().parent / "fixtures" / "buyer_dossier"

    def cases(self):
        return json.loads((self.FIXTURES / "merge.json").read_text(encoding="utf-8"))["cases"]

    def test_the_merge_fixture_set_is_present(self):
        self.assertEqual([case["name"] for case in self.cases()], [
            "pass-through keys survive and derived keys are replaced",
            "the same dossier over its own derived profile changes nothing",
            "a derived key the dossier no longer states is dropped, not kept stale",
            "the kwh range comes from the asks, not an older smaller purchase",
            "with no capacity in the asks the range falls back to what they bought",
            "origins is the application origin and source countries stay in the dossier",
        ])

    def test_merge_matches_the_expected_profile(self):
        for case in self.cases():
            with self.subTest(name=case["name"]):
                profile, passed_through, _ = bd.merge_profile(case["existing"], case["frontmatter"])
                self.assertEqual(passed_through, case["expected_passed_through"])
                self.assertEqual(profile, case["expected_profile"])

    def test_change_detection_matches_the_fixture(self):
        for case in self.cases():
            with self.subTest(name=case["name"]):
                profile, _, _ = bd.merge_profile(case["existing"], case["frontmatter"])
                changed = json.dumps(case["existing"], sort_keys=True) != json.dumps(profile, sort_keys=True)
                self.assertEqual(changed, case["changed"])


if __name__ == "__main__":
    unittest.main()
