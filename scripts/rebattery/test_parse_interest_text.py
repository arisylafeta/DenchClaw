"""The free-text wants parser: validation and grounding on synthetic text, then the database path on the disposable CRM.

The model is always a stub here. Set BULK_TRADES_TEST_DATABASE_URL (scripts/rebattery/crm-test-db.sh up prints the URL)
for the database tests; they are skipped otherwise.
"""
import contextlib
import importlib.util
import io
import json
import os
import tempfile
import unittest
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
DSN = os.environ.get("BULK_TRADES_TEST_DATABASE_URL")


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def product(**over):
    base = {key: None for key in ("make", "model", "platform", "part_number", "format", "chemistry", "kwh_min", "kwh_max",
                                  "cell_format", "quantity", "quantity_unit", "cadence", "price", "price_max",
                                  "price_currency", "price_unit", "quote")}
    base["status"] = "asked"
    base.update(over)
    return base


class Validation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.p = load("parse_interest_text")

    def reject(self, raw, text, reason):
        with self.assertRaises(self.p.Rejected) as caught:
            self.p.validate_product(raw, text)
        self.assertEqual(caught.exception.reason, reason)

    def test_a_grounded_product_is_kept(self):
        text = "Nissan Leaf 40kWh packs, 12 packs a month at EUR 45 per kWh"
        kept = self.p.validate_product(product(make="Nissan", model="Leaf", format="pack", kwh_min=40, kwh_max=40, quantity=12,
                                               quantity_unit="packs", cadence="monthly", price=45, price_currency="EUR",
                                               price_unit="kWh", quote="Nissan Leaf 40kWh packs"), text)
        self.assertEqual((kept["make"], kept["kwh_min"], kept["quantity_unit"], kept["price_currency"]), ("Nissan", 40.0, "packs", "EUR"))

    def test_a_flexible_price_is_kept_beside_the_target_and_stays_a_target(self):
        text = "Prismatic cells; target landing cost under $30/kWh with flexibility up to $50/kWh"
        raw = product(format="cell", price=30, price_max=50, price_currency="USD", price_unit="kWh", quote="target landing cost under $30/kWh")
        kept = self.p.validate_product(raw, text)
        self.assertEqual((kept["price"], kept["price_max"], kept["price_currency"], kept["price_unit"]), (30.0, 50.0, "USD", "kWh"))
        self.reject({**raw, "price_max": 75}, text, "ungrounded:price_max")

    def test_a_flexible_figure_needs_a_lower_target_beside_it(self):
        text = "cells at $30/kWh, up to $50/kWh"
        base = dict(format="cell", price_currency="USD", price_unit="kWh", quote="cells at $30/kWh")
        self.assertIsNone(self.p.validate_product(product(price=30, price_max=30, **base), text)["price_max"])
        self.assertIsNone(self.p.validate_product(product(price=50, price_max=30, **base), text)["price_max"])
        self.assertIsNone(self.p.validate_product(product(price=None, price_max=50, **base), text)["price_max"])

    def test_an_answer_cached_before_price_max_existed_still_validates(self):
        raw = product(make="Tesla", quote="Tesla packs")
        del raw["price_max"]
        self.assertIsNone(self.p.validate_product(raw, "Tesla packs")["price_max"])

    def test_shape_is_strict(self):
        text = "Tesla packs"
        self.reject({**product(make="Tesla", quote="Tesla packs"), "colour": "red"}, text, "unknown_field:colour")
        raw = product(make="Tesla", quote="Tesla packs")
        del raw["price"]
        self.reject(raw, text, "missing_field:price")
        self.reject(product(make="Tesla", quote="Tesla packs", format="battery"), text, "bad_value:format")
        self.reject(product(make="Tesla", quote="Tesla packs", status="maybe"), text, "bad_value:status")
        self.reject(product(make="Tesla", quote="Tesla packs", kwh_min="40"), text, "bad_type:kwh_min")
        self.reject(product(make="Tesla", quote="Tesla packs", kwh_min=60, kwh_max=40), text, "bad_value:kwh_range")
        self.reject(product(make="Tesla"), text, "no_quote")
        self.reject(product(quote="Tesla packs"), text, "no_product_facts")
        self.reject("Tesla", text, "not_an_object")

    def test_kwh_is_never_invented(self):
        self.reject(product(make="Nissan", model="Leaf", kwh_min=62, kwh_max=62, quote="Nissan Leaf packs"),
                    "Nissan Leaf packs for storage", "ungrounded:kwh_min")

    def test_a_date_is_not_a_kwh_figure(self):
        self.reject(product(make="Audi", kwh_min=2026, kwh_max=2026, quote="Audi packs (asked 2026-10-07)"),
                    "Audi packs (asked 2026-10-07)", "ungrounded:kwh_min")
        self.reject(product(make="Audi", kwh_min=10, kwh_max=10, quote="Audi packs (asked 2026-10-07)"),
                    "Audi packs (asked 2026-10-07)", "ungrounded:kwh_min")

    def test_mwh_is_read_as_kwh(self):
        kept = self.p.validate_product(product(format="system", kwh_min=1260, kwh_max=1260, quote="BESS (1.26 MWh each)"),
                                       "2 BYD containerised BESS (1.26 MWh each)")
        self.assertEqual(kept["kwh_min"], 1260.0)

    def test_a_make_the_text_does_not_name_is_rejected(self):
        self.reject(product(make="Ford", model="Transit", quote="Transit 40kWh"), "Transit 40kWh packs", "ungrounded:make")

    def test_a_model_that_belongs_to_one_maker_implies_the_make(self):
        kept = self.p.validate_product(product(make="Nissan", model="Leaf", quote="Used Leaf packs"), "Used Leaf packs for reuse")
        self.assertEqual(kept["make"], "Nissan")
        self.reject(product(make="Toyota", model="Leaf", quote="Used Leaf packs"), "Used Leaf packs for reuse", "ungrounded:make")
        self.reject(product(make="Ford", model="Transit", quote="Transit packs"), "Transit packs", "ungrounded:make")

    def test_slash_shorthand_models_and_european_thousands(self):
        kept = self.p.validate_product(product(make="Tesla", model="Model X", quote="Tesla S/X modules"), "Used Tesla S/X modules for repair")
        self.assertEqual(kept["model"], "Model X")
        self.reject(product(make="Tesla", model="Model 3", quote="Tesla S/X modules"), "Used Tesla S/X modules for repair", "ungrounded:model")
        kept = self.p.validate_product(product(format="cell", quantity=10000, quantity_unit="cells", quote="10.000 single cell"), "10.000 single cell 18650")
        self.assertEqual(kept["quantity"], 10000.0)
        self.reject(product(format="pack", kwh_min=774, kwh_max=774, quote="77.4 kWh packs"), "77.4 kWh packs", "ungrounded:kwh_min")

    def test_a_note_without_a_status_defaults_to_asked(self):
        raw = product(make="Tesla", quote="Tesla packs")
        raw["status"] = None
        self.assertEqual(self.p.validate_product(raw, "Tesla packs")["status"], "asked")

    def test_slash_shorthand_part_numbers_are_read_out(self):
        text = "Ioniq 5 37501-GI300/GI301/GI351; Kia EV6 37501-CV051/CV151"
        for part in ("37501-GI301", "37501GI351", "37501-CV151"):
            self.assertEqual(self.p.validate_product(product(part_number=part, quote="Ioniq 5 37501-GI300"), text)["part_number"], part)
        self.reject(product(part_number="37501-GI999", quote="Ioniq 5 37501-GI300"), text, "ungrounded:part_number")

    def test_make_aliases_and_lists(self):
        self.assertTrue(self.p.make_grounded("Volkswagen", "VW ID.3 packs"))
        self.assertTrue(self.p.make_grounded("BMW / Volvo", "BMW and Volvo modules"))
        self.assertFalse(self.p.make_grounded("BMW / Volvo", "BMW modules"))
        self.assertFalse(self.p.make_grounded("MG", "damaged cells"))  # short makes need a whole word

    def test_model_and_part_number_must_be_in_the_text(self):
        self.reject(product(make="Renault", model="Zoe", quote="Renault packs"), "Renault packs", "ungrounded:model")
        self.reject(product(part_number="SU001B5189", quote="packs"), "Tesla packs", "ungrounded:part_number")
        kept = self.p.validate_product(product(part_number="37501-AO050", quote="part 37501AO050"), "part 37501AO050")
        self.assertEqual(kept["part_number"], "37501-AO050")  # separators and the letter O do not matter

    def test_chemistry_and_format_must_be_in_or_implied_by_the_text(self):
        self.reject(product(chemistry="LFP", quote="storage packs"), "storage packs", "ungrounded:chemistry")
        self.reject(product(format="cell", quote="storage packs"), "storage packs", "ungrounded:format")
        for text, chemistry in (("lithium iron phosphate packs", "LFP"), ("NCM modules", "NMC")):
            self.assertEqual(self.p.validate_product(product(chemistry=chemistry, quote=text), text)["chemistry"], chemistry)
        kept = self.p.validate_product(product(format="system", quote="BYD Containerised"), "All listings\nBYD Containerised")
        self.assertEqual(kept["format"], "system")

    def test_quantity_price_and_cadence_are_grounded(self):
        text = "we take four packs monthly"
        kept = self.p.validate_product(product(format="pack", quantity=4, quantity_unit="pack", cadence="monthly", quote="four packs monthly"), text)
        self.assertEqual((kept["quantity"], kept["quantity_unit"]), (4.0, "packs"))
        self.reject(product(format="pack", quantity=40, quote="four packs monthly"), text, "ungrounded:quantity")
        self.reject(product(format="pack", cadence="weekly", quote="four packs monthly"), text, "ungrounded:cadence")
        self.reject(product(format="pack", price=45, quote="four packs monthly"), text, "ungrounded:price")
        self.reject(product(format="pack", price=45, price_currency="GBP", quote="packs at 45 EUR"), "packs at 45 EUR", "ungrounded:price_currency")
        self.reject(product(format="pack", price=45, price_unit="cell", quote="packs at 45 EUR per kWh"),
                    "packs at 45 EUR per kWh", "ungrounded:price_unit")

    def test_the_quote_must_be_the_texts_own_words(self):
        self.reject(product(make="Tesla", quote="Tesla battery packs"), "Tesla packs", "quote_not_in_text")
        kept = self.p.validate_product(product(make="Tesla", quote="tesla   packs"), "We want Tesla\npacks")
        self.assertEqual(kept["make"], "Tesla")  # case and spacing are not compared

    def test_response_handling(self):
        batch = {"n1": "Tesla packs", "n2": "no idea", "n3": "BMW modules"}
        answer = {"results": [
            {"id": "n1", "products": [product(make="Tesla", format="pack", quote="Tesla packs"),
                                      product(make="Tesla", format="pack", quote="Tesla packs"),  # duplicate
                                      product(make="Ford", quote="Tesla packs")]},
            {"id": "n2", "products": []},
            {"id": "ghost", "products": [product(make="BMW", quote="BMW modules")]}]}  # not a batch id: never guessed into n3
        out = self.p.validate_response(answer, batch)
        self.assertEqual(out["n1"]["status"], "parsed")
        self.assertEqual(len(out["n1"]["products"]), 1)
        self.assertEqual(out["n1"]["rejected"][0][1], "ungrounded:make")
        self.assertEqual(out["n2"]["status"], "no_products")
        self.assertEqual(out["n3"]["status"], "missing")
        with self.assertRaises(ValueError):
            self.p.validate_response({"products": []}, batch)

    def test_every_product_rejected_is_its_own_status(self):
        out = self.p.validate_response({"results": [{"id": "n1", "products": [product(make="Ford", quote="Tesla packs")]}]},
                                       {"n1": "Tesla packs"})
        self.assertEqual(out["n1"]["status"], "rejected")


