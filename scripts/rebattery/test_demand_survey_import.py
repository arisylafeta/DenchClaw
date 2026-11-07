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
    def test_explicit_typeform_deadline_is_saved_as_request_and_note(self):
        row = survey.map_typeform_row([*HEADER, "When do you need them?"], [*CONNECTED, "By 2026-11-15"])
        self.assertEqual((row["kind"], row["basis"], row["needed_by"]), ("request", None, "2026-11-15"))
        self.assertIn("When: By 2026-11-15", row["note"])

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


class QuantityAndDateRule(unittest.TestCase):
    """A qualifying ask needs a quantity and a timing; the timing may be top-level or in the spec."""

    def test_matrix(self):
        cases = [
            ("quantity only", {"quantity": "10 packs"}, False),
            ("timing only", {"timing": "Q1 2027"}, False),
            ("neither", {}, False),
            ("both", {"quantity": "10 packs", "timing": "Q1 2027"}, True),
            ("both, with needed_by", {"quantity": 5, "needed_by": "2026-12-01"}, True),
            ("timing inside the spec", {"quantity": "10 packs", "spec": {"timing": "Q1 2027"}}, True),
            ("needed_by inside the spec", {"quantity": "10 packs", "spec": {"needed_by": "2026-12-01"}}, True),
            ("empty values are not a date", {"quantity": "10 packs", "timing": "", "spec": {"needed_by": ""}}, False),
            ("a quantity of zero is not a quantity", {"quantity": 0, "timing": "Q1 2027"}, False),
        ]
        for name, row, expected in cases:
            with self.subTest(name=name):
                self.assertEqual(survey.has_quantity_and_date(row), expected)


