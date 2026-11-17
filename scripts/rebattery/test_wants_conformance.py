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

    def test_buy_box_cross_product_is_independent_criteria(self):
        profile = {"makes": ["Tesla", "Nissan"], "formats": ["Modules", "Packs"], "wants": "Donor modules for service."}
        self.assertEqual(wc.r1(ctx([line("p", kind="inferred", make="Tesla", format="pack")], profile=profile)), [])

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

    def test_stated_column_does_not_carry_a_cell_maker_or_part_number(self):
        demand = {"id": "d1", "status": "open", "summary": "", "spec": {"cell_makers": ["CALB"], "part_numbers": ["L135F72H"]}}
        bare = line("a", demand_id="d1", format="cell", product_key="broad:any-cells",
                    stated={"cell_makers": ["CALB"], "part_numbers": ["L135F72H"]})
        why = wc.r6(ctx([bare], [demand]))[0]["why"]
        self.assertIn("cell maker CALB", why)
        self.assertIn("part number L135F72H", why)

    def test_cell_format_may_sit_in_stated(self):
        demand = {"id": "d1", "status": "open", "summary": "", "spec": {"cell_formats": ["Prismatic"]}}
        kept = line("a", demand_id="d1", format="cell", product_key="broad:any-cells", stated={"cell_formats": ["Prismatic"]})
        self.assertEqual(wc.r6(ctx([kept], [demand])), [])

    def test_cell_maker_in_a_broad_key_is_carried(self):
        demand = {"id": "d1", "status": "open", "summary": "", "spec": {"cell_makers": ["CALB"]}}
        keyed = line("a", demand_id="d1", make="CALB", format="cell", product_key="broad:calb-any-cells")
        self.assertEqual(wc.r6(ctx([keyed], [demand])), [])


class R7(unittest.TestCase):
    def run7(self, old, new, demands=None, products=None):
        c = ctx(new, demands, products=products)
        c["baseline_lines"] = old
        return wc.r7(c), c["r7_explained"]

    DEMAND = {"id": "d1", "status": "closed", "closed_reason": "bought_from_us", "summary": "CALB L135F72H cells", "spec": {}}

    def test_level_drop_with_detail_still_stated_is_a_regression(self):
        old = [line("o", kind="bought", demand_id="d1", product_key="part:L135F72H", product_key_level="part")]
        new = [line("n", kind="bought", demand_id="d1")]
        hits, explained = self.run7(old, new, [self.DEMAND])
        self.assertTrue(any("fell" in h["why"] for h in hits))
        self.assertTrue(any("part number L135F72H" in h["why"] for h in hits))
        self.assertEqual(explained, [])

    def test_part_number_kept_in_a_key_is_not_a_regression(self):
        old = [line("o", kind="bought", demand_id="d1", product_key="part:L135F72H", product_key_level="part")]
        new = [line("n", kind="bought", demand_id="d1", product_key="part:L135F72H", product_key_level="part")]
        self.assertEqual(self.run7(old, new, [self.DEMAND]), ([], []))

    def test_detail_the_source_no_longer_states_is_explained(self):
        old = [line("bi_dossier_o", kind="bought", product_key="part:L135F72H", product_key_level="part"),
               line("bi_dossier_p", kind="bought", product_key="model:vauxhall-vivaro-75kwh", product_key_level="model", make="Vauxhall", model="Vivaro")]
        new = [line("bi_dossier_p", kind="bought", product_key="model:vauxhall-vivaro-75kwh", product_key_level="model", make="Vauxhall", model="Vivaro")]
        hits, explained = self.run7(old, new, products=[{"make": "Vauxhall", "model": "Vivaro", "status": "bought"}])
        self.assertEqual(hits, [])
        self.assertTrue(all("no longer states" in e["explained"] for e in explained) and explained)

    def test_canonical_model_slug_is_not_a_lost_model(self):
        old = [line("bi_dossier_o", kind="ask", product_key="model:hyundai-konaelectric-64kwh", product_key_level="model", make="Hyundai", model="Kona Electric")]
        new = [line("bi_dossier_n", kind="ask", product_key="model:hyundai-kona-64kwh", product_key_level="model", make="Hyundai", model="Kona Electric")]
        self.assertEqual(self.run7(old, new)[0], [])

    def test_cell_maker_of_a_broad_key_must_stay_in_a_key(self):
        old = [line("o", kind="bought", demand_id="d1", product_key="broad:calb-any-cells", make="CALB", format="cell")]
        new = [line("n", kind="bought", demand_id="d1", product_key="broad:any-cells", format="cell")]
        hits, _ = self.run7(old, new, [self.DEMAND])
        self.assertTrue(any("cell maker CALB" in h["why"] for h in hits))

    def test_broad_maker_covered_by_a_more_specific_line_is_explained(self):
        old = [line("bi_dossier_o", product_key="broad:samsung-sdi-nmc-cells", make="Samsung SDI", format="cell")]
        new = [line("bi_dossier_n", product_key="part:INR1865025R", product_key_level="part", make="Samsung SDI", format="cell")]
        hits, explained = self.run7(old, new, products=[{"make": "Samsung SDI", "part_number": "INR1865025R", "status": "asked"}])
        self.assertEqual(hits, [])
        self.assertIn("R4", explained[0]["explained"])

    def test_company_losing_every_line_of_a_kind(self):
        old = [line("o", kind="declined", demand_id="d9", product_key="broad:any-packs")]
        hits, _ = self.run7(old, [line("n", kind="ask", demand_id="d1")])
        self.assertTrue(any("lost all" in h["why"] for h in hits))

    def test_closed_request_decline_removed_is_explained_by_r2(self):
        demand = {"id": "d9", "status": "closed", "closed_reason": "bought_elsewhere", "summary": "packs", "spec": {}}
        old = [line("o", kind="declined", demand_id="d9", product_key="broad:any-packs")]
        hits, explained = self.run7(old, [line("n", kind="ask", demand_id="d1")], [demand])
        self.assertEqual(hits, [])
        self.assertIn("R2", explained[0]["explained"])

    def test_open_source_that_writes_nothing_now_is_a_regression(self):
        old = [line("o", kind="ask", saved_search_id="s1", product_key="model:toyota-corolla", product_key_level="model")]
        hits, _ = self.run7(old, [line("n", kind="ask", demand_id="d1")])
        self.assertTrue(any("writes none now" in h["why"] for h in hits))

    def test_no_baseline_means_no_check(self):
        c = ctx([line("n")])
        self.assertEqual(wc.r7(c), [])


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
