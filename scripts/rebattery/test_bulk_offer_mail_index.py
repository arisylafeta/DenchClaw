"""Tests for bulk_offer_mail_index.py against a throwaway Postgres: scripts/rebattery/crm-test-db.sh up, then
BULK_TRADES_TEST_DATABASE_URL=<url> python3 -m pytest scripts/rebattery/test_bulk_offer_mail_index.py"""
import os
import stat
import subprocess
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg2
import pytest

URL = os.environ.get("BULK_TRADES_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not URL, reason="needs a disposable test database")
SCRIPT = Path(__file__).with_name("bulk_offer_mail_index.py")


@pytest.fixture()
def db():
    conn = psycopg2.connect(URL)
    conn.autocommit = True
    cur = conn.cursor()
    tag = uuid.uuid4().hex[:8]
    ids = dict(co=f"co_{tag}", co2=f"co2_{tag}", person=f"pe_{tag}", person2=f"pe2_{tag}", sup=f"bts_{tag}", offer=f"bof_{tag}", offer2=f"bof2_{tag}", thread=f"gmail_thread_{tag}")
    cur.execute("insert into crm_companies (id, name) values (%s, 'Buyer Co'), (%s, 'Other Co')", (ids["co"], ids["co2"]))
    cur.execute("insert into crm_people (id, full_name, email, company_id) values (%s, 'Ann', %s, %s), (%s, 'Bob', %s, %s)",
                (ids["person"], f"ann_{tag}@buyer.test", ids["co"], ids["person2"], f"bob_{tag}@other.test", ids["co2"]))
    cur.execute("insert into crm_bulk_listings (id, kind, party, summary, status) values (%s, 'supply', 'Seller', '40 packs', 'open')", (ids["sup"],))
    cur.execute("insert into crm_bulk_offers (id, bulk_listing_id, role, person_id, company_id, name, stage, data) values (%s,%s,'counterparty',%s,%s,'Buyer Co','offered','{}')",
                (ids["offer"], ids["sup"], ids["person"], ids["co"]))
    ids["tag"] = tag
    ids["email"] = f"ann_{tag}@buyer.test"
    yield conn, cur, ids
    cur.execute("delete from crm_bulk_listings where id = %s", (ids["sup"],))
    cur.execute("delete from mail_message where id like %s", (f"%{tag}%",))
    cur.execute("delete from mail_thread where id like %s", (f"%{tag}%",))
    cur.execute("delete from campaigns where id = 'camp_x'")
    cur.execute("delete from crm_people where id in (%s, %s)", (ids["person"], ids["person2"]))
    cur.execute("delete from crm_companies where id in (%s, %s)", (ids["co"], ids["co2"]))
    conn.close()


def ago(days):
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


def thread_row(cur, thread):
    cur.execute("insert into mail_thread (id) values (%s) on conflict do nothing", (thread,))


def mail(cur, mid, direction, ts, to=None, frm=None, thread=None, person=None, subject="STN offer", campaign=None):
    if thread:
        thread_row(cur, thread)
    if campaign:
        cur.execute("insert into campaigns (id, campaign_name) values (%s, 'Test campaign') on conflict do nothing", (campaign,))
    cur.execute("""insert into mail_message (id, direction, transport, state, purpose, identity_key, thread_id, subject, from_email, to_emails, person_id, campaign_id, sent_at, gmail_message_id)
                   values (%s,%s,'gmail',%s,'personal','alex',%s,%s,%s,%s,%s,%s,%s,%s)""",
                (mid, direction, "accepted" if direction == "outbound" else "received", thread, subject, frm or "alex@rebattery.io", [to] if to else [], person, campaign, ts, mid))


def run(*args, extra_env=None):
    args = tuple(args)
    env = {**os.environ, "DENCH_CRM_DSN": URL, **(extra_env or {})}
    return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, env=env)


def count(cur, sql, args=()):
    cur.execute(sql, args)
    return cur.fetchone()[0]


def test_dry_run_writes_nothing(db):
    _, cur, ids = db
    link(cur, ids)
    mail(cur, f"m1_{ids['tag']}", "outbound", "2026-10-20T10:00:00Z", to=ids["email"], person=ids["person"], thread=ids["thread"])
    out = run("--since", "2026-10-01")
    assert out.returncode == 0, out.stderr
    assert "DRY RUN" in out.stdout and "indexed 1" in out.stdout  # reports what it would write
    assert count(cur, "select count(*) from crm_bulk_offer_mail where bulk_listing_id = %s", (ids["sup"],)) == 0


