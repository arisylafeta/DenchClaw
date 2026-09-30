import importlib.util
import json
import os
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("survey", Path(__file__).with_name("demand_survey_import.py"))
survey = importlib.util.module_from_spec(spec)
spec.loader.exec_module(survey)

# The Typeform CSV repeats option headers ("Other", "No preference") and puts one column per option.
HEADER = ["#", "What's your name?", "What's your email?", "What will you use these batteries for?", "Other",
          "Which country will they be delivered to?", "Where are you in the process?",
          "What's holding you back from buying more than you do today?", "What format suits you best?", "Complete pack",
          "Module", "Cell", "No preference", "Preferred chemistry", "LFP", "NMC", "Sodium-ion",
          "What's the lowest condition you'd accept?", "Second-life — removed from a vehicle or storage system", "Other",
          "Tesla", "Hyundai or Kia", "Bus, truck or commercial vehicle (Iveco, Scania, Daimler Truck)", "No preference", "CATL",
          "Above 450V", "30 to 60 kWh", "60 to 100 kWh", "Over 100 kWh", "None of these — we need it ready to install",
          "Can you take mixed makes and models in one batch?", "None of these", "What was the last batch you bought?",
          "Realistic first order", "In what unit?", "Monthly volume once it's working", "What's the most you'd pay per kWh?",
          "Currency", "BMS or CAN readout — SOH estimate, cell voltages, fault codes", "Response Type", "Submit Date (UTC)", "company"]


def typeform_row(**answers):
    row = [""] * len(HEADER)
    for name, value in answers.items():
        row[HEADER.index(name)] = value
    return row


CONNECTED = typeform_row(**{
    "#": "resp1", "What's your name?": "Jonathan Cogman", "What's your email?": "Jonathan.Cogman@CE.example",
    "What will you use these batteries for?": "Building them into our own product", "Which country will they be delivered to?": "Spain",
    "Where are you in the process?": "3 to 12 months out",
    "What's holding you back from buying more than you do today?": "Finishing validation of our M-STOR platform",
    "What format suits you best?": "Complete pack", "Complete pack": "Complete pack", "Preferred chemistry": "NMC", "LFP": "LFP",
    "NMC": "NMC", "Sodium-ion": "Sodium-ion",
    "What's the lowest condition you'd accept?": "Functional — reduced capacity or minor faults, 60 to 79% SOH",
    "Tesla": "Tesla", "Hyundai or Kia": "Hyundai or Kia",
    "Bus, truck or commercial vehicle (Iveco, Scania, Daimler Truck)": "Bus, truck or commercial vehicle (Iveco, Scania, Daimler Truck)",
    "Above 450V": "Above 450V", "30 to 60 kWh": "30 to 60 kWh", "60 to 100 kWh": "60 to 100 kWh", "Over 100 kWh": "Over 100 kWh",
    "None of these — we need it ready to install": "None of these — we need it ready to install",
    "Can you take mixed makes and models in one batch?": "No — every batch must be one make and model",
    "None of these": "None of these", "What was the last batch you bought?": "106 Forsee Power Zen35 packs",
    "Realistic first order": "50", "In what unit?": "Packs", "Monthly volume once it's working": "200",
    "What's the most you'd pay per kWh?": "45", "Currency": "GBP",
    "BMS or CAN readout — SOH estimate, cell voltages, fault codes": "BMS or CAN readout — SOH estimate, cell voltages, fault codes",
    "Response Type": "completed", "Submit Date (UTC)": "2026-08-20 15:09:08",
})


