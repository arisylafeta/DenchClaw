"""The buyer interest backfill, on the disposable CRM database.

Set BULK_TRADES_TEST_DATABASE_URL (scripts/rebattery/crm-test-db.sh up prints the URL) to run; skipped otherwise.
"""
import contextlib
import importlib.util
import io
import unittest
import uuid
from pathlib import Path

DEFAULT_DSN = "host=/var/run/postgresql dbname=denchclaw"


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parent / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ProductionGuard(unittest.TestCase):
    """The guard is pure: it never opens a connection."""

    @classmethod
    def setUpClass(cls):
        cls.backfill = load("backfill_buyer_interest")

    def test_the_live_socket_database_is_production(self):
        self.assertTrue(self.backfill.is_production_dsn(DEFAULT_DSN))
        self.assertTrue(self.backfill.is_production_dsn("dbname=denchclaw"))
        self.assertTrue(self.backfill.is_production_dsn("postgres://crm@127.0.0.1:5432/denchclaw"))

    def test_a_disposable_copy_is_not_production(self):
        self.assertFalse(self.backfill.is_production_dsn("postgres://postgres:test@127.0.0.1:55442/denchclaw"))
        self.assertFalse(self.backfill.is_production_dsn("postgres://postgres:test@127.0.0.1:5432/denchclaw_copy"))

    def test_apply_needs_an_explicit_dsn(self):
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            self.backfill.main(["--apply"])

    def test_apply_refuses_production_without_approval(self):
        # argparse refuses before connecting, so nothing reaches the live database.
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            self.backfill.main(["--apply", "--dsn", DEFAULT_DSN])


