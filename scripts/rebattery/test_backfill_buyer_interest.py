"""The buyer interest backfill, on the disposable CRM database.

Set BULK_TRADES_TEST_DATABASE_URL (scripts/rebattery/crm-test-db.sh up prints the URL) to run; skipped otherwise.
"""
import contextlib
import importlib.util
import io
import json
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

    def test_the_server_reported_name_decides_not_the_dsn(self):
        refuse = self.backfill.refusal_for_database
        self.assertIsNotNone(refuse("denchclaw", False))
        self.assertIsNotNone(refuse("DenchClaw", False))
        self.assertIsNone(refuse("denchclaw", True))
        self.assertIsNone(refuse("denchclaw_rehearsal", False))


class ConnectionGuard(unittest.TestCase):
    """The disposable test database is also called denchclaw, on a port the DSN check does not call production."""

    @classmethod
    def setUpClass(cls):
        import os
        cls.dsn = os.environ.get("BULK_TRADES_TEST_DATABASE_URL")
        if not cls.dsn:
            raise unittest.SkipTest("needs the disposable CRM database (BULK_TRADES_TEST_DATABASE_URL)")
        cls.backfill = load("backfill_buyer_interest")

    def test_apply_to_a_database_named_denchclaw_is_refused_on_any_host(self):
        self.assertFalse(self.backfill.is_production_dsn(self.dsn))  # the DSN looks harmless
        out, err = io.StringIO(), io.StringIO()
        with self.assertRaises(SystemExit) as raised, contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            self.backfill.main(["--apply", "--dsn", self.dsn])
        self.assertEqual(raised.exception.code, 2)
        self.assertIn("denchclaw", out.getvalue())          # host and database are printed before anything is written
        self.assertIn("127.0.0.1", out.getvalue())
        self.assertIn("--i-have-approval", err.getvalue())
        self.assertNotIn("batch", out.getvalue())           # no batch ran

    def test_a_dry_run_on_a_database_named_denchclaw_is_refused_without_approval(self):
        out, err = io.StringIO(), io.StringIO()
        with self.assertRaises(SystemExit) as raised, contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            self.backfill.main(["--dsn", self.dsn])
        self.assertEqual(raised.exception.code, 2)
        self.assertIn("--i-have-approval", err.getvalue())
        self.assertNotIn("batch", out.getvalue())

    def test_the_default_database_is_refused_for_a_dry_run_too(self):
        with self.assertRaises(SystemExit) as raised, contextlib.redirect_stderr(io.StringIO()):
            self.backfill.main([])
        self.assertEqual(raised.exception.code, 2)

    def test_an_approved_dry_run_runs_and_writes_nothing(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(self.backfill.main(["--dsn", self.dsn, "--i-have-approval"]), 0)
        self.assertIn("dry run", out.getvalue())


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
            for sql, params in (
                ("delete from buyer_interest where company_id = any(%s)", ([cls.company, cls.dossier_company],)),
                ("delete from buyer_interest_sync_errors where source_id like %s", (f"%{cls.tag}%",)),
                ("delete from crm_bulk_offers where company_id = any(%s)", ([cls.company, cls.dossier_company],)),
                ("delete from crm_bulk_listings where company_id = any(%s)", ([cls.company, cls.dossier_company],)),
                ("delete from crm_people where id = %s", (cls.person,)),
                ("delete from crm_companies where id = any(%s)", ([cls.company, cls.dossier_company],)),
            ):
                cur.execute("savepoint test_cleanup")
                try:
                    cur.execute(sql, params)
                    cur.execute("release savepoint test_cleanup")
                except Exception:  # noqa: BLE001
                    # A retired Bulk Trades table refuses the cascade on rows it still references. That is the
                    # database's rule, not a failed test: the fixture rows are left for the disposable copy.
                    cur.execute("rollback to savepoint test_cleanup")
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

    def test_a_dry_run_rolls_back_every_batch_and_holds_no_transaction(self):
        ids = [self.demand_row(spec={"makes": ["Tesla"], "chemistries": ["NMC"], "formats": ["Packs"]}) for _ in range(3)]
        summary = self.backfill.run(self.conn, apply_writes=False, batch_size=1)
        demand = [b for b in summary["batches"] if b["batch"].startswith("demand-")]
        self.assertGreaterEqual(len(demand), 3)                     # one batch per row
        self.assertTrue(all(b["lines_after"] >= b["lines_before"] for b in demand))
        self.assertGreaterEqual(sum(b["lines_after"] - b["lines_before"] for b in demand), 3)
        import psycopg2.extensions
        self.assertEqual(self.conn.info.transaction_status, psycopg2.extensions.TRANSACTION_STATUS_IDLE)
        self.assertEqual(self.lines(), [])                           # nothing written
        self.assertFalse(summary["apply"])
        self.assertEqual(len(ids), 3)

    def test_a_dry_run_between_batches_leaves_the_source_row_free_for_a_writer(self):
        # A writer on the demand row never waits for the whole run: after each batch the lock is gone.
        import psycopg2
        row_id = self.demand_row(spec={"makes": ["Tesla"], "formats": ["Packs"]})
        other = psycopg2.connect(__import__("os").environ["BULK_TRADES_TEST_DATABASE_URL"])
        try:
            original = self.backfill._batch

            def checking(cur, name, *args, **kwargs):
                result = original(cur, name, *args, **kwargs)
                with other.cursor() as probe:
                    probe.execute("select pg_try_advisory_xact_lock(hashtext(%s))", ("demand:" + row_id,))
                    self.assertTrue(probe.fetchone()[0], f"batch {name} left the lock held")
                other.rollback()
                return result
            self.backfill._batch = checking
            try:
                self.backfill.run(self.conn, apply_writes=False, batch_size=1)
            finally:
                self.backfill._batch = original
        finally:
            other.close()

    def test_a_row_that_hits_the_lock_timeout_is_retried_once_then_recorded_and_the_run_continues(self):
        import psycopg2
        import threading
        import time
        locked = self.demand_row(spec={"makes": ["Tesla"], "chemistries": ["NMC"], "formats": ["Packs"]})
        free = self.demand_row(spec={"makes": ["Nissan"], "chemistries": ["NMC"], "formats": ["Packs"]})
        holder = psycopg2.connect(__import__("os").environ["BULK_TRADES_TEST_DATABASE_URL"])
        old = self.backfill.LOCK_TIMEOUT
        self.backfill.LOCK_TIMEOUT = "300ms"
        with self.cursor() as cur:
            self.backfill._set_timeouts(cur)
        self.conn.commit()
        try:
            with holder.cursor() as hold:
                hold.execute("select pg_advisory_xact_lock(hashtext(%s))", ("demand:" + locked,))
            result = self.sync([locked, free])
            self.assertEqual(result["timeouts"], 1)
            self.assertEqual(result["errors"], 1)
            self.assertEqual(result["synced"], 1)
            self.assertEqual([line["product_key"] for line in self.lines()], ["broad:nissan-nmc-packs"])
            with self.cursor() as cur:
                cur.execute("select operation from buyer_interest_sync_errors where source_id = %s", (locked,))
                self.assertEqual(cur.fetchone()["operation"], "backfill_timeout")
            self.conn.commit()

            # Freed between the first attempt and the retry: the row syncs, nothing is recorded.
            threading.Timer(0.45, holder.rollback).start()
            started = time.time()
            result = self.sync([locked])
            self.assertGreater(time.time() - started, 0.3)           # the first attempt did wait and time out
            self.assertEqual((result["synced"], result["errors"]), (1, 0))
            self.assertEqual(len(self.lines()), 2)
        finally:
            self.backfill.LOCK_TIMEOUT = old
            with self.cursor() as cur:
                cur.execute("reset lock_timeout")
                cur.execute("reset statement_timeout")
            self.conn.commit()
            holder.rollback()
            holder.close()

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

    def write_dossier(self, products_status=None, markdown=None):
        """The 10 pilot buyers, as the backfill sees them: a company whose buyer_dossier holds frontmatter."""
        markdown = markdown or self.DOSSIER.format(company=self.dossier_company, tag=self.tag)
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
            ("standing", "broad:bmw-any-packs"),
            ("standing", "broad:volvo-any-packs"),
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


    # --- keys the sources must not invent ----------------------------------
    def test_a_compound_make_becomes_one_line_per_make(self):
        row_id = self.demand_row(spec={"makes": ["MG, Stellantis, Tesla"], "chemistries": ["LFP"], "formats": ["Packs"]})
        self.sync([row_id])
        self.assertEqual([line["product_key"] for line in self.lines()], [
            "broad:mg-lfp-packs", "broad:stellantis-lfp-packs", "broad:tesla-lfp-packs"])

    def test_a_row_that_states_no_product_gets_a_note_instead_of_a_line(self):
        # A quantity and nothing else: the row names no product, so it is history without a want.
        row_id = self.demand_row(status="closed", closed_reason="bought_elsewhere",
                                 spec={"volume": 2, "volume_unit": "packs"})
        self.sync([row_id])
        self.assertEqual(self.lines(), [])
        with self.cursor() as cur:
            cur.execute("select operation, message from buyer_interest_sync_errors where source_id = %s", (row_id,))
            notes = cur.fetchall() or []
        self.assertEqual([note["operation"] for note in notes], ["no_product_facts"])
        self.assertIn("no product fact", notes[0]["message"])
        # A re-run rewrites the note rather than piling it up.
        self.sync([row_id])
        with self.cursor() as cur:
            cur.execute("select count(*) as n from buyer_interest_sync_errors where source_id = %s", (row_id,))
            self.assertEqual(cur.fetchone()["n"], 1)
        # A row that later states a product keeps the line and loses the complaint.
        with self.cursor() as cur:
            cur.execute("""update crm_bulk_listings set spec = '{"makes": ["Tesla"], "formats": ["Packs"]}'::jsonb
                            where id = %s""", (row_id,))
            cur.execute("select buyer_interest_sync_demand_row(%s)", (row_id,))
        self.conn.commit()
        self.assertEqual([line["product_key"] for line in self.lines()], ["broad:tesla-any-packs"])
        with self.cursor() as cur:
            cur.execute("select count(*) as n from buyer_interest_sync_errors where source_id = %s", (row_id,))
            self.assertEqual(cur.fetchone()["n"], 0)

    def test_an_offer_whose_listing_states_no_product_gets_a_note_instead_of_a_line(self):
        listing_id = f"btl_backfill_{uuid.uuid4().hex[:12]}_{self.tag}"
        offer_id = f"bto_backfill_{uuid.uuid4().hex[:12]}_{self.tag}"
        with self.cursor() as cur:
            cur.execute("""insert into crm_bulk_listings (id, kind, party, company_id, summary, status, observed_on, quantity)
                           values (%s, 'supply', 'Supply lot', %s, 'a lot that names no product', 'open', '2026-10-01',
                             '40 packs')""", (listing_id, self.company))
            cur.execute("""insert into crm_bulk_offers (id, bulk_listing_id, role, company_id, name, stage, terms)
                           values (%s, %s, 'counterparty', %s, 'Offer Buyer', 'paid', '{"amount": 100}'::jsonb)""",
                        (offer_id, listing_id, self.company))
        self.conn.commit()
        self.sync([offer_id], source_table="crm_bulk_offers")
        self.assertEqual(self.lines(), [])
        with self.cursor() as cur:
            cur.execute("""select source_table, message from buyer_interest_sync_errors
                            where source_id = %s and operation = 'no_product_facts'""", (offer_id,))
            notes = cur.fetchall() or []
        self.assertEqual(len(notes), 1)
        note = notes[0]
        self.assertEqual(note["source_table"], "crm_bulk_offers")
        self.assertIn(listing_id, note["message"])

    def test_a_dossier_prose_model_keeps_its_wording_out_of_the_key(self):
        self.write_dossier(markdown="""---
company_id: "{company}"
company: "Dossier Test Buyer"
last_verified: "2026-11-04"
products:
  - make: "VW Group"
    model: "82 kWh: ID.4, Q4 e-tron, Enyaq, ID.7, Elroq"
    format: packs
    chemistry: NMC
    kwh: [82]
    status: "asked"
    seen: "2026-10-07"
---
The story.
""".format(company=self.dossier_company))
        self.convert()
        [line] = self.lines(self.dossier_company)
        self.assertEqual(line["product_key"], "broad:vw-group-nmc-packs")
        self.assertEqual(line["raw_product"], "82 kWh: ID.4, Q4 e-tron, Enyaq, ID.7, Elroq")
        self.assertEqual(line["model"], "82 kWh: ID.4, Q4 e-tron, Enyaq, ID.7, Elroq")

    def test_a_product_name_in_part_number_is_not_a_part_key(self):
        self.write_dossier(markdown="""---
company_id: "{company}"
company: "Dossier Test Buyer"
last_verified: "2026-11-04"
products:
  - make: "Proterra"
    part_number: "Onyx Strata H4-15"
    format: packs
    status: "declined"
    seen: "2026-07-02"
---
The story.
""".format(company=self.dossier_company))
        self.convert()
        [line] = self.lines(self.dossier_company)
        self.assertEqual(line["product_key"], "broad:proterra-any-packs")
        self.assertEqual(line["product_key_level"], "broad")
        self.assertEqual(line["raw_product"], "Onyx Strata H4-15")
        self.assertEqual(line["model"], "Onyx Strata H4-15")

    # --- (e) buy-box coverage ---------------------------------------------
    def buy_box_company(self, profile):
        """Its own company: a buy box is chosen by the absence of rows, so no leftover from another test may join in."""
        company = f"co_buybox_{uuid.uuid4().hex[:8]}_{self.tag}"
        with self.cursor() as cur:
            cur.execute("""insert into crm_companies (id, name, buyer_profile, buyer_profiled_at)
                           values (%s, 'Buy-box Test Buyer', %s::jsonb, '2026-10-05')""",
                        (company, json.dumps(profile)))
        self.conn.commit()
        return company

    def drop_company(self, company):
        """Emptied, not deleted: a retired Bulk Trades table rejects the cascade on crm_companies in this database."""
        with self.cursor() as cur:
            cur.execute("delete from buyer_interest where company_id = %s", (company,))
            cur.execute("delete from buyer_interest_sync_errors where source_id = %s", (company,))
            cur.execute("""update crm_companies set buyer_profile = '{}'::jsonb, buyer_profiled_at = null
                            where id = %s""", (company,))
        self.conn.commit()

    def test_a_buy_box_with_no_source_row_becomes_an_inferred_line(self):
        company = self.buy_box_company({"makes": ["Tesla"], "formats": ["Packs"]})
        try:
            with self.cursor() as cur:
                rows = [row for row in self.backfill.buy_box_rows(cur) if row["id"] == company]
                self.assertEqual(len(rows), 1)
                result = self.backfill.sync_buy_box_rows(cur, rows)
            self.conn.commit()
            self.assertEqual(result["written"], 1, result)
            [line] = self.lines(company)
            self.assertEqual(line["kind"], "inferred")
            self.assertEqual(line["ownership"], "mastered")
            self.assertEqual(line["product_key"], "broad:tesla-any-packs")
            self.assertEqual(str(line["first_seen"]), "2026-10-05")
            self.assertEqual(str(line["expires_on"]), "2027-04-03")  # inferred: first seen + 180 days
            self.assertIn("crm:buyer_profile", line["source_refs"])
        finally:
            self.drop_company(company)

    def test_a_buy_box_that_states_no_product_is_recorded_not_invented(self):
        company = self.buy_box_company({"wants": "All listings"})
        try:
            with self.cursor() as cur:
                rows = [row for row in self.backfill.buy_box_rows(cur) if row["id"] == company]
                result = self.backfill.sync_buy_box_rows(cur, rows)
            self.conn.commit()
            self.assertEqual(result["skipped"], 1, result)
            self.assertEqual(self.lines(company), [])
            with self.cursor() as cur:
                cur.execute("""select message from buyer_interest_sync_errors
                                where source_id = %s and operation = 'no_product_facts'""", (company,))
                note = cur.fetchone() or {}
            self.assertIn("buy box", note.get("message") or "")
        finally:
            self.drop_company(company)


if __name__ == "__main__":
    unittest.main()
