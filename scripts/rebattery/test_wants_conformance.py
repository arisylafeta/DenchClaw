"""Rule tests for wants_conformance on synthetic rows. No database."""
import unittest

import wants_conformance as wc


def line(id, **kw):
    base = {"id": id, "company_id": "c1", "kind": "ask", "ownership": "synced", "product_key": "broad:any-packs",
            "product_key_level": "broad", "make": None, "model": None, "raw_product": None, "format": None,
            "chemistry": None, "kwh_min": None, "kwh_max": None, "demand_id": None, "offer_id": None,
            "saved_search_id": None, "source_refs": []}
    base.update(kw)
    return base


def ctx(lines, demands=None, offers=None, products=None, profile=None):
    return {"lines": lines, "demands": {d["id"]: d for d in demands or []}, "offers": {o["id"]: o for o in offers or []},
            "companies": {"c1": {"name": "Acme", "buyer_profile": profile or {}, "dossier_products": products or []}}}


STN = {"id": "d1", "status": "open", "closed_reason": None,
       "summary": "STN: 1 Toyota Proace 50 kWh NMC trial pack plus 10 conditional, and 2 Stellantis 52 kWh LFP van packs",
       "spec": {"makes": ["Toyota or Lexus", "Stellantis"], "chemistries": ["NMC", "LFP"], "formats": ["Packs"],
                "product_family": "Toyota Proace 50kWh NMC; Stellantis e-K9 52kWh LFP"}}


def stn_line(id, make, chem):
    return line(id, demand_id="d1", make=make, chemistry=chem, format="pack", product_key=f"broad:{make}-{chem}-packs")


class R1(unittest.TestCase):
    def test_stn_cross_product_flags_untraceable_pairs_only(self):
        lines = [stn_line("a", "Toyota or Lexus", "NMC"), stn_line("b", "Toyota or Lexus", "LFP"),
                 stn_line("c", "Stellantis", "LFP"), stn_line("d", "Stellantis", "NMC")]
        flagged = {v["line_id"] for v in wc.r1(ctx(lines, [STN]))}
        self.assertEqual(flagged, {"b", "d"})

    def test_single_valued_source_is_not_flagged(self):
        demand = {"id": "d1", "status": "open", "summary": "Tesla packs", "spec": {"makes": ["Tesla", "BYD"], "chemistries": ["LFP"]}}
        self.assertEqual(wc.r1(ctx([line("a", demand_id="d1", make="BYD", chemistry="LFP")], [demand])), [])

    def test_one_clause_listing_every_value_traces_all(self):
        demand = {"id": "d1", "status": "open", "summary": "Tesla or BYD LFP or NMC packs",
                  "spec": {"makes": ["Tesla", "BYD"], "chemistries": ["LFP", "NMC"]}}
        self.assertEqual(wc.r1(ctx([line("a", demand_id="d1", make="BYD", chemistry="NMC")], [demand])), [])

    def test_profile_cross_product(self):
        profile = {"makes": ["Tesla", "Nissan"], "formats": ["Modules", "Packs"], "wants": "Donor modules for service."}
        out = wc.r1(ctx([line("p", kind="inferred", make="Tesla", format="pack")], profile=profile))
        self.assertEqual([v["line_id"] for v in out], ["p"])

    def test_dossier_line_needs_a_product_stating_the_pairing(self):
        products = [{"make": "CALB", "chemistry": "LFP", "format": "cells"}, {"make": "Tesla", "chemistry": "NMC", "format": "packs"}]
        good = line("bi_dossier_1", make="CALB", chemistry="LFP", format="cell")
        bad = line("bi_dossier_2", make="Tesla", chemistry="LFP", format="pack")
        self.assertEqual([v["line_id"] for v in wc.r1(ctx([good, bad], products=products))], ["bi_dossier_2"])


class R2(unittest.TestCase):
    def declined(self, **kw):
        return line("x", kind="declined", make="Tesla", format="pack", demand_id="d1", **kw)

    def test_closed_demand_only_is_flagged(self):
        demand = {"id": "d1", "status": "closed", "closed_reason": "expired", "summary": "", "spec": {}}
        self.assertEqual(len(wc.r2(ctx([self.declined()], [demand]))), 1)

    def test_open_demand_is_not(self):
        demand = {"id": "d1", "status": "open", "summary": "", "spec": {}}
        self.assertEqual(wc.r2(ctx([self.declined()], [demand])), [])

    def test_declined_offer_or_dossier_product_backs_it(self):
        demand = {"id": "d1", "status": "closed", "closed_reason": "expired", "summary": "", "spec": {}}
        self.assertEqual(wc.r2(ctx([self.declined(offer_id="o1")], [demand])), [])
        products = [{"make": "Tesla", "format": "packs", "status": "declined"}]
        self.assertEqual(wc.r2(ctx([self.declined()], [demand], products=products)), [])
        offer = {"id": "o1", "bulk_listing_id": "b1", "company_id": "c1", "stage": "declined"}
        self.assertEqual(wc.r2(ctx([self.declined(source_refs=["crm:b1"])], [demand], [offer])), [])


