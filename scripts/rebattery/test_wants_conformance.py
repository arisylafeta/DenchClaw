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

    def test_cell_format_in_the_key_is_not_a_made_up_pairing(self):
        demand = {"id": "d1", "status": "open", "summary": "Retired cells, chemistry is flexible", "spec": {
            "chemistries": ["LFP", "NMC"], "formats": ["Cells", "Modules"], "cell_formats": ["Prismatic", "Pouch"]}}
        keyed = line("a", demand_id="d1", chemistry="NMC", format="cell", product_key="broad:prismatic-nmc-cells")
        plain = line("b", demand_id="d1", chemistry="NMC", format="cell", product_key="broad:nmc-cells")
        self.assertEqual(wc.r1(ctx([keyed], [demand])), [])
        self.assertEqual(len(wc.r1(ctx([plain], [demand]))), 1)

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

    def test_said_line_only_from_a_request_closed_as_a_reply(self):
        said = lambda: line("s", kind="interest", demand_id="d1", make="Tesla", format="pack")
        reply = {"id": "d1", "status": "closed", "closed_reason": "offer_reply", "summary": "", "spec": {}}
        expired = {"id": "d1", "status": "closed", "closed_reason": "expired", "summary": "", "spec": {}}
        self.assertEqual(wc.r2(ctx([said()], [reply])), [])
        self.assertEqual(len(wc.r2(ctx([said()], [expired]))), 1)


class R3(unittest.TestCase):
    def test_non_canonical_slug(self):
        bad = line("a", product_key="model:hyundai-konaelectric-64kwh", make="Hyundai", model="Kona Electric")
        good = line("b", product_key="model:hyundai-kona-64kwh", make="Hyundai", model="Kona Electric")
        self.assertEqual([v["line_id"] for v in wc.r3(ctx([bad, good]))], ["a"])

    def test_broad_and_part_keys_are_ignored(self):
        self.assertEqual(wc.r3(ctx([line("a", product_key="part:ABC1", model="Whatever")])), [])

    def test_ev_prefixed_and_plus_models_are_non_canonical_keys(self):
        for make, model, key in (("Kia", "e-Niro", "model:kia-eniro-64kwh"), ("Nissan", "Leaf e+", "model:nissan-leafe-62kwh"),
                                 ("Citroen", "e-Berlingo", "model:citroen-eberlingo-50kwh")):
            self.assertEqual(len(wc.r3(ctx([line("a", product_key=key, make=make, model=model)]))), 1, key)

    def test_smart_car_of_psa_keeps_its_name(self):
        ok = line("a", product_key="model:psa-smartcar300-44kwh", make="PSA", model="Smart Car 300")
        self.assertEqual(wc.r3(ctx([ok])), [])


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

    def dossier_pair(self):
        broad = line("bi_dossier_a", make="Tesla", format="pack", product_key="broad:tesla-any-packs")
        model = line("bi_dossier_b", make="Tesla", format="pack", product_key="model:tesla-model3", product_key_level="model")
        return [broad, model]

    def test_dossier_broad_line_that_a_product_states_itself_is_not_redundant(self):
        products = [{"make": "Tesla", "format": "packs", "status": "asked"}, {"make": "Tesla", "model": "Model 3", "format": "packs"}]
        self.assertEqual(wc.r4(ctx(self.dossier_pair(), products=products)), [])

    def test_dossier_broad_line_without_a_product_is_still_redundant(self):
        products = [{"make": "Tesla", "model": "Model 3", "format": "packs"}]
        self.assertEqual([v["line_id"] for v in wc.r4(ctx(self.dossier_pair(), products=products))], ["bi_dossier_a"])

    def test_declined_product_does_not_back_an_interest_line(self):
        products = [{"make": "Tesla", "format": "packs", "status": "declined"}, {"make": "Tesla", "model": "Model 3", "format": "packs"}]
        self.assertEqual([v["line_id"] for v in wc.r4(ctx(self.dossier_pair(), products=products))], ["bi_dossier_a"])