class TypeformMapping(unittest.TestCase):
    def test_maps_a_demand_survey_response_onto_a_stated_buy_box(self):
        row = survey.map_typeform_row(HEADER, CONNECTED)
        self.assertEqual(row["spec"], {
            "formats": ["Packs"], "chemistries": ["LFP", "NMC", "Sodium-ion"],
            "makes": ["Tesla", "Hyundai or Kia"], "origins": ["Passenger EV", "Bus or truck"], "kwh_min": 30,
            "min_soh": 60, "mixed_ok": False, "evidence": ["BMS readout"],
        })
        self.assertEqual({k: row[k] for k in ("kind", "basis", "email", "contact", "location", "volume", "volume_unit",
                                              "max_price", "price_currency", "price_unit", "observed_on", "source_id")},
                         {"kind": "standing", "basis": "stated", "email": "jonathan.cogman@ce.example", "contact": "Jonathan Cogman",
                          "location": "Spain", "volume": 200, "volume_unit": "packs", "max_price": 45, "price_currency": "GBP",
                          "price_unit": "kWh", "observed_on": "2026-08-20", "source_id": "typeform:resp1"})
        self.assertEqual(row["wants"], "Packs, LFP / NMC / Sodium-ion, 30+ kWh, 60%+ SOH, for building them into our own product")
        for line in ("Stage: 3 to 12 months out", "Last batch: 106 Forsee Power Zen35 packs", "First order: 50 packs",
                     "Voltage: Above 450V", "Can do: None of these — we need it ready to install", "Risk question: None of these"):
            self.assertIn(line, row["note"])
        # The ambiguous risk question stays in the note, not in "won't take".
        self.assertNotIn("excludes", row["spec"])

    def test_skips_staff_tests_and_blank_rows(self):
        self.assertIsNone(survey.map_typeform_row(HEADER, typeform_row(**{"#": "x", "What's your email?": "ari@rebattery.io"})))
        self.assertIsNone(survey.map_typeform_row(HEADER, typeform_row(**{"#": "y"})))
        self.assertIsNone(survey.map_typeform_row(HEADER, typeform_row(**{"#": "z", "What's your email?": "qa-approved-buyer@example.com"})))


class Numbers(unittest.TestCase):
    def test_reads_thousands_decimals_and_ranges(self):
        self.assertEqual([survey.number(v) for v in ("1,000", "1,500 packs", "2.5", "2,5", "20 to 30", "any", "12,000,000")],
                         [1000, 1500, 2.5, 2.5, 20, None, 12000000])

    def test_an_other_use_answer_comes_from_the_use_questions_own_column(self):
        header = ["#", "What's your email?", "What will you use these batteries for?", "Other", "Chemistry", "Other", "Response Type"]
        row = survey.map_typeform_row(header, ["r9", "b@x.example", "Other", "Marine propulsion", "", "Something else", "completed"])
        self.assertTrue(row["wants"].endswith("for marine propulsion"))