class R3(unittest.TestCase):
    def test_non_canonical_slug(self):
        bad = line("a", product_key="model:hyundai-konaelectric-64kwh", make="Hyundai", model="Kona Electric")
        good = line("b", product_key="model:hyundai-kona-64kwh", make="Hyundai", model="Kona Electric")
        self.assertEqual([v["line_id"] for v in wc.r3(ctx([bad, good]))], ["a"])

    def test_broad_and_part_keys_are_ignored(self):
        self.assertEqual(wc.r3(ctx([line("a", product_key="part:ABC1", model="Whatever")])), [])


class R4(unittest.TestCase):
    def test_duplicate_key(self):
        out = wc.r4(ctx([line("a"), line("b")]))
        self.assertEqual([v["line_id"] for v in out], ["b"])

    def test_redundant_less_specific_from_same_source(self):
        broad = line("a", demand_id="d1", make="Tesla", format="pack", product_key="broad:tesla-any-packs")
        model = line("b", demand_id="d1", make="Tesla", format="pack", product_key="model:tesla-model3", product_key_level="model")
        self.assertEqual([v["line_id"] for v in wc.r4(ctx([broad, model]))], ["a"])

    def test_different_sources_are_not_redundant(self):
        broad = line("a", demand_id="d1", make="Tesla", format="pack", product_key="broad:tesla-any-packs")
        model = line("b", demand_id="d2", make="Tesla", format="pack", product_key="model:tesla-model3", product_key_level="model")
        self.assertEqual(wc.r4(ctx([broad, model])), [])


class R5(unittest.TestCase):
    def test_vehicle_make_with_systems(self):
        lines = [line("a", make="Nissan", format="system", product_key="broad:nissan-any-systems"),
                 line("b", make="Nissan", format="pack", product_key="broad:nissan-any-packs"),
                 line("c", make="Fluence", format="system", product_key="broad:fluence-any-systems")]
        self.assertEqual([v["line_id"] for v in wc.r5(ctx(lines))], ["a"])


class R6(unittest.TestCase):
    def test_demand_detail_lost(self):
        demand = {"id": "d1", "status": "open", "summary": "Panasonic NCR cells, 400V", "spec": {
            "cell_makers": ["Panasonic"], "cell_formats": ["21700"], "part_numbers": ["NCR21700A"], "kwh_min": 5}}
        bare = line("a", demand_id="d1", format="cell", product_key="broad:any-cells")
        why = wc.r6(ctx([bare], [demand]))[0]["why"]
        for text in ("cell maker Panasonic", "cell format 21700", "part number NCR21700A", "kWh 5.0", "voltage 400V"):
            self.assertIn(text, why)

    def test_carried_detail_is_not_lost(self):
        demand = {"id": "d1", "status": "open", "summary": "", "spec": {"cell_makers": ["Panasonic"], "part_numbers": ["NCR21700A"], "kwh_min": 5}}
        rich = line("a", demand_id="d1", make="Panasonic", product_key="part:NCR21700A", kwh_min=5)
        self.assertEqual(wc.r6(ctx([rich], [demand])), [])

    def test_dossier_product_detail_lost(self):
        products = [{"make": "Kokam", "part_number": "KCL255", "kwh": [0.2], "status": "asked"}]
        bare = line("bi_dossier_1", make="Kokam", product_key="broad:kokam-any-cells")
        why = wc.r6(ctx([bare], products=products))[0]["why"]
        self.assertIn("part number KCL255", why)
        self.assertIn("kWh 0.2", why)
        self.assertNotIn("cell maker", why)


class Report(unittest.TestCase):
    def test_counts_and_example_cap(self):
        lines = [line(f"a{i}", make="Nissan", format="system", product_key=f"broad:nissan-any-systems-{i}") for i in range(30)]
        c = ctx(lines)
        results = wc.check(c)
        summary = wc.summarise(c, results)
        self.assertEqual(summary["counts"]["R5"], 30)
        self.assertEqual(len(summary["examples"]["R5"]), 20)
        self.assertIn("| R5 | 30 |", wc.render_markdown(c, results))


if __name__ == "__main__":
    unittest.main()