class R5(unittest.TestCase):
    def test_vehicle_make_with_systems(self):
        lines = [line("a", make="Nissan", format="system", product_key="broad:nissan-any-systems"),
                 line("b", make="Nissan", format="pack", product_key="broad:nissan-any-packs"),
                 line("c", make="Fluence", format="system", product_key="broad:fluence-any-systems")]
        self.assertEqual([v["line_id"] for v in wc.r5(ctx(lines))], ["a"])

    def test_tesla_storage_products_are_systems_by_nature(self):
        mega = line("m", make="Tesla", format="system", product_key="model:tesla-megapack", product_key_level="model", model="Megapack")
        self.assertEqual(wc.r5(ctx([mega])), [])


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
        bare = line("bi_dossier_1", make="Kokam", product_key="broad:kokam-any-cells", kwh_min=5, kwh_max=9)
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

    def test_pack_request_does_not_need_the_cell_format_in_a_line(self):
        pack = {"id": "d1", "status": "open", "summary": "", "spec": {"formats": ["Packs"], "cell_formats": ["Prismatic"]}}
        bare = line("a", demand_id="d1", format="pack", product_key="broad:any-packs")
        self.assertEqual(wc.r6(ctx([bare], [pack])), [])
        cells = {"id": "d1", "status": "open", "summary": "", "spec": {"formats": ["Cells"], "cell_formats": ["Prismatic"]}}
        self.assertIn("cell format Prismatic", wc.r6(ctx([line("a", demand_id="d1", format="cell", product_key="broad:any-cells")], [cells]))[0]["why"])

    def test_cell_model_names_its_cell_format_but_a_make_only_cell_product_does_not(self):
        named = [{"make": "Panasonic", "model": "NCR2170M", "format": "cells", "cell_format": "21700"}]
        self.assertEqual(wc.r6(ctx([line("bi_dossier_1", make="Panasonic", format="cell", product_key="model:panasonic-ncr2170m")], products=named)), [])
        bare = [{"make": "Panasonic", "format": "cells", "cell_format": "21700"}]
        out = wc.r6(ctx([line("bi_dossier_1", make="Panasonic", format="cell", product_key="broad:panasonic-any-cells")], products=bare))
        self.assertIn("cell format 21700", out[0]["why"])

    def test_make_only_product_kwh_is_carried_by_a_range_of_its_make_only(self):
        products = [{"make": "MG", "format": "packs", "kwh": [44.5]}]
        inside = line("bi_dossier_1", make="MG", format="pack", product_key="broad:mg-any-packs", kwh_min=40, kwh_max=75)
        outside = line("bi_dossier_1", make="MG", format="pack", product_key="broad:mg-any-packs", kwh_min=72.6, kwh_max=72.6)
        self.assertEqual(wc.r6(ctx([inside], products=products)), [])
        self.assertIn("kWh 44.5", wc.r6(ctx([outside], products=products))[0]["why"])


class R6Broader(unittest.TestCase):
    def test_an_open_ended_or_unbounded_broader_line_carries_a_dossier_kwh(self):
        products = [{"make": "Volkswagen Group", "format": "packs", "kwh": [55, 63, 82]}]
        ask = line("a", make="VW Group", product_key="broad:vw-group-any-packs", kwh_min=30)
        self.assertEqual(wc.r6(ctx([ask, line("bi_dossier_1", make="VW Group", product_key="broad:vw-group-any-packs")], products=products)), [])
        capped = line("b", make="VW Group", product_key="broad:vw-group-any-packs", kwh_min=30, kwh_max=60)
        self.assertIn("kWh 82", wc.r6(ctx([capped, line("bi_dossier_1", make="VW Group", product_key="broad:vw-group-any-packs", kwh_min=70, kwh_max=70)], products=products))[0]["why"])

    def test_an_expired_or_other_make_line_does_not_carry_it(self):
        products = [{"make": "MG", "format": "packs", "kwh": [44.5]}]
        dossier = line("bi_dossier_1", make="MG", product_key="broad:mg-any-packs", kwh_min=72.6, kwh_max=72.6)
        expired = line("a", make="MG", product_key="broad:mg-any-packs", expires_on="2020-01-01")
        other = line("b", make="BYD", product_key="broad:byd-any-packs")
        self.assertIn("kWh 44.5", wc.r6(ctx([dossier, expired, other], products=products))[0]["why"])


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