class FormbricksMapping(unittest.TestCase):
    def test_maps_the_sidebar_survey_and_keeps_unmapped_answers_in_the_note(self):
        row = survey.map_formbricks({
            "id": "fb1", "created_at": "2026-07-17T07:50:28Z", "finished": True,
            "data": {"formats": ["Cells", "Modules", "Mixed lots / depends"], "chemistries": ["LFP", "NMC", "LCO"],
                     "use_case": "Energy storage", "condition": ["Used and tested", "Damaged / scrap"],
                     "sources": ["EV packs", "Truck / eBus batteries"], "min_soh": "any", "lot_size": "2-5 MWh",
                     "regions": ["UK", "Europe"], "requirements": ["Photos", "SOH report"]},
            "variables": {"email": "BatterySolutions@exigo.example", "company": "Exigo Recycling pvt Ltd"}})
        self.assertEqual(row["spec"], {"formats": ["Cells", "Modules"], "chemistries": ["LFP", "NMC"],
                                       "conditions": ["Second-life, tested", "Damaged or end of life"],
                                       "origins": ["Passenger EV", "Bus or truck"], "evidence": ["Photos"]})
        self.assertEqual((row["email"], row["company"], row["quantity"], row["observed_on"], row["source_id"]),
                         ("batterysolutions@exigo.example", "Exigo Recycling pvt Ltd", "Lots of 2-5 MWh", "2026-07-17", "formbricks:fb1"))
        self.assertEqual(row["note"], "Use: Energy storage\nFormats: Mixed lots / depends\nChemistries: LCO\nNeeds: SOH report\n"
                                      "Sources from: UK, Europe")
        self.assertEqual(row["wants"], "Cells / Modules, LFP / NMC, for energy storage")

    def test_recycling_answers_are_not_demand(self):
        self.assertIsNone(survey.map_formbricks({"id": "fb7", "finished": True, "data": {
            "email": "r@recycler.example", "formats": ["Cells"], "use_case": "Recycling"}}))

    def test_waits_a_day_before_taking_an_unfinished_response(self):
        import datetime as dt
        now = dt.datetime(2026, 9, 30, 12, tzinfo=dt.timezone.utc)
        response = {"id": "fb6", "created_at": "2026-09-30T08:00:00Z", "updated_at": "2026-09-30T08:10:00Z", "finished": False,
                    "data": {"email": "new@buyer.example", "formats": ["Packs"]}}
        self.assertIsNone(survey.map_formbricks(response, now))
        self.assertIsNotNone(survey.map_formbricks(response, now + dt.timedelta(days=1)))

    def test_keeps_an_unfinished_response_with_answers_and_drops_an_empty_one(self):
        partial = survey.map_formbricks({"id": "fb2", "created_at": "2026-06-01", "finished": False,
                                         "data": {"email": "martyn@zenobe.example", "formats": ["Packs"], "min_soh": 80}})
        self.assertEqual(partial["spec"], {"formats": ["Packs"], "min_soh": 80})
        self.assertTrue(partial["note"].startswith("Unfinished survey."))
        self.assertIsNone(survey.map_formbricks({"id": "fb3", "finished": False, "data": {"email": "someone@x.example"}}))
        self.assertIsNone(survey.map_formbricks({"id": "fb4", "finished": True,
                                                 "data": {"email": "alex@rebattery.io", "formats": ["Packs"]}}))
        self.assertNotIn("min_soh", survey.map_formbricks({"id": "fb5", "finished": True,
                                                           "data": {"email": "b@x.example", "formats": ["Packs"], "min_soh": 999}})["spec"])


class ReviewedRows(unittest.TestCase):
    def write(self, rows):
        import tempfile
        handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump({"rows": rows}, handle)
        handle.close()
        self.addCleanup(os.unlink, handle.name)
        return handle.name

    def test_research_rows_default_to_estimated_and_keep_only_valid_spec(self):
        [row] = survey.load_rows(self.write([{
            "buyer": "Gridturn", "wants": "Second-life EV modules for BESS cabinets", "source_kind": "research",
            "source_id": "research:gridturn:2026-10-01", "source_url": "https://gridturn.example",
            "spec": {"formats": ["Modules", "Crates"], "min_soh": 80}, "volume": 20, "volume_unit": "modules"}]))
        self.assertEqual((row["kind"], row["basis"], row["spec"], row["volume"]),
                         ("standing", "estimated", {"formats": ["Modules"], "min_soh": 80}, 20))

    def test_refuses_rows_that_do_not_fit_their_kind_or_lack_a_source(self):
        for bad in ({"wants": "x", "source_kind": "research", "source_id": "a", "kind": "request", "basis": "agreed"},
                    {"wants": "x", "source_kind": "research", "source_id": "a", "needed_by": "2026-11-01"},
                    {"wants": "x", "source_kind": "research"},
                    {"wants": "x", "source_kind": "research", "source_id": "a", "colour": "red"}):
            with self.assertRaises(SystemExit):
                survey.load_rows(self.write([bad]))


TEST_URL = os.environ.get("BULK_TRADES_TEST_DATABASE_URL")


