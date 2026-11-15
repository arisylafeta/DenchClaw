"""The buyer_interest date correction and the expiry report.

The planning rules are pure and always run. The database tests need the disposable CRM database: set
BULK_TRADES_TEST_DATABASE_URL (scripts/rebattery/crm-test-db.sh up prints the URL); they are skipped otherwise.
"""
import contextlib
import datetime as dt
import importlib.util
import io
import json
import os
import tempfile
import unittest
import uuid
from pathlib import Path


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parent / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


D = dt.date.fromisoformat


def line(kind="inferred", first="2026-11-13", last=None, expires=None, created="2026-11-13", demand=None,
         change=None, profiled=None):
    last = last or first
    if expires is None:
        expires = str(D(last) + dt.timedelta(days=180 if kind != "standing" else 90))
    return {"id": f"bi_{uuid.uuid4().hex[:8]}", "company_id": "co_x", "kind": kind, "first_seen": D(first),
            "last_seen": D(last), "expires_on": D(expires) if expires else None, "created_on": D(created),
            "demand_date": D(demand) if demand else None, "demand_ref": None,
            "change_date": D(change) if change else None, "profiled_date": D(profiled) if profiled else None}


class PlanRules(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fix = load("fix_interest_dates")

    def plan(self, **kwargs):
        return self.fix.plan_line(line(**kwargs))

    def test_the_demand_row_date_wins_and_expiry_follows_the_new_last_seen(self):
        update, _ = self.plan(demand="2026-09-04", change="2026-10-01", profiled="2026-10-02")
        self.assertEqual((update["new_first"], update["new_last"]), (D("2026-09-04"), D("2026-09-04")))
        self.assertEqual(update["new_expires"], D("2027-03-03"))  # inferred: + 180 days
        self.assertEqual(update["source"], "demand observed_on")

    def test_without_a_demand_row_the_earliest_profile_change_then_the_profile_date_is_used(self):
        update, _ = self.plan(change="2026-10-01", profiled="2026-09-01")
        self.assertEqual((update["new_first"], update["source"]), (D("2026-10-01"), "earliest buyer_profile change"))
        update, _ = self.plan(profiled="2026-09-01")
        self.assertEqual((update["new_first"], update["source"]), (D("2026-09-01"), "buyer_profiled_at"))

    def test_a_line_never_moves_later(self):
        update, reason = self.plan(first="2026-10-01", demand="2026-10-16")
        self.assertIsNone(update)
        self.assertIn("no older date", reason)
        self.assertIsNone(self.plan(first="2026-10-01", demand="2026-10-01")[0])

    def test_a_line_with_no_source_date_stays(self):
        self.assertEqual(self.plan()[1], "no source date found")

    def test_a_standing_line_moves_only_when_first_seen_is_its_creation_day(self):
        self.assertIsNone(self.plan(kind="standing", first="2026-10-02", demand="2026-09-01")[0])
        update, _ = self.plan(kind="standing", first="2026-11-13", demand="2026-09-01")
        self.assertEqual(update["new_first"], D("2026-09-01"))
        self.assertEqual(update["new_expires"], D("2026-11-30"))  # standing: + 90 days

    def test_a_standing_line_does_not_take_a_company_level_date(self):
        self.assertEqual(self.plan(kind="standing", change="2026-08-01", profiled="2026-08-01")[1], "no source date found")

    def test_a_standing_line_reconfirmed_since_keeps_its_last_seen(self):
        update, _ = self.plan(kind="standing", first="2026-11-13", last="2026-11-14", demand="2026-09-01")
        self.assertEqual((update["new_first"], update["new_last"]), (D("2026-09-01"), D("2026-11-14")))
        self.assertEqual(update["new_expires"], D("2027-02-12"))  # derived expiry follows last_seen

    def test_an_expiry_someone_chose_is_kept_for_a_standing_line(self):
        update, _ = self.plan(kind="interest", first="2026-11-13", demand="2026-09-01", expires="2027-06-30")
        self.assertEqual(update["new_expires"], D("2027-06-30"))

    def test_the_plan_counts_lines_that_become_expired(self):
        rows = [line(demand="2026-03-01"), line(demand="2026-10-01"), line()]
        plan = self.fix.build_plan(rows, D("2026-11-15"))
        self.assertEqual(plan["moved"], 2)
        self.assertEqual(plan["became_expired"], {"inferred": 1})  # March + 180 days is 28 Aug 2026
        self.assertEqual(plan["months_before"], {"2026-11": 3})
        self.assertEqual(plan["months_after"], {"2026-03": 1, "2026-10": 1, "2026-11": 1})


class ExpiryWindow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.job = load("interest_expiry")

    def test_the_window_starts_at_the_last_run_and_never_runs_backwards(self):
        today = D("2026-11-15")
        self.assertEqual(self.job.window(today, None, D("2026-11-10")), D("2026-11-10"))
        self.assertEqual(self.job.window(today, D("2026-11-01"), D("2026-11-10")), D("2026-11-01"))  # --since wins
        self.assertEqual(self.job.window(today, None, None), D("2026-11-14"))
        self.assertEqual(self.job.window(today, None, D("2026-12-01")), today)


class Database(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import psycopg2
        import psycopg2.extras
        cls.dsn = os.environ.get("BULK_TRADES_TEST_DATABASE_URL")
        if not cls.dsn:
            raise unittest.SkipTest("needs the disposable CRM database (BULK_TRADES_TEST_DATABASE_URL)")
        cls.fix = load("fix_interest_dates")
        cls.job = load("interest_expiry")
        cls.conn = psycopg2.connect(cls.dsn)
        cls.tag = uuid.uuid4().hex[:8]
        cls.company = f"co_fixdates_{cls.tag}"
        with cls.conn.cursor() as cur:
            cur.execute("insert into crm_companies (id, name, buyer_profiled_at) values (%s, 'Fix Dates Buyer', '2026-09-01')",
                        (cls.company,))
            cur.execute("""insert into crm_bulk_listings (id, kind, party, summary, status, closed_reason, company_id,
                             observed_on, source_kind, source_id)
                           values (%s, 'demand', 'Fix Dates Buyer', 'fix dates', 'closed', 'research_profile', %s,
                             '2026-06-15', 'research', %s)""",
                        (f"btd_fixdates_{cls.tag}", cls.company, f"src:{cls.tag}"))
            cur.execute("delete from buyer_interest where company_id = %s", (cls.company,))
            # The company's buy box was first recorded on 20 Aug (inserting the company logged one for today too).
            cur.execute("delete from crm_buyer_profile_changes where company_id = %s", (cls.company,))
            cur.execute("insert into crm_buyer_profile_changes (company_id, field, changed_at) values (%s, 'buyer_profile', '2026-08-20 10:00+00')",
                        (cls.company,))
        cls.conn.commit()

    @classmethod
    def tearDownClass(cls):
        with cls.conn.cursor() as cur:
            cur.execute("delete from buyer_interest where company_id = %s", (cls.company,))
            cur.execute("delete from crm_bulk_listings where company_id = %s", (cls.company,))
            cur.execute("delete from crm_buyer_profile_changes where company_id = %s", (cls.company,))
            cur.execute("delete from crm_companies where id = %s", (cls.company,))
        cls.conn.commit()
        cls.conn.close()

    def setUp(self):
        with self.conn.cursor() as cur:
            cur.execute("delete from buyer_interest where company_id = %s", (self.company,))
            # Three lines made today with a recent first_seen: one cites the demand row, one the company's
            # buy box (first recorded 20 Aug), one a standing want with no source at all.
            for key, kind, refs, demand in (("broad:lfp-packs", "inferred", [f"src:{self.tag}"], None),
                                            ("broad:nmc-cells", "inferred", [f"crm:{self.company}", "crm:buyer_profile"], None),
                                            ("broad:nmc-modules", "standing", [], None)):
                cur.execute("""insert into buyer_interest (id, company_id, kind, ownership, product_key, first_seen,
                                 last_seen, source_refs, expires_on)
                               values (%s, %s, %s, 'mastered', %s, current_date, current_date, %s, current_date + 90)""",
                            (f"bi_fix_{uuid.uuid4().hex[:10]}", self.company, kind, key, refs))
        self.conn.commit()

    def stored(self):
        import psycopg2.extras
        with self.conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("select kind, product_key, first_seen, last_seen, expires_on from buyer_interest "
                        "where company_id = %s order by product_key", (self.company,))
            return {r["product_key"]: r for r in cur.fetchall()}

    def run_fix(self, *args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = self.fix.main(["--dsn", self.dsn, "--i-have-approval", *args])
        return code, out.getvalue()

    def test_a_database_named_denchclaw_is_refused_without_approval(self):
        before = self.stored()
        with self.assertRaises(SystemExit) as raised, contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.fix.main(["--apply", "--dsn", self.dsn])
        self.assertEqual(raised.exception.code, 2)
        self.assertEqual(self.stored(), before)

    def test_apply_needs_an_explicit_dsn(self):
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            self.fix.main(["--apply"])

    def test_a_dry_run_writes_nothing(self):
        before = self.stored()
        code, out = self.run_fix()
        self.assertEqual(code, 0)
        self.assertIn("dry run: nothing written", out)
        self.assertEqual(self.stored(), before)

    def test_apply_moves_lines_to_the_source_date_and_recomputes_expiry(self):
        code, out = self.run_fix("--apply", "--batch-size", "1")
        self.assertEqual(code, 0)
        self.assertIn("read-back mismatches 0", out)
        lines = self.stored()
        demand = lines["broad:lfp-packs"]       # the demand row, observed 15 Jun
        self.assertEqual((demand["first_seen"], demand["last_seen"], demand["expires_on"]),
                         (D("2026-06-15"), D("2026-06-15"), D("2026-12-12")))
        buybox = lines["broad:nmc-cells"]       # earliest buyer_profile change, 20 Aug (profiled_at says 1 Sep)
        self.assertEqual((buybox["first_seen"], buybox["expires_on"]), (D("2026-08-20"), D("2027-02-16")))
        standing = lines["broad:nmc-modules"]   # made today, no source date for it: stays
        self.assertEqual(standing["first_seen"], dt.date.today())

    def test_running_it_twice_changes_nothing_more(self):
        self.run_fix("--apply")
        once = self.stored()
        self.run_fix("--apply")
        self.assertEqual(self.stored(), once)

    def test_the_expiry_report_lists_lines_that_crossed_the_date_and_writes_nothing(self):
        self.run_fix("--apply")
        state = Path(tempfile.mkdtemp()) / "state.json"
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.job.main(["--dsn", self.dsn, "--since", "2026-12-01", "--today", "2026-12-31", "--state", str(state), "--json"])
        report = json.loads(out.getvalue())
        self.assertIn("broad:lfp-packs", [r["product_key"] for r in report["expired"]])  # expired 12 Dec 2026
        self.assertEqual(json.loads(state.read_text()), {"last_run": "2026-12-31"})
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.job.main(["--dsn", self.dsn, "--today", "2026-12-31", "--state", str(state), "--json"])
        self.assertNotIn("broad:lfp-packs", [r["product_key"] for r in json.loads(out.getvalue())["expired"]])  # reported once


if __name__ == "__main__":
    unittest.main()