class Selection(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.p = load("parse_interest_text")

    def test_text_the_spec_already_holds_is_not_sent(self):
        spec = {"makes": ["Tesla"], "chemistries": ["NMC"], "formats": ["Modules", "Packs"]}
        self.assertFalse(self.p.needs_parse("Tesla modules and packs.", spec))
        self.assertFalse(self.p.needs_parse("Used EV packs and modules (NMC) to test and redeploy as stationary storage.", {"chemistries": ["NMC"]}))
        self.assertFalse(self.p.needs_parse("LFP packs", {}))
        self.assertFalse(self.p.needs_parse("Packs/modules for occasional conversions.", {}))

    def test_a_figure_or_a_name_the_spec_lacks_is_sent(self):
        self.assertTrue(self.p.needs_parse("Nissan Leaf 40kWh batteries", {"makes": ["Nissan"]}))
        self.assertTrue(self.p.needs_parse("Hyundai kona", {"formats": ["Modules"]}))
        self.assertTrue(self.p.needs_parse("\"1104429-00-P\" · Tesla", {"makes": ["Tesla"]}))
        self.assertTrue(self.p.needs_parse("Cylindrical NMC cells and BMS parts for rebuilds, Molicel P42A", {}))

    def test_dates_alone_do_not_count(self):
        self.assertFalse(self.p.needs_parse("packs (said interested 2026-10-07)", {"formats": ["Packs"]}))

    def test_a_make_list_becomes_one_fact_set_per_make(self):
        sets = self.p.fact_sets(product(make="BMW / Volvo", format="module", kwh_min=30, kwh_max=30, quote="x"))
        self.assertEqual([s["sql"]["make"] for s in sets], ["BMW", "Volvo"])
        self.assertEqual(sets[0]["sql"]["kwh"], 30)
        self.assertEqual(sets[0]["ts"]["kwhMin"], 30)

    def test_a_platform_is_the_model_only_when_there_is_none(self):
        only = self.p.fact_sets(product(platform="MEB", format="pack", quote="x"))[0]
        self.assertEqual(only["sql"]["model"], "MEB")
        both = self.p.fact_sets(product(make="Audi", model="Q4", platform="MEB", quote="x"))[0]
        self.assertEqual((both["sql"]["model"], both["platform_unused"]), ("Q4", "MEB"))

    def test_a_cell_names_its_maker(self):
        fact = self.p.fact_sets(product(make="Molicel", model="P42A", format="cell", quote="x"))[0]
        self.assertEqual(fact["sql"]["cell_maker"], "Molicel")

    def test_a_vehicle_make_is_not_a_cell_maker(self):
        fact = self.p.fact_sets(product(make="Nissan", model="Leaf", format="cell", quote="x"))[0]
        self.assertNotIn("cell_maker", fact["sql"])
        self.assertNotIn("cellMaker", fact["ts"])


class Keys(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.p = load("parse_interest_text")

    def keys(self, *levels):
        return [{"key": f"{level}:x", "level": level} for level in levels]

    def chain(self, make, model, kwh=None):
        """The keys the app's builder lists for a make and model, most specific first, in their real shapes."""
        stem = f"{make.lower()}-{model.lower().replace(' ', '')}"
        keys = ([{"key": f"pack:{stem}-{kwh}kwh", "level": "pack"}, {"key": f"model:{stem}-{kwh}kwh", "level": "model"}] if kwh else [])
        return keys + [{"key": f"model:{stem}", "level": "model"}, {"key": f"broad:{make.lower()}-any-packs", "level": "broad"},
                       {"key": "broad:any-packs", "level": "broad"}]

    def test_a_pack_family_needs_a_stated_capacity_or_a_part(self):
        keys = self.chain("Renault", "Zoe", 52)
        pick = lambda facts: self.p.pick_key(keys, {"ts": facts})["key"]  # noqa: E731
        self.assertEqual(pick({"make": "Renault", "model": "Zoe", "kwh": 52}), "pack:renault-zoe-52kwh")
        # no kWh: no guess at a capacity or a pack family, but the model itself is stated
        self.assertEqual(pick({"make": "Renault", "model": "Zoe"}), "model:renault-zoe")
        self.assertEqual(self.p.pick_key(self.keys("part", "broad"), {"ts": {"partNumbers": ["X"]}})["level"], "part")
        # a module's 5.3 kWh is not a pack's capacity: the model-level key still is the model
        self.assertEqual(pick({"make": "Tesla", "model": "Model S", "kwh": 5.3, "format": "module"}), "model:renault-zoe")
        # cells have no pack family and no model-level key: their maker and model make the key
        self.assertEqual(self.p.pick_key(self.keys("model", "broad"), {"ts": {"make": "Nissan", "model": "Leaf", "format": "cell", "cellMaker": "Nissan"}})["level"], "broad")
        self.assertEqual(self.p.pick_key(self.keys("cell", "broad"), {"ts": {"make": "Molicel", "model": "P42A", "format": "cell", "cellMaker": "Molicel"}})["level"], "cell")

    def test_a_model_with_no_kwh_is_a_model_level_line_and_a_bare_make_is_not(self):
        keys = [{"key": "model:kia-ev3", "level": "model"}, {"key": "broad:kia-any-packs", "level": "broad"}]
        self.assertEqual(self.p.pick_key(keys, {"ts": {"make": "Kia", "model": "EV3"}})["key"], "model:kia-ev3")
        self.assertEqual(self.p.pick_key(keys, {"ts": {"make": "Kia", "model": "EV3", "kwhMin": 60, "kwhMax": 80}})["key"], "model:kia-ev3")
        self.assertEqual(self.p.pick_key(keys[1:], {"ts": {"make": "Kia"}})["key"], "broad:kia-any-packs")
        # a kWh-keyed model is only taken when the text states one figure on a pack
        sized = [{"key": "model:kia-ev3-58kwh", "level": "model"}, {"key": "broad:kia-any-packs", "level": "broad"}]
        self.assertEqual(self.p.pick_key(sized, {"ts": {"make": "Kia", "model": "EV3", "kwh": 58, "format": "module"}})["level"], "broad")

    def test_a_model_names_its_maker_only_when_the_model_belongs_to_one(self):
        self.assertEqual(self.p.implied_make("Leaf"), "Nissan")
        self.assertEqual(self.p.implied_make("Bolt EV"), "Chevrolet")
        self.assertIsNone(self.p.implied_make("Bolt"))
        sets = self.p.fact_sets(product(model="Leaf", format="pack", quote="x"))
        self.assertEqual(sets[0]["ts"]["make"], "Nissan")
        self.assertNotIn("make", self.p.fact_sets(product(model="Bolt", format="pack", quote="x"))[0]["ts"])

    def test_a_note_that_only_guesses_a_role_or_buys_new_only_states_no_want(self):
        n = self.p.not_a_want
        self.assertEqual(n("Likely trader/competitor: sources and resells used Leaf packs; could be a supplier or buyer of modules."), "role_guess")
        self.assertEqual(n("Summary: Likely trader/competitor: resells Leaf packs.\nNote: Estimated from web research; not confirmed by the buyer."), "role_guess")
        self.assertEqual(n("Premium new cylindrical cells (Molicel P42A); little fit for used EV modules except possibly cell-level reuse."), "new_only")
        self.assertEqual(n("Small cylindrical cells only; poor fit."), "new_only")
        self.assertEqual(n("Note: Only unused, non-repurposed products; not second-life or dismantled modules."), "new_only")
        # new or surplus stock they ask for is still a want unless the note says new only
        self.assertIsNone(n("Summary: EVE LF100MA Prismatic Cells LFP 100 Ah, New Surplus"))
        self.assertIsNone(n("Summary: Bid on CALB cells: brand-new cells stored since 2022."))
        # a real want with a side remark, and the research boilerplate, are still wants
        self.assertIsNone(n("Salvaged/used NMC modules and packs from Volt, Leaf, i3 for resale. Could be a volume outlet for tested second-life modules."))
        self.assertIsNone(n("Summary: Donor modules/packs for Tesla and Bolt HV battery service.\nNote: Estimated from web research; not confirmed by the buyer. Ask on first contact."))
        self.assertIsNone(n("Used Tesla/Bolt/Leaf modules and packs; both trader and buyer."))

    def test_a_broad_line_must_add_something(self):
        line = {"level": "broad", "kwh_min": None, "kwh_max": None, "model": None, "raw_product": None}
        plain = product(format="pack", chemistry="LFP", quote="LFP packs")
        self.assertFalse(self.p.adds_information(line, plain))
        self.assertTrue(self.p.adds_information({**line, "kwh_min": 55}, plain))
        self.assertTrue(self.p.adds_information({**line, "model": "Leaf"}, plain))
        self.assertTrue(self.p.adds_information(line, {**plain, "quantity": 4.0}))
        self.assertTrue(self.p.adds_information({**line, "level": "model"}, plain))


class Runner(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.p = load("parse_interest_text")

    def answer(self, batch):
        return json.dumps({"results": [{"id": i, "products": [product(make="Tesla", quote="Tesla packs")]} for i in batch]})

    def test_a_raw_answer_is_cached_and_not_asked_twice(self):
        calls = []

        def caller(system, user, key):
            calls.append(user)
            return "```json\n" + self.answer({"n1": 1}) + "\n```"

        with tempfile.TemporaryDirectory() as folder:
            first = self.p.ModelRunner(folder, caller=caller, key="k")
            out, reason = first.run({"n1": "Tesla packs"})
            self.assertEqual((out["n1"]["status"], reason), ("parsed", None))
            second = self.p.ModelRunner(folder, caller=caller, key="k")
            self.assertEqual(second.run({"n1": "Tesla packs"})[0]["n1"]["status"], "parsed")
            self.assertEqual((first.calls, second.calls, second.cache_hits, len(calls)), (1, 0, 1, 1))
            self.assertEqual(len(list(Path(folder).glob("*.json"))), 2)  # the raw reply and the per-text answer

    def test_a_rerun_with_a_different_batch_asks_only_for_the_new_text(self):
        calls = []

        def caller(system, user, key):
            calls.append(json.loads(user)["notes"])
            return self.answer({note["id"]: 1 for note in json.loads(user)["notes"]})

        with tempfile.TemporaryDirectory() as folder:
            self.p.ModelRunner(folder, caller=caller, key="k").run({"n1": "Tesla packs", "n2": "Tesla modules"})
            again = self.p.ModelRunner(folder, caller=caller, key="k")
            out, _ = again.run({"n1": "Tesla modules", "n2": "Tesla cells"})  # the batch changed shape
            self.assertEqual([n["text"] for n in calls[-1]], ["Tesla cells"])
            self.assertEqual((again.calls, again.cache_hits, sorted(out)), (1, 1, ["n1", "n2"]))

    def test_a_cached_answer_is_validated_again(self):
        with tempfile.TemporaryDirectory() as folder:
            self.p.ModelRunner(folder, caller=lambda s, u, k: self.answer({"n1": 1}), key="k").run({"n1": "Tesla packs"})
            out, _ = self.p.ModelRunner(folder, cache_only=True, key="k").run({"n1": "Ford packs"})
            self.assertIsNone(out["n1"])  # a different text is not answered by the other's cache
            out, _ = self.p.ModelRunner(folder, cache_only=True, key="k").run({"n1": "Tesla packs"})
            self.assertEqual(out["n1"]["products"][0]["make"], "Tesla")

    def test_a_malformed_answer_is_retried_then_left_unparsed(self):
        with tempfile.TemporaryDirectory() as folder:
            runner = self.p.ModelRunner(folder, caller=lambda s, u, k: "sorry, no", key="k", retries=1)
            out, reason = runner.run({"n1": "Tesla packs"})
            self.assertEqual(out, {"n1": None})
            self.assertEqual(runner.calls, 2)
            self.assertTrue(reason.startswith("bad_answer"))
            self.assertEqual(list(Path(folder).glob("*.json")), [])  # nothing bad is cached

    def test_a_gateway_error_is_a_failure_not_a_crash(self):
        def boom(system, user, key):
            raise OSError("gateway down")

        with tempfile.TemporaryDirectory() as folder:
            runner = self.p.ModelRunner(folder, caller=boom, key="k", retries=0)
            out, reason = runner.run({"n1": "Tesla packs"})
            self.assertEqual((out, reason), ({"n1": None}, "model_error:OSError"))

    def test_cache_only_makes_no_call(self):
        with tempfile.TemporaryDirectory() as folder:
            runner = self.p.ModelRunner(folder, caller=lambda *a: self.fail("called"), key="k", cache_only=True)
            out, reason = runner.run({"n1": "Tesla packs"})
            self.assertEqual((out, runner.calls, reason), ({"n1": None}, 0, "not_cached"))

    def test_the_prompt_asks_for_json_only_and_no_tools(self):
        self.assertIn("ONLY a JSON object", self.p.SYSTEM_PROMPT)
        self.assertIn("no tools", self.p.SYSTEM_PROMPT)


class Sample(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.p = load("parse_interest_text")

    def sources(self, n):
        return [{"id": f"wants:c{i}", "company": f"Buyer {i}", "company_id": f"c{i}", "kind": "wants", "date": "2026-10-07",
                 "line_kind": "interest", "text": f"Tesla packs {i}", "lines": [],
                 "result": {"products": [product(make="Tesla", quote="Tesla packs")], "rejected": []}} for i in range(n)]

    def test_ten_percent_is_drawn_at_random_and_repeatably(self):
        sources = self.sources(50)
        chosen = self.p.sample_sources(sources, 10, seed=3)
        self.assertEqual(len(chosen), 5)
        self.assertEqual([s["id"] for s in chosen], [s["id"] for s in self.p.sample_sources(sources, 10, seed=3)])
        self.assertNotEqual([s["id"] for s in chosen], [s["id"] for s in sources[:5]])
        self.assertEqual(len(self.p.sample_sources(self.sources(3), 10)), 1)  # a small run still gets one

    def test_the_sheet_shows_the_original_text_beside_the_lines(self):
        sources = self.sources(1)
        sources[0]["lines"] = [{"key": "broad:tesla-any-packs", "kind": "interest", "level": "broad", "outcome": "added",
                                "product": sources[0]["result"]["products"][0]}]
        sheet = self.p.sample_sheet(sources, 100, "run1")
        self.assertIn("> Tesla packs 0", sheet)
        self.assertIn("`broad:tesla-any-packs`", sheet)
        self.assertIn("Alex: yes / no", sheet)


class Guards(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.p = load("parse_interest_text")

    def test_apply_needs_an_explicit_dsn(self):
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            self.p.main(["--apply"])

    def test_production_is_refused_before_connecting(self):
        for argv in (["--dsn", "host=/var/run/postgresql dbname=denchclaw"], ["--apply", "--dsn", "dbname=denchclaw"]):
            err = io.StringIO()
            with self.assertRaises(SystemExit) as raised, contextlib.redirect_stderr(err):
                self.p.main(argv)
            self.assertEqual(raised.exception.code, 2)
            self.assertIn("--i-have-approval", err.getvalue())


@unittest.skipUnless(DSN, "needs the disposable CRM database (BULK_TRADES_TEST_DATABASE_URL)")
class ConnectionGuard(unittest.TestCase):
    def test_a_database_named_denchclaw_is_refused_on_any_host(self):
        p = load("parse_interest_text")
        out, err = io.StringIO(), io.StringIO()
        with self.assertRaises(SystemExit) as raised, contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            p.main(["--apply", "--dsn", DSN, "--cache-only"])
        self.assertEqual(raised.exception.code, 2)
        self.assertIn("--i-have-approval", err.getvalue())
        self.assertNotIn("sources", out.getvalue())


@unittest.skipUnless(DSN, "needs the disposable CRM database (BULK_TRADES_TEST_DATABASE_URL)")
class Database(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import psycopg2
        import psycopg2.extras
        cls.p = load("parse_interest_text")
        cls.conn = psycopg2.connect(DSN)
        cls.conn.autocommit = False
        cls.tag = uuid.uuid4().hex[:8]
        cls.companies = [f"co_parse_{cls.tag}_{n}" for n in range(6)]

    @classmethod
    def tearDownClass(cls):
        with cls.conn.cursor() as cur:
            cur.execute("delete from buyer_interest where company_id = any(%s)", (cls.companies,))
            cur.execute("delete from buyer_interest_sync_errors where source_id = any(%s)", (cls.companies,))
            cur.execute("delete from crm_bulk_listings where company_id = any(%s)", (cls.companies,))
            cur.execute("delete from crm_buyer_profile_changes where company_id = any(%s)", (cls.companies,))
            cur.execute("set local crm.dossier_write = 'on'")
            cur.execute("delete from crm_companies where id = any(%s)", (cls.companies,))
        cls.conn.commit()
        cls.conn.close()

    def setUp(self):
        self.conn.rollback()
        with self.cur() as cur:
            cur.execute("delete from buyer_interest where company_id = any(%s)", (self.companies,))
            cur.execute("delete from crm_bulk_listings where company_id = any(%s)", (self.companies,))
            cur.execute("delete from crm_buyer_profile_changes where company_id = any(%s)", (self.companies,))
            cur.execute("set local crm.dossier_write = 'on'")
            cur.execute("delete from crm_companies where id = any(%s)", (self.companies,))
            for i, company in enumerate(self.companies):
                cur.execute("insert into crm_companies (id, name) values (%s, %s)", (company, f"Parse Test Buyer {i}"))
        self.conn.commit()
        self.dir = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.dir.cleanup()

    def cur(self):
        import psycopg2.extras
        return self.conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # --- fixtures ------------------------------------------------------------
    def wants(self, company, text, basis="stated", *, change_on=None, profile=None, dossier=None):
        with self.cur() as cur:
            cur.execute("set local crm.dossier_write = 'on'")
            cur.execute("""update crm_companies set buyer_profile = %s::jsonb, buyer_profile_basis = %s,
                             buyer_profiled_at = '2026-11-01', buyer_dossier = %s where id = %s""",
                        (json.dumps({"wants": text, **(profile or {})}), basis, dossier, company))
            # A trigger logs the fixture write itself; the test decides which change dates exist.
            cur.execute("delete from crm_buyer_profile_changes where company_id = %s", (company,))
            if change_on:
                cur.execute("""insert into crm_buyer_profile_changes (company_id, field, new_value, changed_at)
                               values (%s, 'buyer_profile', %s::jsonb, %s::date)""",
                            (company, json.dumps({"wants": text}), change_on))
        self.conn.commit()

    def demand(self, company, summary, *, closed_reason="moved_to_profile", observed_on="2026-09-23", spec=None, source_kind="email"):
        row_id = f"btd_parse_{uuid.uuid4().hex[:12]}"
        with self.cur() as cur:
            cur.execute("""insert into crm_bulk_listings (id, kind, party, summary, status, closed_reason, company_id, spec, context,
                             observed_on, source_kind, source_id)
                           values (%s, 'demand', 'Parse Test Buyer', %s, 'closed', %s, %s, %s::jsonb, '{}'::jsonb, %s::date, %s, %s)""",
                        (row_id, summary, closed_reason, company, json.dumps(spec or {}), observed_on, source_kind,
                         f"src:{self.tag}:{row_id}"))
            cur.execute("delete from buyer_interest where demand_id = %s", (row_id,))  # the trigger's own line is not the subject
        self.conn.commit()
        return row_id

    def stub(self, mapping, calls=None):
        """A model that answers from {text fragment: [products]}."""
        def caller(system, user, key):
            if calls is not None:
                calls.append(user)
            notes = json.loads(user)["notes"]
            results = []
            for note in notes:
                found = []
                for fragment, products in mapping.items():
                    if fragment in note["text"]:
                        found = products
                results.append({"id": note["id"], "products": found})
            return json.dumps({"results": results})
        return caller

    def parse(self, mapping, *, apply_writes=True, builder="sql", companies=None, calls=None, run_id="r1", batch_size=100):
        runner = self.p.ModelRunner(self.dir.name, caller=self.stub(mapping, calls), key="k")
        report, sources = self.p.run(self.conn, runner, run_id=run_id, apply_writes=apply_writes, builder=builder,
                                     workers=1, only_companies=companies or self.companies, batch_size=batch_size)
        return report, sources

    def lines(self, company, kind=None):
        with self.cur() as cur:
            cur.execute("select * from buyer_interest where company_id = %s and (%s::text is null or kind = %s) order by product_key",
                        (company, kind, kind))
            return cur.fetchall()

    # --- tests ---------------------------------------------------------------
    def test_a_wants_text_becomes_a_dated_line_with_both_refs(self):
        company = self.companies[0]
        self.wants(company, "Nissan Leaf 40kWh batteries", "stated", change_on="2026-10-01", profile={"makes": ["Nissan"]})
        report, _ = self.parse({"Leaf": [product(make="Nissan", model="Leaf", kwh_min=40, kwh_max=40, quote="Nissan Leaf 40kWh batteries")]})
        line = self.lines(company)[0]
        self.assertEqual(line["product_key"], "model:nissan-leaf-40kwh")
        self.assertEqual((line["kind"], line["ownership"], line["product_key_level"]), ("interest", "mastered", "model"))
        self.assertEqual((str(line["first_seen"]), str(line["last_seen"]), str(line["expires_on"])), ("2026-10-01", "2026-10-01", "2027-03-30"))
        self.assertEqual(sorted(line["source_refs"])[1], "parse:r1")
        self.assertTrue(line["source_refs"][0].startswith("crm:buyer_profile_change:") or "crm:buyer_profile_change:" in "".join(line["source_refs"]))
        self.assertEqual(report["lines"]["added"], {"interest:model": 1})
        self.assertEqual(report["companies_gaining_specific"], 1)

    def test_researched_text_is_inferred_and_dated_from_the_profile_when_no_change_is_logged(self):
        company = self.companies[1]
        self.wants(company, "Used Transit packs of 60 kWh for storage projects.", "researched")
        self.parse({"Transit": [product(make="Ford", model="Transit", format="pack", quote="Transit packs")]})  # Ford is not in the text
        self.assertEqual(self.lines(company), [])
        self.dir = tempfile.TemporaryDirectory()  # the first answer is cached; ask again
        self.parse({"Transit": [product(model="Transit", format="pack", kwh_min=60, kwh_max=60, quote="Transit packs of 60 kWh")]}, run_id="r2")
        line = self.lines(company)[0]
        self.assertEqual((line["kind"], str(line["first_seen"])), ("inferred", "2026-11-01"))

    def test_a_closed_ask_keeps_its_own_date_and_kind(self):
        company = self.companies[2]
        stated = self.demand(company, "Nissan Leaf 40kWh batteries", observed_on="2026-09-23", spec={"makes": ["Nissan"], "basis": "stated"})
        research = self.demand(company, "Tesla Model 3 modules", closed_reason="research_profile", observed_on="2026-10-01",
                               spec={"makes": ["Tesla"], "basis": "estimated"}, source_kind="research")
        self.parse({"Leaf": [product(make="Nissan", model="Leaf", kwh_min=40, kwh_max=40, quote="Nissan Leaf 40kWh")],
                    "Model 3": [product(make="Tesla", model="Model 3", format="module", quote="Tesla Model 3 modules")]})
        by_key = {line["product_key"]: line for line in self.lines(company)}
        leaf, tesla = by_key["model:nissan-leaf-40kwh"], by_key["model:tesla-model3"]
        self.assertEqual((leaf["kind"], str(leaf["first_seen"]), leaf["source_refs"][0]), ("interest", "2026-09-23", f"crm:{stated}"))
        self.assertEqual((tesla["kind"], str(tesla["first_seen"])), ("inferred", "2026-10-01"))
        self.assertIn(f"crm:{research}", tesla["source_refs"])

    def test_quantity_and_price_are_kept_on_the_line(self):
        company = self.companies[3]
        self.demand(company, "12 Renault Zoe 41 kWh packs at EUR 40 per kWh", spec={"makes": ["Renault"]})
        self.parse({"Zoe": [product(make="Renault", model="Zoe", format="pack", kwh_min=41, kwh_max=41, quantity=12, quantity_unit="packs",
                                    price=40, price_currency="EUR", price_unit="kWh", quote="12 Renault Zoe 41 kWh packs")]})
        line = self.lines(company)[0]
        self.assertEqual((float(line["quantity"]), line["quantity_unit"], line["quantity_basis"]), (12.0, "packs", "stated"))
        self.assertEqual((float(line["price"]), line["price_currency"], line["price_unit"], line["price_basis"]), (40.0, "EUR", "kWh", "target"))

    def test_rerunning_adds_nothing_and_asks_no_model(self):
        company = self.companies[0]
        self.wants(company, "Nissan Leaf 40kWh batteries", "stated", change_on="2026-10-01")
        mapping = {"Leaf": [product(make="Nissan", model="Leaf", kwh_min=40, kwh_max=40, quote="Nissan Leaf 40kWh")]}
        self.parse(mapping)
        with self.cur() as cur:
            cur.execute("select id, updated_at, source_refs from buyer_interest where company_id = %s", (company,))
            before = cur.fetchall()
        self.conn.commit()
        calls = []
        report, _ = self.parse(mapping, run_id="r2", calls=calls)
        with self.cur() as cur:
            cur.execute("select id, updated_at, source_refs from buyer_interest where company_id = %s", (company,))
            after = cur.fetchall()
        self.conn.commit()
        self.assertEqual(before, after)
        self.assertEqual((report["lines"]["added_total"], report["skipped"], calls), (0, {"wants:already_parsed": 1}, []))

    def test_a_dry_run_writes_nothing_but_reports_the_lines(self):
        company = self.companies[0]
        self.wants(company, "Nissan Leaf 40kWh batteries", "stated", change_on="2026-10-01")
        report, _ = self.parse({"Leaf": [product(make="Nissan", model="Leaf", kwh_min=40, kwh_max=40, quote="Nissan Leaf 40kWh")]},
                               apply_writes=False)
        self.assertEqual(report["lines"]["added_total"], 1)
        self.assertEqual(self.lines(company), [])

    def test_the_broad_line_stays_and_a_line_by_another_writer_is_left_alone(self):
        company = self.companies[0]
        self.wants(company, "Nissan Leaf 40kWh batteries", "researched", change_on="2026-10-01")
        with self.cur() as cur:
            cur.execute("""insert into buyer_interest (id, company_id, kind, ownership, product_key, product_key_level, first_seen,
                             last_seen, quantity_basis, source_refs) values (%s, %s, 'inferred', 'mastered', 'broad:nissan-any-batteries',
                             'broad', '2026-10-20', '2026-10-20', 'not_stated', %s::text[]),
                             (%s, %s, 'inferred', 'mastered', 'model:nissan-leaf-40kwh', 'model', '2026-10-20', '2026-10-20',
                             'not_stated', %s::text[])""",
                        (f"bi_t_{self.tag}_a", company, ["crm:backfill"], f"bi_t_{self.tag}_b", company, ["crm:other"]))
        self.conn.commit()
        # Another writer already holds a model line: the company is "already specific" and is not parsed at all.
        report, _ = self.parse({"Leaf": [product(make="Nissan", model="Leaf", kwh_min=40, kwh_max=40, quote="Nissan Leaf 40kWh")]})
        self.assertEqual(report["skipped"], {"wants:already_specific": 1})
        with self.cur() as cur:
            cur.execute("delete from buyer_interest where id = %s", (f"bi_t_{self.tag}_b",))
        self.conn.commit()
        report, _ = self.parse({"Leaf": [product(make="Nissan", model="Leaf", kwh_min=40, kwh_max=40, quote="Nissan Leaf 40kWh")]}, run_id="r2")
        keys = sorted(line["product_key"] for line in self.lines(company))
        self.assertEqual(keys, ["broad:nissan-any-batteries", "model:nissan-leaf-40kwh"])
        broad = [line for line in self.lines(company) if line["product_key"].startswith("broad:")][0]
        self.assertEqual((str(broad["first_seen"]), broad["source_refs"]), ("2026-10-20", ["crm:backfill"]))

    def test_a_line_another_writer_made_on_the_same_key_is_not_touched(self):
        company = self.companies[0]
        row = self.demand(company, "Nissan Leaf 40kWh batteries", observed_on="2026-09-23", spec={"makes": ["Nissan"]})
        with self.cur() as cur:
            cur.execute("""insert into buyer_interest (id, company_id, kind, ownership, product_key, product_key_level, first_seen,
                             last_seen, quantity_basis, source_refs) values (%s, %s, 'interest', 'mastered', 'model:nissan-leaf-40kwh',
                             'model', '2026-10-20', '2026-10-20', 'not_stated', %s::text[])""", (f"bi_t_{self.tag}_c", company, ["crm:other"]))
        self.conn.commit()
        # The model line exists, but only from another writer: the wants side is skipped, the demand side meets it.
        report, _ = self.parse({"Leaf": [product(make="Nissan", model="Leaf", kwh_min=40, kwh_max=40, quote="Nissan Leaf 40kWh")]})
        self.assertEqual((report["lines"]["added_total"], report["lines"]["present"]), (0, 1))
        line = self.lines(company)[0]
        self.assertEqual((str(line["first_seen"]), line["source_refs"]), ("2026-10-20", ["crm:other"]))

    def test_two_sources_of_one_key_merge_dates_and_refs(self):
        company = self.companies[4]
        first = self.demand(company, "Nissan Leaf 40kWh batteries", observed_on="2026-09-23", spec={"makes": ["Nissan"]})
        second = self.demand(company, "Nissan Leaf 40kWh again", observed_on="2026-10-15", spec={"makes": ["Nissan"]})
        product_ = product(make="Nissan", model="Leaf", kwh_min=40, kwh_max=40, quote="Nissan Leaf 40kWh")
        report, _ = self.parse({"Leaf": [product_]})
        lines = self.lines(company)
        self.assertEqual(len(lines), 1)
        self.assertEqual((str(lines[0]["first_seen"]), str(lines[0]["last_seen"])), ("2026-09-23", "2026-10-15"))
        self.assertTrue({f"crm:{first}", f"crm:{second}", "parse:r1"} <= set(lines[0]["source_refs"]))
        self.assertEqual((report["lines"]["added_total"], report["lines"]["merged"]), (1, 1))

    def test_dossier_companies_are_not_parsed(self):
        company = self.companies[5]
        self.wants(company, "Nissan Leaf 40kWh batteries", "stated", change_on="2026-10-01", dossier="---\nversion: 1\n---\nbody")
        self.demand(company, "Nissan Leaf 40kWh batteries")
        calls = []
        report, _ = self.parse({"Leaf": [product(make="Nissan", model="Leaf", quote="Nissan Leaf 40kWh")]}, calls=calls)
        self.assertEqual((report["skipped"], calls, self.lines(company)), ({"wants:dossier_company": 1, "demand:dossier_company": 1}, [], []))

    def test_text_that_only_repeats_the_buy_box_is_not_sent(self):
        company = self.companies[0]
        self.wants(company, "Tesla modules and packs.", "researched", change_on="2026-10-01",
                   profile={"makes": ["Tesla"], "formats": ["Modules", "Packs"]})
        calls = []
        report, _ = self.parse({}, calls=calls)
        self.assertEqual((report["sent"], calls, report["skipped"]), (0, [], {"wants:no_new_product_words": 1}))

    def test_a_rejected_product_writes_nothing_and_is_counted_with_its_reason(self):
        company = self.companies[0]
        self.wants(company, "Nissan Leaf 62kWh batteries", "stated", change_on="2026-10-01")
        report, _ = self.parse({"Leaf": [product(make="Nissan", model="Leaf", kwh_min=64, kwh_max=64, quote="Nissan Leaf 62kWh")]})
        self.assertEqual(self.lines(company), [])
        self.assertEqual((report["rejected"], report["status"]), ({"ungrounded:kwh_min": 1}, {"rejected": 1, "parsed_sources": 0}))

    def test_a_failed_model_batch_leaves_the_source_alone(self):
        company = self.companies[0]
        self.wants(company, "Nissan Leaf 62kWh batteries", "stated", change_on="2026-10-01")

        def boom(system, user, key):
            raise OSError("down")

        runner = self.p.ModelRunner(self.dir.name, caller=boom, key="k", retries=0)
        report, _ = self.p.run(self.conn, runner, run_id="r1", apply_writes=True, builder="sql", workers=1, only_companies=self.companies)
        self.assertEqual((self.lines(company), report["status"]), ([], {"unparsed:model_error": 1, "parsed_sources": 0}))

    def test_a_pack_family_key_comes_from_the_apps_builder(self):
        if not self.p.ts_available():
            self.skipTest("needs apps/web/node_modules")
        company = self.companies[0]
        self.wants(company, "Vauxhall Corsa-e 50kWh packs", "stated", change_on="2026-10-01")
        report, _ = self.parse({"Corsa": [product(make="Vauxhall", model="Corsa-e", format="pack", kwh_min=50, kwh_max=50,
                                                  quote="Vauxhall Corsa-e 50kWh packs")]}, builder="ts")
        self.assertEqual([line["product_key"] for line in self.lines(company)], ["pack:stellantis-ecmp-50kwh"])
        self.assertEqual(report["lines"]["added"], {"interest:pack": 1})

    def test_a_broad_only_line_is_not_written(self):
        company = self.companies[0]
        self.wants(company, "Mostly LFP packs from Finland", "stated", change_on="2026-10-01")
        report, sources = self.parse({"Finland": [product(format="pack", chemistry="LFP", quote="LFP packs")]})
        self.assertEqual((self.lines(company), report["lines"]["broad_only_skipped"], report["lines"]["added_total"]), ([], 1, 0))

    def test_a_model_without_a_capacity_is_a_model_level_line(self):
        if not self.p.ts_available():
            self.skipTest("needs apps/web/node_modules")
        company = self.companies[0]
        self.wants(company, "Donor modules for Renault Zoe repairs", "researched", change_on="2026-10-01")
        self.parse({"Zoe": [product(make="Renault", model="Zoe", format="module", quote="Renault Zoe")]}, builder="ts")
        line = self.lines(company)[0]
        self.assertEqual((line["product_key"], line["product_key_level"], line["model"], line["kwh_min"]), ("model:renault-zoe", "model", "Zoe", None))

    def test_a_model_with_no_kwh_is_a_model_level_line_in_both_builders(self):
        for builder in ("sql", "ts"):
            if builder == "ts" and not self.p.ts_available():
                continue
            company = self.companies[0]
            self.wants(company, "Autocraft wants Kia EV3 modules", "stated", change_on="2026-10-01")
            self.parse({"EV3": [product(make="Kia", model="EV3", format="module", quote="Kia EV3 modules")]}, builder=builder,
                       run_id=f"m_{builder}")
            [line] = self.lines(company)
            self.assertEqual((line["product_key"], line["product_key_level"], line["format"], line["kwh_min"]), ("model:kia-ev3", "model", "module", None), builder)
            self.setUp()

    def test_a_target_price_keeps_a_flexible_figure_and_stays_a_target(self):
        company = self.companies[3]
        self.demand(company, "Procurement of 3 MWh of prismatic cells; target landing cost under $30/kWh with flexibility up to $50/kWh",
                    spec={"formats": ["Cells"]})
        self.parse({"landing": [product(format="cell", kwh_min=3000, kwh_max=3000, price=30, price_max=50, price_currency="USD",
                                        price_unit="kWh", quote="target landing cost under $30/kWh with flexibility up to $50/kWh")]})
        [line] = self.lines(company)
        self.assertEqual((float(line["price"]), float(line["price_max"]), line["price_currency"], line["price_unit"], line["price_basis"]),
                         (30.0, 50.0, "USD", "kWh", "target"))

    def test_a_flexible_figure_from_a_later_source_joins_the_same_line(self):
        company = self.companies[4]
        first = self.demand(company, "Prismatic cells 3 MWh", spec={"formats": ["Cells"]}, observed_on="2026-05-28")
        second = self.demand(company, "Prismatic cells 3 MWh, under $30/kWh, flexible up to $50/kWh", spec={"formats": ["Cells"]}, observed_on="2026-06-12")
        self.parse({"Prismatic cells 3 MWh": [product(format="cell", kwh_min=3000, kwh_max=3000, quote="Prismatic cells 3 MWh")],
                    "Prismatic cells 3 MWh, under": [product(format="cell", kwh_min=3000, kwh_max=3000, price=30, price_max=50, price_currency="USD",
                                                             price_unit="kWh", quote="under $30/kWh, flexible up to $50/kWh")]})
        [line] = [l for l in self.lines(company) if l["kwh_min"] is not None]
        self.assertEqual((float(line["price"]), float(line["price_max"]), line["price_basis"]), (30.0, 50.0, "target"))
        self.assertEqual((str(line["first_seen"]), str(line["last_seen"])), ("2026-05-28", "2026-06-12"))
        self.assertTrue(first and second)

    def test_two_formats_of_one_model_are_one_line_with_the_format_left_open(self):
        company = self.companies[0]
        self.wants(company, "Donor Kia EV3 modules and packs", "researched", change_on="2026-10-16")
        self.parse({"EV3": [product(make="Kia", model="EV3", format="module", quote="Donor Kia EV3 modules and packs"),
                            product(make="Kia", model="EV3", format="pack", quote="Donor Kia EV3 modules and packs")]})
        [line] = self.lines(company)
        self.assertEqual((line["product_key"], line["format"]), ("model:kia-ev3", None))

    def test_a_flexible_figure_joins_a_line_in_either_order_and_never_sits_below_the_price(self):
        priced = product(format="cell", kwh_min=3000, kwh_max=3000, price=30, price_max=50, price_currency="USD", price_unit="kWh", quantity=None)
        plain = product(format="cell", kwh_min=3000, kwh_max=3000)
        line = {"key": "broad:any-cells", "level": "broad", "make": None, "model": None, "format": "cell", "chemistry": None,
                "kwh_min": 3000, "kwh_max": 3000, "raw_product": None}
        for n, order in enumerate(((plain, priced), (priced, plain))):
            company = self.companies[n]
            for step, item in enumerate(order):
                source = {"company_id": company, "ref": f"crm:order_{n}_{step}", "date": f"2026-06-0{step + 1}"}
                with self.cur() as cur:
                    self.p.write_line(cur, source, "interest", line, item, "r1")
            self.conn.commit()
            [row] = self.lines(company)
            self.assertEqual((float(row["price"]), float(row["price_max"])), (30.0, 50.0), order)
        # an existing price above the new flexible figure leaves the line alone rather than breaking the table check
        company = self.companies[2]
        high = product(format="cell", kwh_min=3000, kwh_max=3000, price=40, price_currency="USD", price_unit="kWh")
        low = {**priced, "price": 20.0, "price_max": 35.0}
        for step, item in enumerate((high, low)):
            with self.cur() as cur:
                self.p.write_line(cur, {"company_id": company, "ref": f"crm:cap_{step}", "date": f"2026-06-0{step + 1}"}, "interest", line, item, "r1")
            self.conn.commit()
        [row] = self.lines(company)
        self.assertEqual((float(row["price"]), row["price_max"]), (40.0, None))

    def test_a_named_maker_stays_and_a_bare_bolt_is_dropped_never_any_packs(self):
        company = self.companies[5]
        text = "Donor modules/packs for Tesla and Bolt HV battery service."
        self.wants(company, text, "researched", change_on="2026-10-16")
        report, sources = self.parse({"Tesla and Bolt": [
            product(make="Tesla", format="module", quote="Donor modules/packs for Tesla"),
            product(make="Tesla", format="pack", quote="Donor modules/packs for Tesla"),
            product(model="Bolt", format="module", quote="Donor modules/packs for Tesla and Bolt"),
            product(model="Bolt", format="pack", quote="Donor modules/packs for Tesla and Bolt")]})
        self.assertEqual([l["product_key"] for l in self.lines(company)], [])  # Tesla lines are the buy box's own broad lines
        keys = {line["key"] for source in sources for line in source.get("lines") or []}
        self.assertEqual(keys, {"broad:tesla-any-modules", "broad:tesla-any-packs"})
        self.assertEqual(report["lines"]["added_total"], 0)

    def test_a_bolt_ev_with_its_maker_is_a_chevrolet_model_line(self):
        company = self.companies[5]
        self.wants(company, "Chevrolet Bolt EV modules for repairs", "researched", change_on="2026-10-16")
        self.parse({"Bolt": [product(make="Chevrolet", model="Bolt EV", format="module", quote="Chevrolet Bolt EV modules")]})
        [line] = self.lines(company)
        self.assertEqual(line["product_key"], "model:chevrolet-boltev")

    def test_a_note_that_guesses_a_role_or_buys_new_only_is_skipped_before_the_model(self):
        calls = []
        for n, text in enumerate(("Likely trader/competitor: sources and resells used Leaf packs; could be a supplier or buyer of modules.",
                                  "Premium new cylindrical cells (Molicel P42A); little fit for used EV modules except possibly cell-level reuse.")):
            self.wants(self.companies[n], text, "researched", change_on="2026-10-16")
        report, sources = self.parse({"Leaf": [product(make="Nissan", model="Leaf", format="pack", quote="resells used Leaf packs")],
                                      "Molicel": [product(make="Molicel", model="P42A", format="cell", quote="Molicel P42A")]}, calls=calls)
        self.assertEqual(calls, [])
        self.assertEqual(report["skipped"], {"wants:role_guess": 1, "wants:new_only": 1})
        self.assertEqual([self.lines(c) for c in self.companies[:2]], [[], []])

    def test_a_source_error_rolls_back_only_that_source(self):
        good, bad = self.companies[0], self.companies[1]
        self.wants(good, "Nissan Leaf 40kWh batteries", "stated", change_on="2026-10-01")
        self.wants(bad, "Renault Zoe 41kWh batteries", "stated", change_on="2026-10-01")
        original = self.p.write_line

        def flaky(cur, source, kind, line, product_, run_id):
            if source["company_id"] == bad:
                raise RuntimeError("boom")
            return original(cur, source, kind, line, product_, run_id)

        self.p.write_line = flaky
        try:
            report, _ = self.parse({"Leaf": [product(make="Nissan", model="Leaf", kwh_min=40, kwh_max=40, quote="Nissan Leaf 40kWh")],
                                    "Zoe": [product(make="Renault", model="Zoe", kwh_min=41, kwh_max=41, quote="Renault Zoe 41kWh")]})
        finally:
            self.p.write_line = original
        self.assertEqual(len(self.lines(good)), 1)
        self.assertEqual(self.lines(bad), [])
        self.assertEqual(len(report["errors"]), 1)


if __name__ == "__main__":
    unittest.main()