class R8(unittest.TestCase):
    ERAZBORKA = {"makes": ["Nissan", "Tesla", "BMW or Mini"], "formats": ["Modules", "Packs"], "chemistries": ["NMC"]}

    def test_buy_box_makeless_broad_line_is_widening(self):
        wide = line("a", kind="inferred", format="module", chemistry="NMC", product_key="broad:nmc-modules")
        ok = line("b", kind="inferred", make="Nissan", format="pack", chemistry="NMC", product_key="broad:nissan-nmc-packs")
        out = wc.r8(ctx([wide, ok], profile=self.ERAZBORKA))
        self.assertEqual([v["line_id"] for v in out], ["a"])
        self.assertIn("make", out[0]["why"])

    def test_brand_of_a_listed_group_is_inside_the_buy_box(self):
        box = {"makes": ["VW Group", "Hyundai or Kia"], "formats": ["Packs"]}
        audi = line("a", kind="inferred", make="Audi", format="pack", product_key="model:audi-etron", product_key_level="model")
        genesis = line("b", kind="inferred", make="Genesis", format="pack", product_key="part:37501CU050", product_key_level="part")
        rivian = line("c", kind="inferred", make="Rivian", format="pack", product_key="model:rivian-r1t", product_key_level="model")
        self.assertEqual([v["line_id"] for v in wc.r8(ctx([audi, genesis, rivian], profile=box))], ["c"])

    def test_buy_box_format_outside_the_list_but_model_key_is_fine(self):
        cell = line("a", kind="inferred", make="Tesla", format="cell", chemistry="NMC", product_key="broad:tesla-nmc-cells")
        model = line("b", kind="inferred", make="Tesla", format="cell", product_key="model:tesla-model3", product_key_level="model")
        out = wc.r8(ctx([cell, model], profile=self.ERAZBORKA))
        self.assertEqual([v["line_id"] for v in out], ["a"])
        self.assertIn("format", out[0]["why"])

    FELLTEN = {"id": "d1", "company_id": "c1", "status": "open", "summary": "Tesla Model 3 Long Range 75 kWh packs",
               "spec": {"makes": ["Tesla"], "models": ["Model 3"], "volume": 10, "max_price": 4000, "pack_kwh": 75,
                        "product_family": "Tesla Model 3 Long Range 75 kWh packs"}}

    def test_demand_line_dropping_the_model_is_widening(self):
        wide = line("a", demand_id="d1", make="Tesla", product_key="broad:tesla-any-batteries")
        out = wc.r8(ctx([wide], [self.FELLTEN]))
        self.assertEqual(len(out), 1)
        self.assertIn("model (model3)", out[0]["why"])

    def test_demand_model_line_is_not_widening(self):
        ok = line("a", demand_id="d1", make="Tesla", model="Model 3", product_key="model:tesla-model3-75kwh", product_key_level="model")
        self.assertEqual(wc.r8(ctx([ok], [self.FELLTEN])), [])

    def test_part_line_of_a_request_that_names_a_model_is_not_widening(self):
        demand = {"id": "d1", "company_id": "c1", "status": "open", "summary": "Kia EV6 77.4 kWh pack, part 37501-CV050", "spec": {"makes": ["Hyundai or Kia"]}}
        part = line("a", demand_id="d1", make="Kia", product_key="part:37501CV050", product_key_level="part")
        self.assertEqual(wc.r8(ctx([part], [demand])), [])
        broad = line("b", demand_id="d1", make="Kia", product_key="broad:hyundai-or-kia-any-packs")
        self.assertIn("model (ev6)", wc.r8(ctx([broad], [demand]))[0]["why"])

    def test_dossier_line_dropping_the_product_make_is_widening(self):
        products = [{"make": "Tesla", "chemistry": "NMC", "format": "packs"}]
        wide = line("bi_dossier_1", chemistry="NMC", format="pack", product_key="broad:nmc-packs")
        ok = line("bi_dossier_2", make="Tesla", chemistry="NMC", format="pack", product_key="broad:tesla-nmc-packs")
        self.assertEqual([v["line_id"] for v in wc.r8(ctx([wide, ok], products=products))], ["bi_dossier_1"])


