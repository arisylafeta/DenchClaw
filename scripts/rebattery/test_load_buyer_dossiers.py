"""Tests for load_buyer_dossiers: dry run, apply with read-back, and the guard on the loaded row.

Needs the disposable database: CRM_TEST_DB_NAME=crm-test-db-phase3 CRM_TEST_DB_PORT=55434 \
  scripts/rebattery/crm-test-db.sh up, then BULK_TRADES_TEST_DATABASE_URL=... python3 -m unittest test_load_buyer_dossiers
"""
import contextlib
import io
import json
import os
import tempfile
import unittest
import uuid
from pathlib import Path

import load_buyer_dossiers as loader

TEST_URL = os.environ.get("BULK_TRADES_TEST_DATABASE_URL")

DOSSIER = """---
company_id: "%COMPANY%"
company: "Loader Test Ltd"
min_soh: 60
products:
  - make: Nissan
    format: packs
    chemistry: LFP
    kwh: [24]
    status: asked
    seen: "2026-09-01"
    src: "survey:loader1"
---
Leaf packs only.
"""


@unittest.skipUnless(TEST_URL, "needs a disposable database: scripts/rebattery/crm-test-db.sh up")
class Loading(unittest.TestCase):
    def setUp(self):
        import psycopg2
        import psycopg2.extras
        self.psycopg2 = psycopg2
        self.extras = psycopg2.extras
        self.run_id = uuid.uuid4().hex[:8]
        self.company_id = f"co_loader_{self.run_id}"
        self.conn = psycopg2.connect(TEST_URL)
        with self.conn, self.conn.cursor() as cur:
            cur.execute("""insert into crm_companies (id, name, buyer_profile)
                           values (%s, 'Loader Test Ltd', '{"evidence_url":"https://example.test/evidence","wants":"old"}'::jsonb)""",
                        (self.company_id,))
        self.addCleanup(self.conn.close)
        self.addCleanup(self.conn.close)

    def dossier_file(self, text=None):
        handle = tempfile.NamedTemporaryFile("w", suffix=".md", delete=False, encoding="utf-8")
        handle.write((text or DOSSIER).replace("%COMPANY%", self.company_id))
        handle.close()
        self.addCleanup(os.unlink, handle.name)
        return handle.name

    def run_loader(self, *args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = loader.main(["--dsn", TEST_URL, *args])
        return code, out.getvalue()

    def company(self):
        with self.conn.cursor(cursor_factory=self.extras.RealDictCursor) as cur:
            cur.execute("""select buyer_dossier, buyer_profile, buyer_dossier_version::int as version
                           from crm_companies where id = %s""", (self.company_id,))
            row = cur.fetchone()
        self.conn.rollback()
        return row

    def test_dry_run_prints_the_diff_and_writes_nothing(self):
        code, output = self.run_loader(self.dossier_file())
        self.assertEqual(code, 0)
        self.assertIn(self.company_id, output)
        self.assertIn("+ chemistries: LFP", output)
        self.assertIn("~ min_soh: null -> 60", output)
        self.assertIn("~ wants:", output)
        self.assertIn("kept as they are: evidence_url", output)
        self.assertIn("dry run: 1 file(s), 1 with a buyer_profile change", output)
        saved = self.company()
        self.assertIsNone(saved["buyer_dossier"])
        self.assertEqual(saved["version"], 0)
        self.assertEqual(saved["buyer_profile"]["wants"], "old")

    def test_apply_writes_the_dossier_and_the_merged_profile_with_read_back(self):
        path = self.dossier_file()
        code, output = self.run_loader(path, "--apply")
        self.assertEqual(code, 0)
        self.assertIn("written: v1, read back", output)
        saved = self.company()
        self.assertEqual(saved["version"], 1)
        self.assertEqual(saved["buyer_dossier"], Path(path).read_text(encoding="utf-8"))
        self.assertEqual(saved["buyer_profile"]["chemistries"], ["LFP"])
        self.assertEqual(saved["buyer_profile"]["min_soh"], 60)
        self.assertEqual(saved["buyer_profile"]["evidence_url"], "https://example.test/evidence")
        self.assertIn("Nissan 24 kWh packs", saved["buyer_profile"]["wants"])

        # Loading the same text again is a no-op, not a version bump.
        code, output = self.run_loader(path, "--apply")
        self.assertEqual(code, 0)
        self.assertIn("already loaded (same text), skipped", output)
        self.assertEqual(self.company()["version"], 1)

    def test_the_guard_rejects_an_outside_write_once_a_dossier_is_loaded(self):
        self.assertEqual(self.run_loader(self.dossier_file(), "--apply")[0], 0)
        with self.conn.cursor() as cur:
            with self.assertRaises(self.psycopg2.errors.CheckViolation):
                cur.execute("update crm_companies set buyer_profile = '{\"wants\":\"outside\"}'::jsonb where id = %s",
                            (self.company_id,))
        self.conn.rollback()
        self.assertEqual(self.company()["buyer_profile"]["chemistries"], ["LFP"])

    def test_apply_refuses_to_run_without_an_explicit_dsn(self):
        # The default DSN is the production CRM: a write must say where it goes.
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            with self.assertRaises(SystemExit) as raised:
                loader.main([self.dossier_file(), "--apply"])
        self.assertEqual(raised.exception.code, 2)
        self.assertIn("--dsn", err.getvalue())
        self.assertIsNone(self.company()["buyer_dossier"])

    def test_a_write_aborts_when_the_version_moved_after_the_dry_run(self):
        import psycopg2.extras
        path = self.dossier_file()
        with self.conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            company_id, text, profile, _, errors, current = loader.plan(Path(path), cur)
            self.assertEqual(errors, [])
            planned = int(current["buyer_dossier_version"])
        self.conn.rollback()
        # Another writer saved in between.
        with self.conn, self.conn.cursor() as cur:
            cur.execute("select set_config('crm.dossier_write', 'on', true)")
            cur.execute("update crm_companies set buyer_dossier = 'someone else', buyer_dossier_version = 1 where id = %s",
                        (company_id,))
        with self.conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            with self.assertRaises(RuntimeError) as raised:
                loader.write(cur, company_id, text, profile, planned)
        self.conn.rollback()
        self.assertIn("version moved", str(raised.exception))
        self.assertEqual(self.company()["buyer_dossier"], "someone else")

    def test_a_body_only_edit_bumps_the_version_without_touching_buyer_profile(self):
        path = self.dossier_file()
        self.assertEqual(self.run_loader(path, "--apply")[0], 0)
        first = self.company()
        with self.conn.cursor() as cur:
            cur.execute("select coalesce(max(id), 0) as id from crm_buyer_profile_changes where company_id = %s",
                        (self.company_id,))
            highest = cur.fetchone()[0]
        self.conn.rollback()

        edited = self.dossier_file(Path(path).read_text(encoding="utf-8").replace("Leaf packs only.", "Now also modules."))
        code, output = self.run_loader(edited, "--apply")
        self.assertEqual(code, 0)
        self.assertIn("buyer_profile unchanged", output)
        second = self.company()
        self.assertEqual(second["version"], 2)
        self.assertEqual(second["buyer_profile"], first["buyer_profile"])
        with self.conn.cursor() as cur:
            cur.execute("""select count(*) from crm_buyer_profile_changes
                           where company_id = %s and field = 'buyer_profile' and id > %s""",
                        (self.company_id, highest))
            self.assertEqual(cur.fetchone()[0], 0)
        self.conn.rollback()

    def test_an_invalid_dossier_is_refused_and_a_missing_company_is_reported(self):
        code, output = self.run_loader(self.dossier_file(DOSSIER.replace("status: asked", "status: maybe")))
        self.assertEqual(code, 1)
        self.assertIn("products[0].status", output)
        self.assertIsNone(self.company()["buyer_dossier"])

        missing = self.dossier_file(DOSSIER.replace("%COMPANY%", f"co_absent_{self.run_id}"))
        code, output = self.run_loader(missing)
        self.assertEqual(code, 1)
        self.assertIn("no crm_companies row", output)

    def test_a_pass_through_key_survives_and_a_derived_key_the_dossier_drops_is_removed(self):
        with self.conn, self.conn.cursor() as cur:
            cur.execute("""update crm_companies set buyer_profile = %s::jsonb where id = %s""",
                        (json.dumps({"evidence_url": "https://example.test/evidence", "origins": ["FR"], "min_soh": 80}),
                         self.company_id))
        _, output = self.run_loader(self.dossier_file())
        self.assertIn("- origins: FR", output)
        self.assertIn("~ min_soh: 80 -> 60", output)
        self.assertIn("kept as they are: evidence_url", output)


if __name__ == "__main__":
    unittest.main()
