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


def search(sid, email, q, **filters):
    return {"id": sid, "email": email, "label": q, "frequency": "daily", "status": "active",
            "confirmed_at": "2026-10-01T06:00:00+00:00", "filters": {"q": q, **filters}}


def run(tmp_path, searches, *flags):
    (tmp_path / "s.json").write_text(json.dumps(searches))
    return subprocess.run([sys.executable, str(HERE / "saved_search_import.py"), "--dsn", DB, "--json", str(tmp_path / "s.json"),
                           *flags], capture_output=True, text=True, check=True).stdout


def lines(cur, company):
    cur.execute("select saved_search_id, product_key, first_seen::text, last_seen::text, source_refs from buyer_interest "
                "where company_id = %s and kind = 'saved_search' order by saved_search_id, product_key", (company,))
    return cur.fetchall()


def test_resync_replaces_old_keys_and_merges_duplicates(tmp_path):
    import psycopg2
    with psycopg2.connect(DB) as conn, conn.cursor() as cur:
        cur.execute("insert into crm_companies (id, name) values ('rs-co', 'Resync Co'), ('rs-co2', 'Resync Two') on conflict do nothing")
        cur.execute("insert into crm_people (id, email, company_id) values ('rs-p', 'rs.a@example.net', 'rs-co'), "
                    "('rs-p2', 'rs.b@example.net', 'rs-co2') on conflict do nothing")
        cur.execute("delete from buyer_interest where company_id in ('rs-co', 'rs-co2')")
        old = ("insert into buyer_interest (id, company_id, kind, ownership, product_key, product_key_level, first_seen, last_seen, "
               "source_refs, saved_search_id) values (%s, %s, 'saved_search', 'synced', %s, 'broad', %s, %s, %s::text[], %s)")
        # one stale broad key for the Corolla Cross search; two Model Y lines of one company (duplicate)
        cur.execute(old, ("o1", "rs-co", "model:toyota-corolla", "2026-09-01", "2026-10-02", ["saved_search:s-cross"], "s-cross"))
        # a sourcing request's line for the Corolla Cross: the search shares it instead of adding a second
        cur.execute(old, ("o4", "rs-co", "model:toyota-corollacross", "2026-07-01", "2026-10-04", ["saved_search:sourcing_request:r1"], "sourcing_request:r1"))
        cur.execute(old, ("o2", "rs-co2", "model:tesla-modely", "2026-09-05", "2026-10-03", ["saved_search:s-y1"], "s-y1"))
        cur.execute(old, ("o3", "rs-co2", "model:tesla-modely", "2026-08-01", "2026-10-09", ["saved_search:s-y2"], "s-y2"))
        cur.execute("update buyer_interest set raw_product = 'stale' where company_id in ('rs-co', 'rs-co2')")
    searches = [
        search("s-cross", "rs.a@example.net", "Corolla Cross G9510-16021", manufacturer=["Toyota"], location_country=["GB"]),
        search("s-sdi", "rs.a@example.net", "Samsung sdi modules"),
        search("s-y1", "rs.b@example.net", "Model Y", manufacturer=["Tesla"]),
        search("s-y2", "rs.b@example.net", "Model Y", manufacturer=["Tesla"]),
    ]
    dry = run(tmp_path, searches, "--resync")
    assert "dry run" in dry and "model:toyota-corolla" in dry and "LOST (old Wants with no replacement): 0" in dry
    with psycopg2.connect(DB) as conn, conn.cursor() as cur:
        assert [r[1] for r in lines(cur, "rs-co")] == ["model:toyota-corolla", "model:toyota-corollacross"]  # dry run saved nothing
        assert len(lines(cur, "rs-co2")) == 2
    out = run(tmp_path, searches, "--resync", "--apply")
    assert out.count("merged 2 lines") == 1
    with psycopg2.connect(DB) as conn, conn.cursor() as cur:
        cross = lines(cur, "rs-co")
        keys = {r[1] for r in cross if r[0] in ("s-cross", "sourcing_request:r1")}
        assert "model:toyota-corolla" not in keys and "model:toyota-corollacross" in keys
        assert "part:G951016021" in keys, keys  # part number key
        shared = [r for r in cross if r[1] == "model:toyota-corollacross"]
        assert len(shared) == 1 and shared[0][2] == "2026-07-01" and "saved_search:s-cross" in shared[0][4]
        assert any(r[0] == "s-sdi" for r in cross)  # Samsung SDI modules line exists
        cur.execute("select raw_product from buyer_interest where company_id = 'rs-co' and 'saved_search:s-cross' = any(source_refs)")
        raws = [r[0] or "" for r in cur.fetchall()]
        assert any("Located in: United Kingdom" in r for r in raws) and not any("stale" in r for r in raws)  # re-sync refreshes raw_product
        cur.execute("select raw_product from buyer_interest where saved_search_id = 's-sdi'")
        assert any("Samsung SDI" in (r[0] or "") for r in cur.fetchall())
        y = lines(cur, "rs-co2")
        assert len(y) == 1 and y[0][0] == "s-y2" and y[0][2] == "2026-08-01" and y[0][3] >= "2026-10-09"
        assert y[0][4] == ["saved_search:s-y1", "saved_search:s-y2"]
        cur.execute("select count(*) from buyer_interest_alert_resync_20261118 where id in ('o1', 'o2', 'o3', 'o4')")
        assert cur.fetchone()[0] == 4
        cur.execute("delete from buyer_interest where company_id in ('rs-co', 'rs-co2')")
        cur.execute("drop table buyer_interest_alert_resync_20261118")