class R8ByDesign(unittest.TestCase):
    def test_two_makes_and_two_chemistries_keep_chemistry_as_a_preference(self):
        demand = {"id": "d1", "status": "open", "summary": "Tesla or BYD packs", "spec": {"makes": ["Tesla", "BYD"], "chemistries": ["NMC", "LFP"]}}
        ok = line("a", demand_id="d1", make="BYD", product_key="broad:byd-any-batteries")
        self.assertEqual(wc.r8(ctx([ok], [demand])), [])

    def test_one_make_and_two_chemistries_still_flags_a_dropped_chemistry(self):
        demand = {"id": "d1", "status": "open", "summary": "BYD packs", "spec": {"makes": ["BYD"], "chemistries": ["NMC", "LFP"]}}
        out = wc.r8(ctx([line("a", demand_id="d1", make="BYD", product_key="broad:byd-any-batteries")], [demand]))
        self.assertEqual(len(out), 1)
        self.assertIn("chemistry", out[0]["why"])

    def test_plain_model_line_beside_kwh_model_lines_is_by_design(self):
        demand = {"id": "d1", "status": "open", "summary": "Hyundai Kona 39 and 64 kWh NMC packs", "spec": {"makes": ["Hyundai"], "chemistries": ["NMC"], "formats": ["Packs"]}}
        kwh = line("k", demand_id="d1", make="Hyundai", model="Kona", chemistry="NMC", format="pack", product_key="model:hyundai-kona-64kwh")
        plain = line("p", demand_id="d1", make="Hyundai", model="Kona", product_key="model:hyundai-kona")
        self.assertEqual(wc.r8(ctx([kwh, plain], [demand])), [])
        self.assertEqual(len(wc.r8(ctx([plain], [demand]))), 1)


class R8OwnLines(unittest.TestCase):
    BOX = {"makes": ["Nissan"], "formats": ["Packs"], "chemistries": ["NMC"]}

    def test_a_line_from_the_buyers_own_mail_may_be_broader_than_the_box(self):
        own = line("a", kind="standing", ownership="mastered", format="module", product_key="broad:any-modules",
                   source_refs=["email:gmail_msg_1:abc"])
        self.assertEqual(wc.r8(ctx([own], profile=self.BOX)), [])

    def test_research_and_parsed_lines_must_sit_inside_the_box(self):
        research = line("a", kind="standing", ownership="mastered", format="module", product_key="broad:any-modules",
                        source_refs=["crm:research:cee-2026-10:acme.com"])
        parsed = line("bi_parse_b", kind="interest", ownership="mastered", format="module", product_key="broad:any-modules",
                      source_refs=["crm:btd_1", "parse:live-20261115"])
        self.assertEqual({v["line_id"] for v in wc.r8(ctx([research, parsed], profile=self.BOX))}, {"a", "bi_parse_b"})


