"""Runs only against the disposable CRM test database (scripts/rebattery/crm-test-db.sh up)."""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

DB = os.environ.get("BULK_TRADES_TEST_DATABASE_URL")
HERE = Path(__file__).resolve().parent
pytestmark = pytest.mark.skipif(not DB, reason="needs BULK_TRADES_TEST_DATABASE_URL")


def run(tmp_path, requests):
    (tmp_path / "s.json").write_text("[]")
    (tmp_path / "r.json").write_text(json.dumps(requests))
    return subprocess.run([sys.executable, str(HERE / "saved_search_import.py"), "--dsn", DB, "--json", str(tmp_path / "s.json"),
                           "--requests-json", str(tmp_path / "r.json"), "--apply"], capture_output=True, text=True, check=True).stdout


def test_only_a_bulk_request_is_added_flagged_for_review_and_once(tmp_path):
    import psycopg2
    big = {"id": "gate-big", "email": "gate.test.buyer@gmail.com", "wants": "Hyundai Kona 64 kWh packs", "quantity": "many",
           "timing": "now", "filters": {"kwh_min": 63.5, "kwh_max": 64.49}, "created_at": "2026-11-16T09:00:00Z"}
    small = {**big, "id": "gate-small", "email": "gate.test.small@gmail.com", "quantity": "one"}
    run(tmp_path, [big, small])
    run(tmp_path, [big, small])
    with psycopg2.connect(DB) as conn, conn.cursor() as cur:
        cur.execute("""select source_id, context->'review'->>'state', next_action is not null, next_due is not null, context->>'owner'
                       from crm_bulk_listings where source_id like 'sourcing_request:gate-%'""")
        rows = cur.fetchall()
        cur.execute("""select count(*) from crm_bulk_listing_activity a join crm_bulk_listings l on l.id = a.bulk_listing_id
                       where l.source_id = 'sourcing_request:gate-big' and a.kind = 'research'""")
        stories = cur.fetchone()[0]
        cur.execute("delete from crm_bulk_listings where source_id like 'sourcing_request:gate-%'")
    assert rows == [("sourcing_request:gate-big", "needs_review", True, True, "Alex")]
    assert stories == 1