def link(cur, ids):
    cur.execute("insert into mail_thread (id) values (%s) on conflict do nothing", (ids["thread"],))
    cur.execute("""insert into crm_bulk_thread_links (channel, thread_id, bulk_listing_id, offer_id, confidence, state, labelled_by)
                   values ('mail', %s, %s, %s, 'high', 'confirmed', 'test') """.replace("'confirmed', 'test'", "'proposed', 'test'"), (ids["thread"], ids["sup"], ids["offer"]))


def test_indexes_sent_offer_mail_idempotently(db):
    _, cur, ids = db
    link(cur, ids)
    mail(cur, f"m1_{ids['tag']}", "outbound", "2026-10-20T10:00:00Z", to=ids["email"], person=ids["person"], thread=ids["thread"])
    out = run("--apply", "--no-alert", "--since", "2026-10-01")
    assert out.returncode == 0, out.stderr
    assert "indexed 1" in out.stdout and "story 1" in out.stdout
    cur.execute("select state, labelled_by from crm_bulk_thread_links where thread_id = %s and offer_id = %s", (ids["thread"], ids["offer"]))
    assert cur.fetchone() == ("proposed", "test")  # the existing link is kept, not duplicated
    cur.execute("select last_touch_on::text, last_touch_via, data->>'waiting_on' from crm_bulk_offers where id = %s", (ids["offer"],))
    assert cur.fetchone() == ("2026-10-20", "mail", "them")
    again = run("--apply", "--no-alert", "--since", "2026-10-01")
    assert "indexed 0" in again.stdout and "story 0" in again.stdout
    assert count(cur, "select count(*) from crm_bulk_listing_activity where bulk_listing_id = %s and kind = 'mail'", (ids["sup"],)) == 1


def test_skips_campaign_mail_and_unrelated_recipients(db):
    _, cur, ids = db
    mail(cur, f"c1_{ids['tag']}", "outbound", "2026-10-20T10:00:00Z", to=ids["email"], person=ids["person"], campaign="camp_x")
    mail(cur, f"u1_{ids['tag']}", "outbound", "2026-10-20T11:00:00Z", to="nobody@elsewhere.test")
    out = run("--apply", "--no-alert", "--since", "2026-10-01", "--include-recipient")
    assert "indexed 0" in out.stdout and "not_offer_mail 1" in out.stdout


def test_ambiguous_recipient_is_listed_not_guessed(db):
    _, cur, ids = db
    cur.execute("insert into crm_bulk_listings (id, kind, party, summary, status) values (%s, 'supply', 'Seller 2', '10 packs', 'open')", (ids["sup"] + "b",))
    cur.execute("insert into crm_bulk_offers (id, bulk_listing_id, role, person_id, company_id, name, stage, data) values (%s,%s,'counterparty',%s,%s,'Buyer Co','offered','{}')",
                (ids["offer2"], ids["sup"] + "b", ids["person"], ids["co"]))
    mail(cur, f"m1_{ids['tag']}", "outbound", "2026-10-20T10:00:00Z", to=ids["email"], person=ids["person"])
    out = run("--apply", "--no-alert", "--since", "2026-10-01", "--include-recipient")
    cur.execute("delete from crm_bulk_listings where id = %s", (ids["sup"] + "b",))
    assert "indexed 0" in out.stdout and "ambiguous 1" in out.stdout


def test_reply_is_logged_at_its_real_time_and_alerts_once(db, tmp_path):
    _, cur, ids = db
    link(cur, ids)
    mail(cur, f"m1_{ids['tag']}", "outbound", ago(5), to=ids["email"], person=ids["person"], thread=ids["thread"])
    reply_at = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(days=1)
    mail(cur, f"r1_{ids['tag']}", "inbound", reply_at.isoformat(), frm=ids["email"], thread=ids["thread"], subject="Re: STN offer")
    fake = tmp_path / "hermes"
    fake.write_text(f"#!/bin/sh\necho \"$@\" >> {tmp_path}/sent.txt\n")
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    env = {"PATH": f"{tmp_path}:{os.environ['PATH']}"}
    out = run("--apply", "--since", "2026-10-01", "--alert-to", "discord:1", extra_env=env)
    assert out.returncode == 0, out.stderr
    assert "replies 1" in out.stdout
    cur.execute("select occurred_at at time zone 'utc', data->>'state' from crm_bulk_listing_activity where bulk_listing_id = %s and data->>'state' = 'received'", (ids["sup"],))
    when, state = cur.fetchone()
    assert when.replace(tzinfo=timezone.utc) == reply_at and state == "received"
    cur.execute("select last_touch_on::text, data->>'waiting_on' from crm_bulk_offers where id = %s", (ids["offer"],))
    assert cur.fetchone() == (reply_at.date().isoformat(), "us")
    cur.execute("select stage from crm_bulk_offers where id = %s", (ids["offer"],))
    assert cur.fetchone()[0] == "offered"  # never moves the stage
    sent = (tmp_path / "sent.txt").read_text()
    assert "discord:1" in sent and "Buyer Co" in sent and "@" not in sent.replace("rebattery.io", "")
    run("--apply", "--since", "2026-10-01", "--alert-to", "discord:1", extra_env=env)
    assert (tmp_path / "sent.txt").read_text().count("Reply on a bulk offer") == 1