class R8Group(unittest.TestCase):
    def test_a_brand_of_a_named_make_group_is_not_broader(self):
        demand = {"id": "d1", "company_id": "c1", "status": "open", "summary": "Stellantis packs", "spec": {"makes": ["Stellantis", "Tesla"]}}
        citroen = line("a", demand_id="d1", make="Citroen", product_key="model:citroen-c3", product_key_level="model", model="C3")
        self.assertEqual(wc.r8(ctx([citroen], [demand])), [])
        bmw = line("b", demand_id="d1", make="BMW", product_key="broad:bmw-any-packs")
        self.assertEqual(len(wc.r8(ctx([bmw], [demand]))), 1)


class R9Scrap(unittest.TestCase):
    SCRAP = {"id": "d9", "company_id": "c1", "status": "open", "summary": "Scrap and end-of-life batteries as feedstock for his recycling plant",
             "spec": {"volume": 150, "volume_unit": "tonnes", "max_price": 28, "product_family": "Scrap EV batteries for recycling"}}

    def test_scrap_feedstock_request_with_no_product_needs_no_line(self):
        self.assertEqual(wc.r9(ctx([], [self.SCRAP])), [])

    def test_a_recycling_request_that_states_a_product_still_needs_its_line(self):
        stated = {**self.SCRAP, "id": "d10", "spec": {**self.SCRAP["spec"], "makes": ["Tesla"]}}
        self.assertEqual(wc.r9(ctx([], [stated]))[0]["key"], "no line")
        lfp = {**self.SCRAP, "id": "d11", "summary": "Scrap LFP packs for recycling"}
        self.assertEqual(wc.r9(ctx([], [lfp]))[0]["key"], "no line")


class R9(unittest.TestCase):
    def test_no_line_for_an_open_request(self):
        elg = {"id": "d2", "company_id": "c1", "status": "open", "summary": "21700 18650",
               "spec": {"product_family": "18650 / 21700 cylindrical cells", "volume": 100000, "max_price": 1}}
        out = wc.r9(ctx([], [elg]))
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["key"], "no line")

    def test_target_price_is_not_missing_when_a_line_carries_price_max(self):
        demand = {"id": "d2", "company_id": "c1", "status": "open", "summary": "Tesla packs", "spec": {"makes": ["Tesla"], "target_price_per_pack": 900}}
        keep = line("a", demand_id="d2", make="Tesla", price_max=1200)
        self.assertEqual(wc.r9(ctx([keep], [demand])), [])
        self.assertEqual(len(wc.r9(ctx([line("b", demand_id="d2", make="Tesla")], [demand]))), 1)

    def test_target_price_is_not_missing_when_a_line_carries_the_ceiling_price(self):
        demand = {"id": "d2", "company_id": "c1", "status": "open", "summary": "Tesla packs", "spec": {"makes": ["Tesla"], "max_price": 4000, "target_price_per_pack": 3000}}
        self.assertEqual(wc.r9(ctx([line("a", demand_id="d2", make="Tesla", price=4000)], [demand])), [])

    def test_a_range_only_in_product_family_is_report_only(self):
        demand = {"id": "d2", "company_id": "c1", "status": "open", "summary": "Shortlist: Tesla Model 3 57kWh, MG4 51kWh",
                  "spec": {"models": ["Model 3", "MG4"], "product_family": "Mixed EV packs 41-113kWh"}}
        lines = [line("a", demand_id="d2", make="Tesla", model="Model 3", product_key="model:tesla-model3", product_key_level="model"),
                 line("b", demand_id="d2", make="MG", model="MG4", product_key="model:mg-mg4", product_key_level="model")]
        base = ctx(lines, [demand])
        self.assertEqual([v for v in wc.r9(base) if "kWh" in v["why"]], [])
        self.assertEqual(len(base["r9_report_only"]), 1)
        lines[0]["kwh_min"] = 10  # a conflicting bound on a line: required again
        self.assertIn("kWh", wc.r9(ctx(lines, [demand]))[0]["why"])

    def test_model_the_sync_removed_on_purpose_is_not_missed(self):
        demand = {"id": "d2", "company_id": "c1", "status": "open", "summary": "Tesla Model 3 and Model Y packs", "spec": {"makes": ["Tesla"]}}
        keep = line("a", demand_id="d2", make="Tesla", model="Model 3", product_key="model:tesla-model3", product_key_level="model")
        base = ctx([keep], [demand])
        self.assertIn("model modely", wc.r9(base)[0]["why"])
        base["suppressed_by_demand"] = {"d2": ["model:tesla-modely"]}
        self.assertEqual(wc.r9(base), [])

    def test_closed_request_needs_no_line(self):
        closed = {"id": "d2", "company_id": "c1", "status": "closed", "closed_reason": "expired", "summary": "x", "spec": {}}
        self.assertEqual(wc.r9(ctx([], [closed])), [])

    def test_broad_line_misses_model_kwh_and_keeps_quantity_price(self):
        demand = R8.FELLTEN
        broad = line("a", demand_id="d1", make="Tesla", product_key="broad:tesla-any-batteries", quantity=10, price=4000)
        why = wc.r9(ctx([broad], [demand]))[0]["why"]
        self.assertIn("model model3", why)
        self.assertIn("kWh 75", why)
        self.assertNotIn("make", why)
        self.assertNotIn("quantity", why)
        self.assertNotIn("price", why)

    def test_fully_covered_request_is_clean(self):
        full = line("a", demand_id="d1", make="Tesla", model="Model 3", product_key="model:tesla-model3-75kwh",
                    product_key_level="model", kwh_min=75, kwh_max=75, quantity=10, price=4000)
        self.assertEqual(wc.r9(ctx([full], [R8.FELLTEN])), [])

    def test_lost_quantity_price_cell_format_and_maker(self):
        demand = {"id": "d3", "company_id": "c1", "status": "qualifying", "summary": "500,000 Samsung 50E (21700) cylindrical cells",
                  "spec": {"volume": 500000, "max_price": 1, "cell_formats": ["Cylindrical"], "cell_makers": ["Samsung SDI"]}}
        bare = line("a", demand_id="d3", format="cell", product_key="broad:any-cells")
        why = wc.r9(ctx([bare], [demand]))[0]["why"]
        for text in ("cell format 21700", "cell maker Samsung SDI", "quantity 500000", "price max_price 1"):
            self.assertIn(text, why)