class Backfill(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import os
        import psycopg2
        import psycopg2.extras
        dsn = os.environ.get("BULK_TRADES_TEST_DATABASE_URL")
        if not dsn:
            raise unittest.SkipTest("needs the disposable CRM database (BULK_TRADES_TEST_DATABASE_URL)")
        cls.backfill = load("backfill_buyer_interest")
        cls.conn = psycopg2.connect(dsn)
        cls.conn.autocommit = False
        cls.tag = uuid.uuid4().hex[:8]
        cls.company = f"co_backfill_{cls.tag}"
        cls.dossier_company = f"co_backfill_dossier_{cls.tag}"
        cls.person = f"p_backfill_{cls.tag}"
        cls.rows = []
        with cls.conn.cursor() as cur:
            cur.execute("insert into crm_companies (id, name) values (%s, %s)", (cls.company, "Backfill Test Buyer"))
            cur.execute("insert into crm_people (id, full_name, email, company_id) values (%s, %s, %s, %s)",
                        (cls.person, "Backfill Buyer", f"backfill-{cls.tag}@example.test", cls.company))
        cls.conn.commit()

    @classmethod
    def tearDownClass(cls):
        with cls.conn.cursor() as cur:
            cur.execute("delete from buyer_interest where company_id = any(%s)", ([cls.company, cls.dossier_company],))
            cur.execute("delete from buyer_interest_sync_errors where source_id like %s", (f"%{cls.tag}%",))
            cur.execute("delete from crm_bulk_offers where company_id = any(%s)", ([cls.company, cls.dossier_company],))
            cur.execute("delete from crm_bulk_listings where company_id = any(%s)", ([cls.company, cls.dossier_company],))
            cur.execute("delete from crm_people where id = %s", (cls.person,))
            cur.execute("delete from crm_companies where id = any(%s)", ([cls.company, cls.dossier_company],))
        cls.conn.commit()
        cls.conn.close()

    def setUp(self):
        """Each test starts from no lines for its own companies, whatever an earlier one wrote."""
        with self.cursor() as cur:
            cur.execute("delete from buyer_interest where company_id = any(%s)",
                        ([self.company, self.dossier_company],))
        self.conn.commit()

    # --- helpers -----------------------------------------------------------
    def cursor(self):
        import psycopg2.extras
        return self.conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    def demand_row(self, company=None, *, status="open", closed_reason=None, spec=None, observed_on="2026-10-01",
                   source_kind="email"):
        """A demand row written the normal way, then stripped of its trigger line: a pre-migration row."""
        row_id = f"btd_backfill_{uuid.uuid4().hex[:12]}"
        with self.cursor() as cur:
            cur.execute("""insert into crm_bulk_listings (id, kind, party, summary, status, closed_reason,
                             company_id, person_id, spec, context, observed_on, source_kind, source_id)
                           values (%s, 'demand', 'Backfill Test Buyer', 'backfill test row', %s, %s,
                             %s, %s, %s::jsonb, '{}'::jsonb, %s::date, %s, %s)""",
                        (row_id, status, closed_reason, company or self.company, self.person,
                         __import__("json").dumps(spec or {}), observed_on, source_kind, f"src:{self.tag}:{row_id}"))
            cur.execute("delete from buyer_interest where demand_id = %s", (row_id,))
        self.conn.commit()
        return row_id

    def lines(self, company=None, kind=None):
        sql = "select * from buyer_interest where company_id = %s"
        params = [company or self.company]
        if kind:
            sql += " and kind = %s"
            params.append(kind)
        with self.cursor() as cur:
            cur.execute(sql + " order by kind, product_key", params)
            return cur.fetchall()

    def sync(self, ids, apply_writes=True, source_table="crm_bulk_listings"):
        with self.cursor() as cur:
            if apply_writes:
                result = self.backfill.sync_source_rows(cur, source_table, ids)
                self.conn.commit()
                return result
            cur.execute("savepoint t")
            result = self.backfill.sync_source_rows(cur, source_table, ids)
            cur.execute("rollback to savepoint t")
            self.conn.rollback()
            return result

    # --- (a) demand rows ---------------------------------------------------
    def test_a_dry_run_writes_nothing(self):
        row_id = self.demand_row(spec={"makes": ["Tesla"], "chemistries": ["NMC"], "formats": ["Packs"]})
        result = self.sync([row_id], apply_writes=False)
        self.assertEqual(result["synced"], 1)
        self.assertEqual(self.lines(), [])

    def test_apply_writes_the_line_the_trigger_would(self):
        row_id = self.demand_row(spec={"makes": ["Tesla"], "chemistries": ["NMC"], "formats": ["Packs"],
                                       "volume": 4, "volume_unit": "packs", "needed_by": "2026-11-30"})
        self.sync([row_id])
        [line] = self.lines()
        self.assertEqual(line["kind"], "ask")
        self.assertEqual(line["ownership"], "synced")
        self.assertEqual(line["product_key"], "broad:tesla-nmc-packs")
        self.assertEqual(float(line["quantity"]), 4)
        self.assertEqual(str(line["expires_on"]), "2026-11-30")  # an open ask expires on the day it is needed by
        self.assertEqual(line["demand_id"], row_id)

    def test_a_closed_purchase_is_a_bought_line(self):
        row_id = self.demand_row(status="closed", closed_reason="bought_from_us",
                                 spec={"makes": ["VW Group"], "formats": ["Packs"]})
        self.sync([row_id])
        [line] = self.lines()
        self.assertEqual(line["kind"], "bought")
        self.assertIsNone(line["expires_on"])

    def test_running_twice_keeps_one_line_each(self):
        row_id = self.demand_row(spec={"makes": ["Stellantis"], "chemistries": ["LFP"], "formats": ["Packs"]})
        self.sync([row_id])
        first = [(line["kind"], line["product_key"]) for line in self.lines()]
        self.sync([row_id])
        self.assertEqual([(line["kind"], line["product_key"]) for line in self.lines()], first)

    def test_a_row_that_cannot_be_written_is_recorded_and_the_batch_continues(self):
        bad = self.demand_row(spec={"makes": ["Tesla"], "formats": ["Packs"], "kwh_min": -5})
        good = self.demand_row(spec={"makes": ["Nissan"], "chemistries": ["NMC"], "formats": ["Packs"]})
        result = self.sync([bad, good])
        self.assertEqual(result["errors"], 1)
        self.assertEqual(result["synced"], 1)
        self.assertEqual([line["product_key"] for line in self.lines()], ["broad:nissan-nmc-packs"])
        with self.cursor() as cur:
            cur.execute("select message from buyer_interest_sync_errors where source_id = %s", (bad,))
            self.assertTrue(cur.fetchone()["message"])

    # --- (b) the profile path ---------------------------------------------
    def test_a_researched_row_becomes_an_inferred_line_from_its_observation_date(self):
        row_id = self.demand_row(status="closed", closed_reason="research_profile", observed_on="2026-09-04",
                                 source_kind="research",
                                 spec={"basis": "estimated", "formats": ["Cells"], "chemistries": ["NMC"]})
        with self.cursor() as cur:
            rows = self.backfill.profile_rows(cur, [row_id])
            result = self.backfill.sync_profile_rows(cur, rows)
        self.conn.commit()
        self.assertEqual(result["written"], 1)
        [line] = self.lines()
        self.assertEqual(line["kind"], "inferred")
        self.assertEqual(line["ownership"], "mastered")
        self.assertEqual(line["product_key"], "broad:nmc-cells")
        self.assertEqual(str(line["first_seen"]), "2026-09-04")
        self.assertEqual(str(line["expires_on"]), "2027-03-03")  # inferred: first seen + 180 days

    def test_a_stated_row_becomes_a_standing_line(self):
        row_id = self.demand_row(status="closed", closed_reason="moved_to_profile", observed_on="2026-08-20",
                                 spec={"basis": "stated", "makes": ["BYD"], "formats": ["Packs"], "volume": 200,
                                       "volume_unit": "packs"})
        with self.cursor() as cur:
            result = self.backfill.sync_profile_rows(cur, self.backfill.profile_rows(cur, [row_id]))
        self.conn.commit()
        self.assertEqual(result["written"], 1)
        [line] = self.lines()
        self.assertEqual(line["kind"], "standing")
        self.assertEqual(line["product_key"], "broad:byd-any-packs")
        self.assertEqual(float(line["quantity"]), 200)

    def test_a_buy_box_with_no_product_facts_is_not_invented(self):
        with self.cursor() as cur:
            cur.execute("""update crm_companies set buyer_profile = %s::jsonb where id = %s""",
                        ('{"wants": "All listings"}', self.company))
        self.conn.commit()
        try:
            row_id = self.demand_row(status="closed", closed_reason="research_profile",
                                     spec={"basis": "estimated", "confirmed_on": "2026-10-01"})
            with self.cursor() as cur:
                result = self.backfill.sync_profile_rows(cur, self.backfill.profile_rows(cur, [row_id]))
            self.conn.commit()
            self.assertEqual(result["skipped"], 1)
            self.assertEqual(self.lines(), [])
        finally:
            with self.cursor() as cur:
                cur.execute("update crm_companies set buyer_profile = '{}'::jsonb where id = %s", (self.company,))
            self.conn.commit()

    # --- (d) the pilot dossiers -------------------------------------------
    DOSSIER = """---
company_id: "{company}"
company: "Dossier Test Buyer"
buyer_type: "trader"
last_verified: "2026-11-04"
products:
  - make: "VW Group"
    format: "packs"
    status: "asked"
    seen: "2026-10-07"
    src: "gmail_msg_{tag}"
  - make: "Stellantis"
    chemistry: "NMC"
    format: "cells"
    status: "said_interested"
    seen: "2026-10-07"
  - part_number: "SU001B5189"
    status: "declined"
    seen: "2026-09-26"
  - part_number: "EBS37"
    status: "bought"
    seen: "2026-09-23"
  - make: "BMW / Volvo"
    format: "packs"
    status: "asked"
    seen: "2026-11-11"
---
The story, unchanged by this step.
"""

    def write_dossier(self, products_status=None):
        """The 10 pilot buyers, as the backfill sees them: a company whose buyer_dossier holds frontmatter."""
        markdown = self.DOSSIER.format(company=self.dossier_company, tag=self.tag)
        if products_status:
            markdown = markdown.replace('status: "asked"', f'status: "{products_status}"', 1)
        with self.cursor() as cur:
            cur.execute("set local crm.dossier_write = 'on'")  # the dossier guard only lets the write path in
            cur.execute("""insert into crm_companies (id, name, buyer_dossier) values (%s, %s, %s)
                           on conflict (id) do update set buyer_dossier = excluded.buyer_dossier""",
                        (self.dossier_company, "Dossier Test Buyer", markdown))
        self.conn.commit()
        return markdown

    def convert(self):
        with self.cursor() as cur:
            result = self.backfill.sync_dossier_rows(cur, self.backfill.dossier_rows(cur))
        self.conn.commit()
        return result

    def test_dossier_products_map_status_to_kind_and_keep_seen(self):
        self.write_dossier()
        self.convert()
        lines = self.lines(self.dossier_company)
        self.assertEqual(sorted((line["kind"], line["product_key"]) for line in lines), [
            ("bought", "part:EBS37"),
            ("declined", "part:SU001B5189"),
            ("interest", "broad:stellantis-nmc-cells"),
            ("standing", "broad:bmw-volvo-any-packs"),
            ("standing", "broad:vw-group-any-packs"),
        ])
        line = next(line for line in lines if line["product_key"] == "part:EBS37")
        self.assertEqual(line["ownership"], "synced")
        self.assertEqual(str(line["first_seen"]), "2026-09-23")
        self.assertEqual(str(line["last_seen"]), "2026-09-23")

    def test_the_dossier_text_is_not_rewritten(self):
        markdown = self.write_dossier()
        self.convert()
        with self.cursor() as cur:
            cur.execute("select buyer_dossier from crm_companies where id = %s", (self.dossier_company,))
            self.assertEqual(cur.fetchone()["buyer_dossier"], markdown)

    def test_a_purchase_the_offers_already_say_is_not_repeated(self):
        self.write_dossier()
        # A demand row closed as bought from us already owns the same fact.
        with self.cursor() as cur:
            cur.execute("""insert into crm_bulk_listings (id, kind, party, summary, status, closed_reason,
                             company_id, spec, observed_on, source_kind)
                           values (%s, 'demand', 'Dossier Test Buyer', 'a pack we sold them', 'closed',
                             'bought_from_us', %s, %s::jsonb, '2026-09-23', 'email')""",
                        (f"btd_backfill_{uuid.uuid4().hex[:12]}", self.dossier_company,
                         '{"part_numbers": ["EBS37"]}'))
        self.conn.commit()
        # The trigger already wrote the purchase from that row.
        [source_line] = self.lines(self.dossier_company, "bought")
        self.assertIsNotNone(source_line["demand_id"])
        result = self.convert()
        self.assertEqual(result["already_from_source"], 1)
        bought = self.lines(self.dossier_company, "bought")
        self.assertEqual(len(bought), 1)
        self.assertIsNotNone(bought[0]["demand_id"])

    def test_converting_twice_keeps_one_line_per_product(self):
        self.write_dossier()
        self.convert()
        first = sorted((line["kind"], line["product_key"], line["id"]) for line in self.lines(self.dossier_company))
        self.convert()
        self.assertEqual(sorted((line["kind"], line["product_key"], line["id"])
                                for line in self.lines(self.dossier_company)), first)

    def test_a_dossier_buyer_gets_no_line_from_a_research_row(self):
        self.write_dossier()
        row_id = self.demand_row(company=self.dossier_company, status="closed", closed_reason="research_profile",
                                 source_kind="research",
                                 spec={"basis": "estimated", "makes": ["Nissan"], "formats": ["Packs"]})
        with self.cursor() as cur:
            result = self.backfill.sync_profile_rows(cur, self.backfill.profile_rows(cur, [row_id]))
        self.conn.commit()
        self.assertEqual(result["dossier_skipped"], 1)
        self.assertEqual(self.lines(self.dossier_company), [])

    # --- (c) saved searches ------------------------------------------------
    def test_a_saved_search_note_becomes_a_line(self):
        with self.cursor() as cur:
            cur.execute("""insert into crm_company_context_notes (id, company_id, note, category, source_kind,
                             source_ref, observed_on)
                           values (%s, %s, %s, 'saved_search', 'saved_search', %s, '2026-10-14')""",
                        (f"ccn_savedsearch_{self.tag}", self.company, "NMC packs - Makes: Tesla - Chemistries: NMC - "
                         "Formats: Packs", f"saved_search:{self.tag}"))
        self.conn.commit()
        try:
            with self.cursor() as cur:
                rows = [row for row in self.backfill.saved_search_rows(cur) if row["id"] == f"ccn_savedsearch_{self.tag}"]
                result = self.backfill.sync_saved_search_rows(cur, rows)
            self.conn.commit()
            self.assertEqual(result["written"], 1)
            [line] = self.lines(kind="saved_search")
            self.assertEqual(line["product_key"], "broad:tesla-nmc-packs")
            self.assertEqual(line["saved_search_id"], self.tag)
            self.assertIsNone(line["expires_on"])  # active: nothing here says otherwise
            self.assertEqual(str(line["first_seen"]), "2026-10-14")
        finally:
            with self.cursor() as cur:
                cur.execute("delete from crm_company_context_notes where id = %s", (f"ccn_savedsearch_{self.tag}",))
            self.conn.commit()


if __name__ == "__main__":
    unittest.main()
