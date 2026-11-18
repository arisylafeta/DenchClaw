"""Migration 117: a request closed not_a_fit or offer_reply writes a 'Said' (interest) want; other closes write nothing.

Runs only against the disposable CRM test database (scripts/rebattery/crm-test-db.sh up), which has every migration.
"""
import json
import os
import uuid

import pytest

DB = os.environ.get("BULK_TRADES_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DB, reason="needs BULK_TRADES_TEST_DATABASE_URL")


class Session:
    """A cursor that remembers the test company."""
    def __init__(self, cursor, company):
        self._cursor, self.company = cursor, company

    def __getattr__(self, name):
        return getattr(self._cursor, name)


@pytest.fixture
def cur():
    import psycopg2
    conn = psycopg2.connect(DB)
    cursor = conn.cursor()
    company = f"said_co_{uuid.uuid4().hex[:8]}"
    cursor.execute("insert into crm_companies (id, name) values (%s, %s)", (company, "Said test buyer"))
    conn.commit()
    cursor = Session(cursor, company)
    yield cursor
    cursor.execute("delete from crm_companies where id = %s", (company,))  # cascades to its interest lines
    cursor.execute("delete from crm_bulk_listings where company_id = %s", (company,))
    conn.commit()
    conn.close()


def demand(cur, spec, reason, status="closed", observed="2026-11-10", summary="Request"):
    lid = f"said_{uuid.uuid4().hex[:10]}"
    cur.execute("""insert into crm_bulk_listings (id, kind, party, company_id, summary, status, closed_reason, observed_on, spec, context)
                   values (%s, 'demand', 'Test buyer', %s, %s, %s, %s, %s, %s::jsonb, '{}'::jsonb)""",
                (lid, cur.company, summary, status, reason, observed, json.dumps({"basis": "stated", **spec})))
    return lid


def lines(cur, lid):
    cur.execute("""select kind, ownership, product_key, make, model, format, kwh_min, first_seen, expires_on
                   from buyer_interest where demand_id = %s order by product_key""", (lid,))
    return cur.fetchall()


def test_a_request_closed_not_a_fit_writes_a_said_line_that_expires_in_180_days(cur):
    # Sapo: a marketplace sourcing request for a BMW 225xe 7.6 kWh pack, SoH above 90%.
    lid = demand(cur, {"makes": ["BMW"], "model": "225xe", "kwh": 7.6, "min_soh": 90, "formats": ["Packs"]}, "not_a_fit")
    [(kind, ownership, key, make, model, fmt, _kwh_min, first_seen, expires)] = lines(cur, lid)
    assert (kind, ownership, key, make, model, fmt) == ("interest", "mastered", "model:bmw-225xe-7.6kwh", "BMW", "225xe", "pack")
    assert str(first_seen) == "2026-11-10"
    assert str(expires) == "2027-05-09"  # observed_on + 180 days


def test_a_buyer_reply_to_our_offer_writes_a_said_line_for_the_cells(cur):
    # OM Batteries: "the team has interest in the SK cells" (SK On E603 pouch cells).
    lid = demand(cur, {"cell_makers": ["SK On"], "model": "E603", "formats": ["Cells"]}, "offer_reply", observed="2026-11-12")
    [(kind, ownership, key, _make, model, fmt, *_rest)] = lines(cur, lid)
    assert (kind, ownership, key, model, fmt) == ("interest", "mastered", "cell:sk-on-e603", "E603", "cell")


def test_closes_that_are_not_interest_write_nothing(cur):
    for reason in ("not_demand", "duplicate", "supply", "recycling", "moved_to_lot"):
        lid = demand(cur, {"makes": ["BMW"], "model": "225xe", "kwh": 7.6}, reason)
        assert lines(cur, lid) == [], reason


def test_an_open_request_stays_an_ask_and_closing_it_not_a_fit_turns_it_into_interest(cur):
    lid = demand(cur, {"makes": ["Kia"], "model": "Niro", "kwh": 64}, None, status="open")
    assert [row[0] for row in lines(cur, lid)] == ["ask"]
    cur.execute("update crm_bulk_listings set status = 'closed', closed_reason = 'not_a_fit' where id = %s", (lid,))
    assert [row[:3] for row in lines(cur, lid)] == [("interest", "mastered", "model:kia-niro-64kwh")]
    cur.execute("update crm_bulk_listings set closed_reason = 'duplicate' where id = %s", (lid,))
    assert lines(cur, lid) == []


def test_a_second_request_for_the_same_product_merges_into_the_buyers_line(cur):
    spec = {"makes": ["BMW"], "model": "225xe", "kwh": 7.6}
    first = demand(cur, spec, "not_a_fit", observed="2026-11-01")
    second = demand(cur, spec, "offer_reply", observed="2026-11-15")
    cur.execute("select count(*), max(last_seen), max(expires_on) from buyer_interest where company_id = %s and kind = 'interest'",
                (cur.company,))
    count, last_seen, expires = cur.fetchone()
    assert (count, str(last_seen), str(expires)) == (1, "2026-11-15", "2027-05-14")
    cur.execute("select count(*) from buyer_interest_sync_errors where source_id = any(%s)", ([first, second],))
    assert cur.fetchone()[0] == 0