class R10(unittest.TestCase):
    def test_same_key_in_two_saved_searches(self):
        lines = [line("a", kind="saved_search", saved_search_id="s1", product_key="model:kia-ev6"),
                 line("b", kind="saved_search", saved_search_id="s2", product_key="model:kia-ev6"),
                 line("c", kind="saved_search", saved_search_id="s3", product_key="model:kia-niro")]
        self.assertEqual([v["line_id"] for v in wc.r10(ctx(lines))], ["b"])


class Report(unittest.TestCase):
    def test_counts_and_example_cap(self):
        lines = [line(f"a{i}", make="Nissan", format="system", product_key=f"broad:nissan-any-systems-{i}") for i in range(30)]
        c = ctx(lines)
        results = wc.check(c)
        summary = wc.summarise(c, results)
        self.assertEqual(summary["counts"]["R5"], 30)
        self.assertEqual(len(summary["examples"]["R5"]), 20)
        self.assertIn("| R5 | 30 |", wc.render_markdown(c, results))

    def test_findings_records_list_every_hit_with_stable_keys(self):
        lines = [line(f"a{i}", make="Nissan", format="system", product_key=f"broad:nissan-any-systems-{i}") for i in range(30)]
        records = wc.finding_records(wc.check(ctx(lines)))
        r5 = [r for r in records if r["rule"] == "R5"]
        self.assertEqual(len(r5), 30)
        self.assertEqual(len({r["key"] for r in r5}), 30)
        self.assertEqual(records, wc.finding_records(wc.check(ctx(lines))))


if __name__ == "__main__":
    unittest.main()
