"""Buyer interest lines written by the importers, on the disposable CRM database.

Set BULK_TRADES_TEST_DATABASE_URL (scripts/rebattery/crm-test-db.sh up prints the URL) to run; skipped otherwise.
"""
import datetime as dt
import importlib.util
import json
import os
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


@unittest.skipUnless(DSN, "needs the disposable CRM database (BULK_TRADES_TEST_DATABASE_URL)")
class InterestLines(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import psycopg2
        import psycopg2.extras
        cls.lifecycle = load("demand_lifecycle")
        cls.survey = load("demand_survey_import")
        cls.saved = load("saved_search_import")
        cls.conn = psycopg2.connect(DSN)
        cls.conn.autocommit = False
        cls.tag = uuid.uuid4().hex[:8]
        cls.company = f"co_interest_{cls.tag}"
        cls.person = f"p_interest_{cls.tag}"
        cls.email = f"buyer-{cls.tag}@example.test"
        with cls.conn.cursor() as cur:
            cur.execute("insert into crm_companies (id, name) values (%s, %s)", (cls.company, "Interest Test Buyer"))
            cur.execute("insert into crm_people (id, full_name, email, company_id) values (%s, %s, %s, %s)",
                        (cls.person, "Interest Buyer", cls.email, cls.company))
        cls.conn.commit()

    @classmethod
    def tearDownClass(cls):
        with cls.conn.cursor() as cur:
            cur.execute("delete from buyer_interest where company_id = %s", (cls.company,))
            cur.execute("delete from crm_bulk_listings where company_id = %s", (cls.company,))
            cur.execute("delete from crm_people where id = %s", (cls.person,))
            cur.execute("delete from crm_companies where id = %s", (cls.company,))
        cls.conn.commit()
        cls.conn.close()

    def cursor(self):
        import psycopg2.extras
        return self.conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    def lines(self, kind=None):
        import psycopg2.extras
        with self.conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            sql = "select * from buyer_interest where company_id = %s"
            params = [self.company]
            if kind:
                sql += " and kind = %s"
                params.append(kind)
            cur.execute(sql + " order by product_key, kind", params)
            return cur.fetchall()

    def survey_row(self, **over):
        row = {
            "kind": "standing", "basis": "stated", "buyer": "Interest Test Buyer", "company_id": self.company,
            "person_id": self.person, "contact": "Interest Buyer", "email": self.email, "wants": "LFP packs 50 kWh",
            "quantity": None, "location": None, "note": None, "spec": {"formats": ["Packs"], "chemistries": ["LFP"], "kwh_min": 50, "kwh_max": 50},
            "observed_on": "2026-11-04", "source_kind": "survey", "source_id": f"formbricks:{self.tag}",
            "source_label": "Formbricks buyer survey", "source_url": None,
        }
        row.update(over)
        return row

    def test_a_profile_merge_is_a_standing_want(self):
        with self.cursor() as cur:
            self.lifecycle.merge_profile(cur, self.survey_row(), "stated")
        self.conn.commit()
        [line] = self.lines("standing")
        self.assertEqual(line["ownership"], "mastered")
        self.assertEqual(line["product_key"], "broad:lfp-packs")
        self.assertEqual(line["product_key_level"], "broad")
        self.assertEqual(str(line["first_seen"]), "2026-11-04")
        self.assertEqual(str(line["last_seen"]), "2026-11-04")
        self.assertEqual(str(line["expires_on"]), "2027-02-02")   # standing: first seen + 90 days
        self.assertEqual(line["source_refs"], [f"formbricks:{self.tag}"])
        # The legacy profile still gets written; the line is an addition, not a move.
        with self.cursor() as cur:
            cur.execute("select buyer_profile from crm_companies where id = %s", (self.company,))
            self.assertTrue(cur.fetchone()["buyer_profile"]["formats"])

    def test_a_repeat_merge_moves_last_seen_without_duplicating(self):
        with self.cursor() as cur:
            self.lifecycle.merge_profile(cur, self.survey_row(observed_on="2026-11-20"), "stated")
        self.conn.commit()
        standing = self.lines("standing")
        self.assertEqual(len(standing), 1)
        self.assertEqual(str(standing[0]["first_seen"]), "2026-11-04")
        self.assertEqual(str(standing[0]["last_seen"]), "2026-11-20")

    def test_research_is_inferred_and_gets_its_own_expiry(self):
        # merge_profile keeps a stated profile over research, so the research mapping is exercised directly.
        with self.cursor() as cur:
            self.lifecycle.upsert_profile_interest(cur, self.survey_row(
                source_kind="research", source_id=f"research_run:{self.tag}", observed_on="2026-11-06",
                spec={"formats": ["Cells"], "chemistries": ["NMC"]}), "researched")
        self.conn.commit()
        [line] = self.lines("inferred")
        self.assertEqual(line["product_key"], "broad:nmc-cells")
        self.assertEqual(str(line["expires_on"]), "2027-05-05")   # inferred: first seen + 180 days

    def test_a_survey_answer_with_quantity_and_timing_becomes_an_ask_through_the_trigger(self):
        row = self.survey_row(
            kind="request", basis=None, wants="Polestar 2 packs", quantity="4 packs", volume=4, volume_unit="packs",
            needed_by="2026-12-20", observed_on="2026-11-10", source_kind="survey", source_id=f"typeform:{self.tag}",
            spec={"formats": ["Packs"], "makes": ["Polestar"], "model": "2", "chemistries": ["NMC"], "kwh_min": 78, "kwh_max": 78})
        with self.conn.cursor(cursor_factory=__import__("psycopg2.extras", fromlist=["RealDictCursor"]).RealDictCursor) as cur:
            self.assertTrue(self.survey.insert(cur, row))
        self.conn.commit()
        [line] = self.lines("ask")
        self.assertEqual(line["ownership"], "synced")
        self.assertEqual(line["product_key"], "model:polestar-2-78kwh")
        self.assertEqual(float(line["quantity"]), 4)
        self.assertEqual(str(line["expires_on"]), "2026-12-20")
        self.assertEqual(line["source_refs"], [f"typeform:{self.tag}", f"crm:{line['demand_id']}"])

    def test_a_saved_search_is_open_while_active_and_expires_when_unsubscribed(self):
        search = self.saved.map_saved_search(self.saved_search(filters={"manufacturer": ["Tesla"], "chemistry": "nmc", "format": ["pack"]}))
        search["company_id"] = self.company
        with self.cursor() as cur:
            self.lifecycle.upsert_saved_search_interest(cur, search, today=dt.date(2026, 11, 12))
        self.conn.commit()
        [line] = self.lines("saved_search")
        self.assertEqual(line["product_key"], "broad:nmc-packs")
        self.assertEqual(str(line["first_seen"]), "2026-11-07")
        self.assertEqual(str(line["last_seen"]), "2026-11-12")
        self.assertIsNone(line["expires_on"])
        self.assertEqual(line["saved_search_id"], "8d0f6c1e-0000-4000-8000-000000000001")
        self.assertEqual(line["source_refs"], ["saved_search:8d0f6c1e-0000-4000-8000-000000000001"])

        with self.cursor() as cur:
            self.lifecycle.upsert_saved_search_interest(cur, search, unsubscribed=True, today=dt.date(2026, 11, 30))
        self.conn.commit()
        [line] = self.lines("saved_search")
        self.assertEqual(str(line["last_seen"]), "2026-11-30")
        self.assertEqual(str(line["expires_on"]), "2026-11-30")

    def test_running_an_importer_twice_writes_one_line(self):
        search = self.saved.map_saved_search(self.saved_search(filters={"chemistry": "lfp", "format": ["pack"]}))
        search["company_id"] = self.company
        for _ in range(2):
            with self.cursor() as cur:
                self.lifecycle.upsert_saved_search_interest(cur, search, today=dt.date(2026, 11, 12))
            self.conn.commit()
        matching = [line for line in self.lines("saved_search") if line["product_key"] == "broad:lfp-packs"]
        self.assertEqual(len(matching), 1)

    def test_a_line_that_cannot_be_written_does_not_abort_the_importer(self):
        # A negative price breaks a table check: the line is dropped, the importer's transaction survives.
        facts = {"formats": ["Packs"], "chemistries": ["LFP"]}
        with self.cursor() as cur:
            self.assertIsNone(self.lifecycle.upsert_interest(
                cur, company_id=self.company, kind="interest", facts=facts, first_seen="2026-11-01", last_seen="2026-11-01",
                price=-1, price_currency="EUR", price_unit="kWh"))
            # The transaction is still usable: the savepoint was rolled back, not the importer's work.
            cur.execute("select 1 as ok")
            self.assertEqual(cur.fetchone()["ok"], 1)
        self.conn.rollback()

    def saved_search(self, **over):
        base = {
            "id": "8d0f6c1e-0000-4000-8000-000000000001", "email": self.email, "label": "NMC packs",
            "catalog_path": "/marketplace/listings?chemistry=nmc", "frequency": "daily", "status": "active",
            "confirmed_at": "2026-11-07T06:00:00+00:00", "unsubscribed_at": None, "filters": {},
        }
        base.update(over)
        return base


if __name__ == "__main__":
    unittest.main()