@unittest.skipUnless(TEST_URL, "needs a disposable database: scripts/rebattery/crm-test-db.sh up")
class Writing(unittest.TestCase):
    def test_stated_profile_preserves_constraints_and_attributed_note_criteria(self):
        import psycopg2
        import psycopg2.extras
        from demand_lifecycle import merge_profile
        conn = psycopg2.connect(TEST_URL)
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("insert into crm_companies (id, name) values ('co_profile_criteria', 'Profile Criteria')")
                row = {'company_id': 'co_profile_criteria', 'wants': 'Leaf ZE1', 'spec': {'min_soh': 80},
                       'note': '400V; delivery to Germany; max EUR 20/kWh', 'source_kind': 'survey', 'source_id': 'criteria:1'}
                self.assertTrue(merge_profile(cur, row))
                self.assertFalse(merge_profile(cur, row))
                self.assertFalse(merge_profile(cur, {**row, 'spec': {'min_soh': 60}, 'wants': 'All EV packs'}, 'researched'))
                cur.execute("select buyer_profile from crm_companies where id = 'co_profile_criteria'")
                profile = cur.fetchone()['buyer_profile']
                self.assertEqual(profile['min_soh'], 80)
                self.assertEqual(profile['wants'], 'Leaf ZE1')
                self.assertEqual(profile['criteria_evidence'], [{'note': row['note'], 'source_kind': 'survey', 'source_id': 'criteria:1'}])
        finally:
            conn.rollback()
            conn.close()

    def test_completed_quantity_survey_refreshes_same_source_and_keeps_deadline(self):
        import psycopg2
        import psycopg2.extras
        conn = psycopg2.connect(TEST_URL)
        old = {'id': 'fb_refresh_timing', 'created_at': '2026-06-01T10:00:00Z', 'finished': False,
               'data': {'email': 'timing@synthetic.test', 'formats': ['Packs'], 'lot_size': '20', 'timing': 'This month'}}
        done = {**old, 'finished': True, 'data': {**old['data'], 'notes': '400V only', 'needed_by': '2026-11-15'}}
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                self.assertTrue(survey.insert(cur, survey.link(cur, survey.map_formbricks(old))))
                self.assertTrue(survey.insert(cur, survey.link(cur, survey.map_formbricks(done))))
                cur.execute("select kind, basis, needed_by::text, note from crm_bulk_demand where source_id = 'formbricks:fb_refresh_timing'")
                row = cur.fetchone()
                self.assertEqual((row['kind'], row['basis'], row['needed_by']), ('request', None, '2026-11-15'))
                self.assertIn('400V only', row['note'])
                self.assertIn('When: This month', row['note'])
                self.assertNotIn('Unfinished survey.', row['note'])
                self.assertFalse(survey.insert(cur, survey.link(cur, survey.map_formbricks(done))))
        finally:
            conn.rollback()
            conn.close()

    def test_saved_search_is_profile_and_sourcing_request_is_qualifying(self):
        import psycopg2
        import psycopg2.extras
        import saved_search_import as saved_search
        conn = psycopg2.connect(TEST_URL)
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                search = saved_search.map_saved_search({"id": "synthetic-search", "email": "saved@synthetic.test",
                    "confirmed_at": "2026-10-16", "filters": {"format": ["pack"], "chemistry": ["lfp"]},
                    "label": "LFP packs", "frequency": "daily", "status": "active"})
                self.assertTrue(survey.insert(cur, survey.link(cur, search)))
                self.assertFalse(survey.insert(cur, survey.link(cur, search)))
                cur.execute("select buyer_profile_basis, buyer_profile from crm_companies where id = %s", (search["company_id"],))
                profile = cur.fetchone()
                self.assertEqual(profile["buyer_profile_basis"], "stated")
                self.assertEqual(profile["buyer_profile"]["chemistries"], ["LFP"])
                cur.execute("select count(*) as n from crm_bulk_demand where source_id = 'saved_search:synthetic-search'")
                self.assertEqual(cur.fetchone()["n"], 0)
                request = saved_search.map_sourcing_request({"id": "synthetic-request", "email": "saved@synthetic.test",
                    "wants": "20 Nissan Leaf packs", "quantity": "many", "timing": "now", "created_at": "2026-10-16",
                    "filters": {"format": ["pack"]}, "target_price": 1000, "target_currency": "EUR"})
                self.assertTrue(survey.insert(cur, survey.link(cur, request)))
                cur.execute("select status from crm_bulk_demand where source_id = 'sourcing_request:synthetic-request'")
                self.assertEqual(cur.fetchone()["status"], "qualifying")
        finally:
            conn.rollback()
            conn.close()

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
            cur.execute("""select status, kind, basis, confirmed_on::text, volume::float8, spec
                           from crm_bulk_demand where source_id = 'typeform:resp1'""")
            saved = cur.fetchone()
        conn.close()
        self.assertEqual((saved["status"], saved["kind"], saved["basis"], saved["confirmed_on"], saved["volume"]),
                         ("qualifying", "standing", "stated", "2026-08-20", 200.0))
        self.assertEqual(saved["spec"]["kwh_min"], 30)

    def test_finished_answer_merges_into_profile_without_creating_demand(self):
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
            cur.execute("select buyer_profile from crm_companies where id = %s", (survey.link(cur, survey.map_formbricks(done))["company_id"],))
            saved = cur.fetchone()["buyer_profile"]
            self.assertEqual(saved["formats"], ["Packs"])
            self.assertEqual(saved["chemistries"], ["LFP"])
            self.assertEqual(saved["min_soh"], 80)
            cur.execute("select count(*) as n from crm_bulk_demand where source_id = 'formbricks:fb_up'")
            self.assertEqual(cur.fetchone()["n"], 0)
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

    def test_research_is_profile_not_demand(self):
        import psycopg2
        import psycopg2.extras
        conn = psycopg2.connect(TEST_URL)
        with conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("insert into crm_companies (id, name) values ('co_research_profile', 'Research Buyer') on conflict do nothing")
            row = {"kind": "standing", "basis": "estimated", "company_id": "co_research_profile",
                   "buyer": "Research Buyer", "wants": "EV modules", "spec": {},
                   "source_kind": "research", "source_id": "research:profile:test"}
            self.assertTrue(survey.insert(cur, row))
            cur.execute("select buyer_profile_basis, buyer_profile from crm_companies where id = 'co_research_profile'")
            saved = cur.fetchone()
        conn.close()
        self.assertEqual(saved["buyer_profile_basis"], "researched")
        self.assertEqual(saved["buyer_profile"]["wants"], "EV modules")


    def test_spec_needed_by_still_makes_it_a_qualifying_ask(self):
        import psycopg2
        import psycopg2.extras
        conn = psycopg2.connect(TEST_URL)
        with conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("insert into crm_companies (id, name) values ('co_spec_date', 'Spec Date Ltd') on conflict do nothing")
            row = {"company_id": "co_spec_date", "wants": "Leaf packs", "quantity": "10 packs", "kind": "request",
                   "spec": {"needed_by": "2026-12-01"}, "source_kind": "survey", "source_id": "criteria:spec-date"}
            row = survey.link(cur, row)
            self.assertEqual(row["buyer"], "Spec Date Ltd")
            self.assertTrue(survey.insert(cur, row))
            cur.execute("select status, quantity from crm_bulk_demand where source_id = 'criteria:spec-date'")
            saved = cur.fetchone()
        conn.close()
        self.assertEqual((saved["status"], saved["quantity"]), ("qualifying", "10 packs"))