@unittest.skipUnless(TEST_URL, "needs a disposable database: scripts/rebattery/crm-test-db.sh up")
class Writing(unittest.TestCase):
    def test_links_the_crm_company_and_adds_each_source_once(self):
        import psycopg2
        import psycopg2.extras
        conn = psycopg2.connect(TEST_URL)
        with conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""insert into crm_companies (id, name) values ('co_ce_import', 'Connected Energy') on conflict do nothing;
                           insert into crm_people (id, full_name, email, company_id)
                             values ('p_jc_import', 'Jonathan Cogman', 'jonathan.cogman@ce.example', 'co_ce_import') on conflict do nothing""")
            row = survey.link(cur, survey.map_typeform_row(HEADER, CONNECTED))
            self.assertEqual((row["buyer"], row["company_id"], row["person_id"]), ("Connected Energy", "co_ce_import", "p_jc_import"))
            self.assertTrue(survey.insert(cur, row))
            self.assertFalse(survey.insert(cur, survey.link(cur, survey.map_typeform_row(HEADER, CONNECTED))))
            cur.execute("""select kind, basis, confirmed_on::text, volume::float8, spec from crm_bulk_trade_demand
                           where source_kind = 'survey' and source_id = 'typeform:resp1'""")
            saved = cur.fetchone()
        conn.close()
        self.assertEqual((saved["kind"], saved["basis"], saved["confirmed_on"], saved["volume"]), ("standing", "stated", "2026-08-20", 200.0))
        self.assertEqual(saved["spec"]["kwh_min"], 30)

    def test_a_finished_answer_replaces_the_unfinished_import_unless_someone_edited_it(self):
        import psycopg2
        import psycopg2.extras
        old = {"id": "fb_up", "created_at": "2026-06-01T10:00:00Z", "finished": False,
               "data": {"email": "martyn@zenobe.example", "formats": ["Packs"]}}
        done = {**old, "finished": True, "data": {**old["data"], "chemistries": ["LFP"], "min_soh": 80}}
        conn = psycopg2.connect(TEST_URL)
        with conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            self.assertTrue(survey.insert(cur, survey.link(cur, survey.map_formbricks(old))))
            self.assertTrue(survey.insert(cur, survey.link(cur, survey.map_formbricks(done))))
            self.assertFalse(survey.insert(cur, survey.link(cur, survey.map_formbricks(done))))  # nothing new
            cur.execute("select spec, note from crm_bulk_trade_demand where source_id = 'formbricks:fb_up'")
            saved = cur.fetchone()
            self.assertEqual(saved["spec"], {"formats": ["Packs"], "chemistries": ["LFP"], "min_soh": 80})
            self.assertIsNone(saved["note"])
            # Once someone has edited the row, a later import leaves it alone.
            cur.execute("""update crm_bulk_trade_demand set note = 'Unfinished survey. Alex: call them', updated_at = now() + interval '1 minute'
                           where source_id = 'formbricks:fb_up'""")
            self.assertFalse(survey.insert(cur, survey.link(cur, survey.map_formbricks(done))))
        conn.close()

    def test_an_old_opportunity_keeps_its_deadline(self):
        import psycopg2
        import psycopg2.extras
        conn = psycopg2.connect(TEST_URL)
        with conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""insert into crm_companies (id, name) values ('co_sls', 'SLS Energy') on conflict do nothing;
                           insert into crm_commercial_opportunities (id, company_id, opportunity_type, title, deadline_at)
                           values ('opp-sls-test', 'co_sls', 'demand', 'SLS Energy - procurement of 3 MWh of prismatic cells', '2026-07-01')
                           on conflict do nothing""")
            [row] = [r for r in survey.load_opportunities(cur) if r["source_id"] == "opportunity:opp-sls-test"]
            conn.rollback()
        conn.close()
        self.assertEqual((row["kind"], row["needed_by"], row["wants"]), ("request", "2026-07-01", "Procurement of 3 MWh of prismatic cells"))

    def test_an_estimate_is_not_a_confirmation(self):
        import psycopg2
        import psycopg2.extras
        conn = psycopg2.connect(TEST_URL)
        with conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            row = survey.link(cur, {"kind": "standing", "basis": "estimated", "buyer": "Accu't", "wants": "EV modules",
                                    "spec": {}, "source_kind": "research", "source_id": "research:accut:test"})
            self.assertTrue(survey.insert(cur, row))
            cur.execute("select confirmed_on, observed_on from crm_bulk_trade_demand where source_id = 'research:accut:test'")
            saved = cur.fetchone()
        conn.close()
        self.assertIsNone(saved["confirmed_on"])
        self.assertIsNotNone(saved["observed_on"])


if __name__ == "__main__":
    unittest.main()