def test_flags_an_offer_with_no_reply_past_its_chase_date_once(db, tmp_path):
    _, cur, ids = db
    link(cur, ids)
    cur.execute("update crm_bulk_offers set data = jsonb_build_object('chase_on', '2026-10-25') where id = %s", (ids["offer"],))
    mail(cur, f"m1_{ids['tag']}", "outbound", "2026-10-20T10:00:00Z", to=ids["email"], person=ids["person"], thread=ids["thread"])
    fake = tmp_path / "hermes"
    fake.write_text(f"#!/bin/sh\necho \"$@\" >> {tmp_path}/sent.txt\n")
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    env = {"PATH": f"{tmp_path}:{os.environ['PATH']}"}
    out = run("--apply", "--since", "2026-10-01", "--alert-to", "discord:1", extra_env=env)
    assert "overdue 1" in out.stdout
    run("--apply", "--since", "2026-10-01", "--alert-to", "discord:1", extra_env=env)
    assert (tmp_path / "sent.txt").read_text().count("Chase due") == 1


def test_recipient_only_match_is_listed_but_not_indexed_by_default(db):
    _, cur, ids = db
    mail(cur, f"m1_{ids['tag']}", "outbound", "2026-10-20T10:00:00Z", to=ids["email"], person=ids["person"])
    out = run("--apply", "--no-alert", "--since", "2026-10-01")
    assert "indexed 0" in out.stdout and "recipient_only 1" in out.stdout
    assert count(cur, "select count(*) from crm_bulk_offer_mail where bulk_listing_id = %s", (ids["sup"],)) == 0
    forced = run("--apply", "--no-alert", "--since", "2026-10-01", "--include-recipient")
    assert "indexed 1" in forced.stdout


def test_fills_the_thread_and_proposes_the_link_once_gmail_sync_supplies_it(db):
    _, cur, ids = db
    mail(cur, f"m1_{ids['tag']}", "outbound", "2026-10-20T10:00:00Z", to=ids["email"], person=ids["person"])
    assert "indexed 1" in run("--apply", "--no-alert", "--since", "2026-10-01", "--include-recipient").stdout
    assert count(cur, "select count(*) from crm_bulk_thread_links where thread_id = %s", (ids["thread"],)) == 0
    thread_row(cur, ids["thread"])
    cur.execute("update mail_message set thread_id = %s where id = %s", (ids["thread"], f"m1_{ids['tag']}"))
    out = run("--apply", "--no-alert", "--since", "2026-10-01")
    assert "threads_filled 1" in out.stdout
    cur.execute("select state from crm_bulk_thread_links where thread_id = %s and offer_id = %s", (ids["thread"], ids["offer"]))
    assert cur.fetchone() == ("proposed",)


def test_old_replies_and_stale_offers_are_logged_but_not_announced(db, tmp_path):
    _, cur, ids = db
    link(cur, ids)
    mail(cur, f"m1_{ids['tag']}", "outbound", ago(60), to=ids["email"], person=ids["person"], thread=ids["thread"])
    mail(cur, f"r1_{ids['tag']}", "inbound", ago(40), frm=ids["email"], thread=ids["thread"], subject="Re: STN offer")
    fake = tmp_path / "hermes"
    fake.write_text(f"#!/bin/sh\necho \"$@\" >> {tmp_path}/sent.txt\n")
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    out = run("--apply", "--since", "2026-01-01", "--alert-to", "discord:1", extra_env={"PATH": f"{tmp_path}:{os.environ['PATH']}"})
    assert "replies 1" in out.stdout and "overdue 0" in out.stdout
    assert not (tmp_path / "sent.txt").exists()