@unittest.skipUnless(TEST_URL, "needs a disposable database: scripts/rebattery/crm-test-db.sh up")
class DossierCompanies(unittest.TestCase):
    """A company with a buyer dossier owns its own buy box: intake may flag it, never rewrite it."""

    def setUp(self):
        import uuid

        import psycopg2
        import psycopg2.extras
        import saved_search_import
        self.saved_search = saved_search_import
        # The rows outlive the run (deleting a company cascades into the frozen Bulk Trades tables),
        # so every company and email is unique to this run.
        self.run_id = uuid.uuid4().hex[:8]
        self.conn = psycopg2.connect(TEST_URL)
        self.addCleanup(self.conn.close)

    def cid(self, tag):
        return f"co_dossier_{tag}_{self.run_id}"

    def email(self, tag):
        return f"{tag}.{self.run_id}@synthetic.test"

    def cursor(self):
        import psycopg2.extras
        return self.conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    def company(self, cur, company_id, dossier=None, profile=None):
        if dossier:
            # A company that already has dossier text is written by the dossier path, which the guard checks.
            cur.execute("select set_config('crm.dossier_write', 'on', true)")
        cur.execute("""insert into crm_companies (id, name, buyer_profile, buyer_dossier, buyer_dossier_version)
                       values (%s, %s, coalesce(%s::jsonb, '{}'::jsonb), %s, %s)""",
                    (company_id, company_id, json.dumps(profile) if profile else None,
                     dossier, 1 if dossier else 0))

    def person(self, cur, person_id, email, company_id):
        cur.execute("insert into crm_people (id, full_name, email, company_id) values (%s, %s, %s, %s)",
                    (person_id, person_id, email, company_id))

    @staticmethod
    def dossier(company_id):
        return f"---\ncompany_id: {company_id}\nproducts: []\n---\nText owned by a person.\n"

    def survey_row(self, email, response_id):
        return {"id": response_id, "created_at": "2026-10-20T09:00:00Z", "finished": True,
                "data": {"email": email, "formats": ["Packs"], "chemistries": ["LFP"]}}

    def test_a_dossier_company_is_flagged_stale_and_keeps_its_profile(self):
        company_id, email = self.cid("survey"), self.email("dossier.intake")
        dossier = self.dossier(company_id)
        with self.cursor() as cur:
            self.company(cur, company_id, dossier=dossier, profile={"wants": "the dossier owns this", "chemistries": ["NMC"]})
            self.person(cur, f"p_dossier_intake_{self.run_id}", email, company_id)
            row = survey.link(cur, survey.map_formbricks(self.survey_row(email, f"fb_dossier_intake_{self.run_id}")))
            self.assertEqual(row["company_id"], company_id)

            self.assertTrue(survey.insert(cur, row))
            cur.execute("""select buyer_profile, buyer_profile_basis, buyer_dossier, buyer_dossier_version,
                             buyer_dossier_stale_since::text as stale_since, buyer_dossier_stale_reasons as reasons
                           from crm_companies where id = %s""", (company_id,))
            saved = cur.fetchone()
            self.assertEqual(saved["buyer_profile"], {"wants": "the dossier owns this", "chemistries": ["NMC"]})
            self.assertIsNone(saved["buyer_profile_basis"])
            self.assertEqual(saved["buyer_dossier"], dossier)
            self.assertEqual(saved["buyer_dossier_version"], 1)
            self.assertEqual(saved["stale_since"], "2026-10-20")
            self.assertEqual(len(saved["reasons"]), 1)
            self.assertEqual(saved["reasons"][0]["source_id"], f"formbricks:fb_dossier_intake_{self.run_id}")
            self.assertEqual(saved["reasons"][0]["date"], "2026-10-20")
            self.assertIn("Formbricks buyer survey", saved["reasons"][0]["reason"])

            # The same answer again changes nothing, so it is not reported as new.
            self.assertFalse(survey.insert(cur, row))
            cur.execute("select buyer_dossier_stale_reasons as reasons from crm_companies where id = %s", (company_id,))
            self.assertEqual(len(cur.fetchone()["reasons"]), 1)

            # A second, different source appends its own dated reason and keeps the earliest date.
            request = self.saved_search.map_sourcing_request({
                "id": f"dossier-request-{self.run_id}", "email": email, "wants": "Leaf packs",
                "quantity": "many", "created_at": "2026-10-25"})
            self.assertTrue(survey.insert(cur, survey.link(cur, request)))
            cur.execute("""select buyer_dossier_stale_since::text as stale_since, buyer_dossier_stale_reasons as reasons
                           from crm_companies where id = %s""", (company_id,))
            flagged = cur.fetchone()
            self.assertEqual(flagged["stale_since"], "2026-10-20")
            self.assertEqual([reason["source_id"] for reason in flagged["reasons"]],
                             [f"formbricks:fb_dossier_intake_{self.run_id}", f"sourcing_request:dossier-request-{self.run_id}"])
            self.conn.rollback()

    def test_a_company_without_a_dossier_keeps_todays_merge(self):
        company_id, email = self.cid("none"), self.email("no.dossier")
        with self.cursor() as cur:
            self.company(cur, company_id, profile={"wants": "old wants"})
            self.person(cur, f"p_dossier_none_{self.run_id}", email, company_id)
            row = survey.link(cur, survey.map_formbricks(self.survey_row(email, f"fb_no_dossier_{self.run_id}")))
            self.assertTrue(survey.insert(cur, row))
            cur.execute("""select buyer_profile, buyer_profile_basis, buyer_dossier_stale_since::text as stale_since
                           from crm_companies where id = %s""", (company_id,))
            saved = cur.fetchone()
            self.assertEqual(saved["buyer_profile"]["chemistries"], ["LFP"])
            self.assertTrue(saved["buyer_profile"]["wants"].startswith("old wants"))
            self.assertIn("Packs, LFP", saved["buyer_profile"]["wants"])
            self.assertEqual(saved["buyer_profile_basis"], "stated")
            self.assertIsNone(saved["stale_since"])
            self.conn.rollback()

    def test_a_dossier_companys_saved_search_is_also_a_dated_alert_note(self):
        company_id, email = self.cid("search"), self.email("saved.search")
        with self.cursor() as cur:
            self.company(cur, company_id, dossier=self.dossier(company_id), profile={"wants": "dossier text"})
            self.person(cur, f"p_dossier_search_{self.run_id}", email, company_id)
            search = self.saved_search.map_saved_search({
                "id": f"dossier-search-{self.run_id}", "email": email, "confirmed_at": "2026-10-21",
                "filters": {"format": ["pack"], "chemistry": ["lfp"]}, "label": "LFP packs",
                "frequency": "daily", "status": "active", "catalog_path": "/marketplace/listings"})
            self.assertTrue(survey.insert(cur, survey.link(cur, search)))
            self.assertFalse(survey.insert(cur, survey.link(cur, search)))
            cur.execute("""select note, category, source_kind, source_ref, observed_on::text as observed_on, source_url
                           from crm_company_context_notes where company_id = %s""", (company_id,))
            notes = cur.fetchall()
            self.assertEqual(len(notes), 1)
            self.assertEqual(notes[0]["category"], "saved_search")
            self.assertEqual(notes[0]["source_ref"], f"saved_search:dossier-search-{self.run_id}")
            self.assertEqual(notes[0]["observed_on"], "2026-10-21")
            self.assertTrue(notes[0]["note"].startswith("LFP packs"))
            self.assertIn("Formats: Packs", notes[0]["note"])
            self.assertIn("Chemistries: LFP", notes[0]["note"])
            self.assertEqual(notes[0]["source_url"], "https://www.rebattery.io/marketplace/listings")
            cur.execute("select buyer_profile from crm_companies where id = %s", (company_id,))
            self.assertEqual(cur.fetchone()["buyer_profile"], {"wants": "dossier text"})
            cur.execute("select count(*) as n from crm_bulk_demand where source_id = %s",
                        (f"saved_search:dossier-search-{self.run_id}",))
            self.assertEqual(cur.fetchone()["n"], 0)
            self.conn.rollback()

    def test_a_sourcing_request_without_quantity_and_timing_is_standing_interest(self):
        company_id, email = self.cid("request"), self.email("sourcing")
        with self.cursor() as cur:
            self.company(cur, company_id, dossier=self.dossier(company_id))
            self.person(cur, f"p_dossier_request_{self.run_id}", email, company_id)
            vague = self.saved_search.map_sourcing_request({
                "id": f"vague-{self.run_id}", "email": email, "wants": "Some EV packs",
                "created_at": "2026-10-22"})
            self.assertIsNone(vague["quantity"])
            self.assertIsNone(vague["timing"])
            survey.insert(cur, survey.link(cur, vague))
            cur.execute("select count(*) as n from crm_bulk_demand where source_id = %s",
                        (f"sourcing_request:vague-{self.run_id}",))
            self.assertEqual(cur.fetchone()["n"], 0)
            cur.execute("select buyer_dossier_stale_since::text as stale_since from crm_companies where id = %s",
                        (company_id,))
            self.assertEqual(cur.fetchone()["stale_since"], "2026-10-22")

            complete = self.saved_search.map_sourcing_request({
                "id": f"complete-{self.run_id}", "email": email, "wants": "20 Leaf packs",
                "quantity": "many", "timing": "now", "created_at": "2026-10-23"})
            self.assertTrue(survey.insert(cur, survey.link(cur, complete)))
            cur.execute("""select status, kind, quantity from crm_bulk_demand where source_id = %s""",
                        (f"sourcing_request:complete-{self.run_id}",))
            saved = cur.fetchone()
            self.assertEqual(saved["status"], "qualifying")
            self.assertEqual(saved["kind"], "request")
            self.assertEqual(saved["quantity"], "More than 10 units")
            self.conn.rollback()

    def stale_rows(self, cur):
        cur.execute("""select buyer_dossier_stale_since::text as stale_since, buyer_dossier_stale_reasons as reasons
                       from crm_companies where id = %s""", (self.company_id,))
        return cur.fetchone()

    def test_evidence_without_a_source_id_is_recorded_once(self):
        """The dedupe key no longer depends on source_id: a row without one must not grow the list."""
        import demand_lifecycle as lifecycle
        self.company_id, email = self.cid("nosrc"), self.email("no.source")
        with self.cursor() as cur:
            self.company(cur, self.company_id, dossier=self.dossier(self.company_id))
            self.person(cur, f"p_dossier_nosrc_{self.run_id}", email, self.company_id)
            row = {"company_id": self.company_id, "wants": "Leaf packs", "observed_on": "2026-10-11",
                   "source_kind": "import", "source_label": "Sourcing request", "source_id": None, "spec": {}}
            self.assertTrue(lifecycle.merge_profile(cur, dict(row)))
            self.assertFalse(lifecycle.merge_profile(cur, dict(row)))
            saved = self.stale_rows(cur)
            self.assertEqual(saved["stale_since"], "2026-10-11")
            self.assertEqual(len(saved["reasons"]), 1)
            self.assertIsNone(saved["reasons"][0]["source_id"])
            first_key = saved["reasons"][0]["key"]
            self.assertTrue(first_key.startswith("intake:"))

            # A demand row that has an id keys on that id, so the same row is one reason.
            keyed = {**row, "id": f"btd_{self.run_id}", "source_label": "Jules"}
            self.assertTrue(lifecycle.merge_profile(cur, dict(keyed)))
            self.assertFalse(lifecycle.merge_profile(cur, dict(keyed)))
            reasons = self.stale_rows(cur)["reasons"]
            self.assertEqual([reason["key"] for reason in reasons], [first_key, f"demand:btd_{self.run_id}"])
            self.conn.rollback()

    def test_the_reason_list_keeps_the_newest_fifty(self):
        import demand_lifecycle as lifecycle
        self.company_id, email = self.cid("cap"), self.email("cap")
        with self.cursor() as cur:
            self.company(cur, self.company_id, dossier=self.dossier(self.company_id))
            for i in range(55):
                row = {"company_id": self.company_id, "wants": f"Ask {i}", "observed_on": f"2026-10-{(i % 28) + 1:02d}",
                       "source_kind": "import", "source_label": "Sourcing request", "source_id": f"cap:{i}", "spec": {}}
                self.assertTrue(lifecycle.merge_profile(cur, row))
            reasons = self.stale_rows(cur)["reasons"]
            self.assertEqual(len(reasons), lifecycle.STALE_REASONS_MAX)
            self.assertEqual(reasons[-1]["source_id"], "cap:54")
            self.assertEqual(reasons[0]["source_id"], "cap:5")
            self.conn.rollback()

    def test_a_changed_saved_search_updates_its_alert_note_in_place(self):
        company_id, email = self.cid("searchedit"), self.email("saved.search.edit")
        with self.cursor() as cur:
            self.company(cur, company_id, dossier=self.dossier(company_id), profile={"wants": "dossier text"})
            self.person(cur, f"p_dossier_searchedit_{self.run_id}", email, company_id)
            base = {"id": f"dossier-search-edit-{self.run_id}", "email": email, "confirmed_at": "2026-10-21",
                    "label": "LFP packs", "frequency": "daily", "status": "active",
                    "catalog_path": "/marketplace/listings"}
            first = self.saved_search.map_saved_search({**base, "filters": {"format": ["pack"], "chemistry": ["lfp"]}})
            self.assertTrue(survey.insert(cur, survey.link(cur, first)))
            # The same search, now asking for NMC: the alert note follows the buyer's filters.
            second = self.saved_search.map_saved_search({**base, "filters": {"format": ["pack"], "chemistry": ["nmc"]}})
            self.assertTrue(survey.insert(cur, survey.link(cur, second)))
            self.assertFalse(survey.insert(cur, survey.link(cur, second)))
            cur.execute("""select note from crm_company_context_notes
                           where company_id = %s and category = 'saved_search'""", (company_id,))
            notes = cur.fetchall()
            self.assertEqual(len(notes), 1)
            self.assertIn("Chemistries: NMC", notes[0]["note"])
            self.assertNotIn("Chemistries: LFP", notes[0]["note"])
            self.conn.rollback()


if __name__ == "__main__":
    unittest.main()
