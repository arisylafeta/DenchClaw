"""Tests for relay_scan.py: pure classification logic, and the write path against a scratch schema.

Run: /usr/bin/python3 -m pytest scripts/rebattery/test_relay_scan.py -q
The DB test needs the local Postgres scratch database (RELAY_TEST_DB) and denchclaw for schema copies; it is
skipped when either is unreachable.
"""
import datetime as dt
import importlib.util
import json
import os
import subprocess
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("relay_scan", Path(__file__).with_name("relay_scan.py"))
rs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rs)

UTC = dt.timezone.utc
NOW = dt.datetime(2026, 10, 27, 12, 0, tzinfo=UTC)  # a Tuesday
ALEX = "alex@rebattery.io"


def msg(direction, at, text="", frm=None, to=None, subject="Kia packs", mid=None, labels=None, **extra):
    at = at if isinstance(at, dt.datetime) else NOW - dt.timedelta(days=at)
    return {
        "id": mid or f"m{at.timestamp()}", "gmail_message_id": mid or f"g{int(at.timestamp())}", "direction": direction,
        "state": "received" if direction == "inbound" else "accepted", "purpose": None, "campaign_id": None,
        "from_email": frm or ("tom@dealer.no" if direction == "inbound" else ALEX),
        "to_emails": to or ([ALEX] if direction == "inbound" else ["tom@dealer.no"]), "cc_emails": [],
        "subject": subject, "text": text, "labels": labels or [], "at": at, **extra,
    }


def ctx(**kw):
    base = {"triage": {}, "contact_type": None, "deal_linked": False, "last_to": {}, "last_from": {}, "known": True, "existing_open": False}
    base.update(kw)
    return base


# ---------- automated sender filter ----------

@pytest.mark.parametrize("email,subject", [
    ("noreply@stripe.com", "Receipt"), ("no-reply@company.de", "Hi"), ("notifications@github.com", "PR"),
    ("MAILER-DAEMON@mx.example.com", "fail"), ("calendar-notification@google.com", "x"),
    ("anna@dealer.no", "Invitation: Call @ Tue"), ("anna@dealer.no", "Accepted: Call"),
    ("anna@dealer.no", "Automatic reply: Kia packs"), ("bob@linkedin.com", "Hello"),
])
def test_automated_senders_filtered(email, subject):
    assert rs.is_automated(email, subject)


@pytest.mark.parametrize("email,subject", [("tom@dealer.no", "Re: Kia packs"), ("info@japoto.nl", "Kona"), ("Tom <tom@x.de>", "Accepted offer for packs")])
def test_real_senders_kept(email, subject):
    assert not rs.is_automated(email, subject)


def test_real_messages_drops_internal_campaign_drafts_and_spam():
    msgs = [
        msg("inbound", 5, "hi", frm="ari@rebattery.io"),
        msg("outbound", 4, "internal", to=["ari@rebattery.io"]),
        {**msg("outbound", 3, "campaign"), "campaign_id": "c1"},
        {**msg("outbound", 2, "draft"), "state": "draft"},
        msg("inbound", 1, "spam", labels=["SPAM"]),
        msg("inbound", 1.5, "real one"),
    ]
    kept = rs.real_messages(msgs)
    assert [m["text"] for m in kept] == ["real one"]


# ---------- quote stripping ----------

def test_strip_quotes():
    text = "Thanks, 30 packs works.\n\nOn Mon, 3 Aug 2026 at 10:00, Alex <alex@rebattery.io> wrote:\n> Offer attached"
    assert rs.strip_quotes(text) == "Thanks, 30 packs works."
    assert rs.strip_quotes("Ja, passt.\n\nVon: Alex Polglase\nGesendet: Montag") == "Ja, passt."
    assert rs.strip_quotes("Price is EUR 60/kWh.\n> earlier") == "Price is EUR 60/kWh."


def test_clean_text_prefers_html_without_quote():
    html = '<div>Yes please send specs.</div><div class="gmail_quote">On Mon wrote: old stuff</div>'
    assert rs.clean_text(html, "fallback") == "Yes please send specs."
    assert rs.clean_text(None, "Plain reply\n\nOn Tue, Alex wrote:\n> x") == "Plain reply"


# ---------- tab classification ----------

def test_action_from_triage():
    msgs = [msg("outbound", 3, "Can you send photos?"), msg("inbound", 1, "Here they are", mid="g1")]
    r = rs.classify_thread(msgs, ctx(triage={"automated_state": "1 Action"}), NOW)
    assert r["tab"] == "action" and "triage" in r["reason"]


def test_action_from_question_without_triage():
    msgs = [msg("outbound", 3, "Hello"), msg("inbound", 1, "What price can you offer for 20 packs?")]
    assert rs.classify_thread(msgs, ctx(), NOW)["tab"] == "action"


def test_action_skipped_when_owner_wrote_to_person_elsewhere():
    msgs = [msg("inbound", 2, "What price?")]
    r = rs.classify_thread(msgs, ctx(last_to={"tom@dealer.no": NOW - dt.timedelta(days=1)}), NOW)
    assert r["tab"] is None and r["done_reason"] == "replied"


def test_thanks_is_other():
    msgs = [msg("outbound", 3, "Sent the invoice."), msg("inbound", 1, "Thanks Alex!")]
    assert rs.classify_thread(msgs, ctx(), NOW)["tab"] == "other"


def test_fresh_triage_read_is_other():
    msgs = [msg("inbound", 1, "Can you call me?", mid="g9")]
    r = rs.classify_thread(msgs, ctx(triage={"automated_state": "5 Read", "last_classified_message_id": "g9"}), NOW)
    assert r["tab"] == "other"


def test_unsolicited_pitch_is_other():
    msgs = [msg("inbound", 1, "We offer SEO services to grow your traffic.", frm="sam@seo.example")]
    assert rs.classify_thread(msgs, ctx(known=False), NOW)["tab"] == "other"


def test_follow_after_threshold_and_not_before():
    base = [msg("inbound", 10, "Interested"), msg("outbound", dt.datetime(2026, 10, 21, 9, tzinfo=UTC), "Would you take EUR 50/kWh?")]
    # Wed 21 Oct -> Tue 27 Oct = 4 working days
    assert rs.classify_thread(base, ctx(contact_type="supplier", deal_linked=True), NOW)["tab"] == "follow"
    assert rs.classify_thread(base, ctx(contact_type="supplier"), NOW)["tab"] is None  # no deal: needs 7
    recent = [msg("inbound", 10, "Interested"), msg("outbound", dt.datetime(2026, 10, 26, 9, tzinfo=UTC), "Could you confirm?")]
    assert rs.classify_thread(recent, ctx(contact_type="buyer", deal_linked=True), NOW)["tab"] is None  # 1 working day < 4


def test_follow_needs_an_ask_and_a_conversation():
    no_ask = [msg("inbound", 10, "Hi"), msg("outbound", 8, "Sent the documents.")]
    assert rs.classify_thread(no_ask, ctx(), NOW)["tab"] is None
    one_way = [msg("outbound", 8, "Would you like to buy packs?")]
    assert rs.classify_thread(one_way, ctx(), NOW)["tab"] is None


def test_follow_thresholds():
    assert rs.follow_threshold("buyer", True) == 4
    assert rs.follow_threshold("partner", True) == 4
    assert rs.follow_threshold("buyer", False) == 7
    assert rs.follow_threshold(None, False) == 7
    assert rs.follow_threshold("admin", False) == 7


def test_two_nudges_stop_chasing():
    msgs = [msg("inbound", 20, "Interested"), msg("outbound", 18, "Price?"), msg("outbound", 12, "Any news?"), msg("outbound", 6, "Still keen?")]
    r = rs.classify_thread(msgs, ctx(), NOW)
    assert r["tab"] == "other" and "nudges" in r["reason"]
    one_nudge = msgs[:3]
    assert rs.classify_thread(one_nudge, ctx(), NOW)["tab"] == "follow"


def test_follow_max_age():
    msgs = [msg("inbound", 40, "Interested"), msg("outbound", 31, "Price?")]
    assert rs.classify_thread(msgs, ctx(), NOW)["done_reason"] == "expired"


def test_working_days():
    fri = dt.datetime(2026, 10, 23, 17, tzinfo=UTC)
    assert rs.working_days_between(fri, dt.datetime(2026, 10, 26, 9, tzinfo=UTC)) == 1
    assert rs.working_days_between(fri, NOW) == 2


# ---------- promises, deadlines, priority ----------

def test_promise_detection():
    sent = dt.datetime(2026, 10, 19, 10, tzinfo=UTC)  # Monday
    p = rs.promise_due("Thanks Tom. I'll send the quote by Friday. Best", sent)
    assert p and p[1] == dt.date(2026, 10, 23)
    assert rs.promise_due("I'll get back to you tomorrow.", sent)[1] == dt.date(2026, 10, 20)
    assert rs.promise_due("I'll check with buyers.", sent) is None  # no explicit date
    assert rs.promise_due("Here is the spec sheet.", sent) is None


def test_deadline_detection():
    sent = NOW - dt.timedelta(hours=2)
    assert rs.deadline_due("Please confirm by end of day", sent) == sent.date()
    assert rs.deadline_due("Need an answer tomorrow", sent) == sent.date() + dt.timedelta(days=1)
    assert rs.deadline_due("The board decision is on Thursday", sent) is not None
    assert rs.deadline_due("Let me know what you think", sent) is None


def test_priority_rules():
    action = {"tab": "action", "waiting_since": NOW - dt.timedelta(hours=5)}
    overdue_msgs = [msg("outbound", 9, "I'll send the quote by Friday."), msg("inbound", 1, "Any update?")]
    assert rs.compute_priority(action, overdue_msgs, ctx(), NOW)[0] == "overdue"
    urgent_msgs = [msg("inbound", 0.1, "We need your answer today please")]
    assert rs.compute_priority(action, urgent_msgs, ctx(), NOW)[0] == "urgent"
    stale = [msg("inbound", 5, "We need your answer today please")]
    assert rs.compute_priority(action, stale, ctx(), NOW)[0] == "medium"  # a passed deadline is not urgent
    plain = [msg("inbound", 0.1, "What price?")]
    assert rs.compute_priority(action, plain, ctx(contact_type="buyer"), NOW)[0] == "high"
    assert rs.compute_priority(action, plain, ctx(deal_linked=True), NOW)[0] == "high"
    assert rs.compute_priority(action, plain, ctx(contact_type="supplier"), NOW)[0] == "medium"
    late = {"tab": "action", "waiting_since": NOW - dt.timedelta(hours=50)}
    assert rs.compute_priority(late, plain, ctx(contact_type="supplier"), NOW)[0] == "high"
    assert rs.compute_priority(action, plain, ctx(contact_type="admin"), NOW)[0] == "low"
    assert rs.compute_priority({"tab": "other"}, plain, ctx(contact_type="buyer"), NOW)[0] == "low"


def test_deal_label():
    assert rs.deal_label("Kokam cells", "13,104 units") == "Kokam cells · 13,104 units"
    label = rs.deal_label("41 complete FPT eBS69 69.3 kWh NMC packs in Turin, Italy; separate stock", "200 packs")
    assert label.startswith("41 complete FPT eBS69") and "·" in label and len(label) < 70


# ---------- LLM batching (mocked) ----------

def test_summarise_parses_and_survives_failures():
    calls = []

    def model(prompt):
        calls.append(prompt)
        if len(calls) == 2:
            raise RuntimeError("boom")
        return 'Sure:\n[{"key": "t1", "headline": "Wants price for 20 Kia packs", "context": "Tom asks — price.", ' \
               '"earlier": [{"who": "Alex", "when": "21 Oct", "summary": "Asked for photos"}], "contact_type": "buyer", "priority": "high"}]'

    found, n, errors = rs.summarise([[{"key": "t1"}], [{"key": "t2"}]], model=model)
    assert n == 2 and len(errors) == 1
    assert found["t1"]["contact_type"] == "buyer" and "—" not in found["t1"]["context"]
    assert "t2" not in found
    assert '"key": "t1"' in calls[0]


def test_fallback_summary():
    msgs = [msg("outbound", 3, "Can you send photos?"), msg("inbound", 1, "Here they are " + "x" * 400)]
    s = rs.fallback_summary("Re: Kia packs", msgs)
    assert s["headline"] == "Kia packs" and len(s["context"]) == 300 and s["earlier"][0]["who"] == "Alex"


# ---------- plan_writes (user state) ----------

def row(gid="t1", tab="action", newest="m2", newest_at=NOW, summarised=True, **kw):
    r = {"gmail_thread_id": gid, "tab": tab, "priority": "medium", "newest_message_id": newest, "newest_at": newest_at,
         "last_seen_message_id": newest, "summarised": summarised, "headline": "H", "context": "C", "earlier": [],
         "last_message": {"text": "x"}, "contact_type": "buyer", "mail_thread_id": "gmail_thread_" + gid}
    r.update(kw)
    return r


def item(status="open", last_seen="m1", updated=NOW - dt.timedelta(days=1), **kw):
    i = {"id": "i1", "gmail_thread_id": "t1", "status": status, "last_seen_message_id": last_seen, "updated_at": updated,
         "snooze_until": None, "done_reason": None, "tab": "action", "priority": "medium", "note": "mine",
         "headline": "old", "context": "old", "earlier": [], "contact_type": "buyer"}
    i.update(kw)
    return i


def test_plan_insert_new():
    ops = rs.plan_writes([row()], {}, NOW, {"t1"})
    assert ops[0]["op"] == "insert" and ops[0]["values"]["status"] == "open" and "note" not in ops[0]["values"]


def test_plan_done_item_reopens_only_on_new_message():
    same = rs.plan_writes([row(newest="m1")], {"t1": item(status="done", last_seen="m1")}, NOW, {"t1"})
    assert same == []
    newer = rs.plan_writes([row(newest="m2")], {"t1": item(status="done")}, NOW, {"t1"})
    assert newer[0]["kind"] == "reopen" and newer[0]["values"]["status"] == "open"
    review_old = rs.plan_writes([row(newest="m2", newest_at=NOW - dt.timedelta(days=2))], {"t1": item(status="review")}, NOW, {"t1"})
    assert review_old == []  # message predates the close


def test_plan_snoozed_only_content():
    ops = rs.plan_writes([row(tab="other")], {"t1": item(snooze_until=NOW + dt.timedelta(days=2))}, NOW, {"t1"})
    assert ops[0]["kind"] == "content" and "tab" not in ops[0]["values"] and "status" not in ops[0]["values"]


def test_plan_marks_replied_done():
    ops = rs.plan_writes([row(tab=None, done_reason="replied")], {"t1": item()}, NOW, {"t1"})
    assert ops[0]["kind"] == "done" and ops[0]["values"]["done_reason"] == "replied"


def test_plan_unsummarised_keeps_old_content():
    ops = rs.plan_writes([row(summarised=False, priority="high")], {"t1": item()}, NOW, {"t1"})
    v = ops[0]["values"]
    assert "headline" not in v and v.get("priority") == "high" and "last_seen_message_id" not in v


# ---------- DB write path against a scratch schema ----------

TEST_DB = os.environ.get("RELAY_TEST_DB", "stock_test_9e426f3f65c340ea8fbd892fd0fabf84")
SCHEMA = "relay_scan_t"
MIGRATION = Path(__file__).resolve().parents[2] / "apps/web/lib/crm-postgres/migrations/089_relay.sql"
TABLES = ["crm_users", "mail_thread", "mail_message", "work_tasks", "crm_bulk_listings", "crm_bulk_thread_links", "crm_people", "crm_companies"]


def psql(db, sql):
    return subprocess.run(["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", db], input=sql, text=True, capture_output=True)


@pytest.fixture
def scratch():
    if psql(TEST_DB, "select 1").returncode or psql("denchclaw", "select 1").returncode:
        pytest.skip("local Postgres not reachable")
    psql(TEST_DB, f"drop schema if exists {SCHEMA} cascade")
    dump = subprocess.run(["pg_dump", "-s", "-O", "-x", *sum([["-t", f"public.{t}"] for t in TABLES], []), "denchclaw"],
                          text=True, capture_output=True, check=True).stdout
    keep = []
    for line in dump.splitlines():
        if line.startswith(("SELECT pg_catalog.set_config('search_path'", "CREATE TRIGGER", "\\restrict", "\\unrestrict")):
            continue
        keep.append(line)
    ddl = "\n".join(keep).replace("public.", f"{SCHEMA}.")
    # Foreign keys to tables outside the copied set and triggers are not needed for the scan.
    import re
    ddl = re.sub(r"ALTER TABLE ONLY [^;]*?FOREIGN KEY[^;]*?REFERENCES " + SCHEMA + r"\.(?!(" + "|".join(TABLES) + r")\b)[^;]*;", "", ddl, flags=re.S)
    setup = f"create schema {SCHEMA};\nset search_path = {SCHEMA}, public;\n{ddl}\n"
    res = psql(TEST_DB, setup)
    assert res.returncode == 0, res.stderr[-2000:]
    migration = MIGRATION.read_text().replace("grant select", "-- grant select")
    res = psql(TEST_DB, f"set search_path = {SCHEMA}, public;\n{migration}")
    assert res.returncode == 0, res.stderr[-2000:]
    yield
    psql(TEST_DB, f"drop schema if exists {SCHEMA} cascade")


def test_db_write_path(scratch, monkeypatch, tmp_path, capsys):
    owner = "7b98322f-e439-4000-97ce-cce1c36a0d2a"
    t = lambda days: (NOW_REAL - dt.timedelta(days=days)).isoformat()
    NOW_REAL = dt.datetime.now(UTC)
    # Two weekdays back at least 6 calendar days so the buyer chase is due regardless of today's weekday.
    fixtures = f"""
    set search_path = {SCHEMA}, public;
    insert into crm_users (id, email, password_hash) values ('{owner}', 'alex@rebattery.io', 'x');
    insert into mail_thread (id, gmail_thread_id, mailbox_owner_id, subject, last_message_at) values
      ('gmail_thread_a', 'a', '{owner}', 'Kia packs', '{t(1)}'),
      ('gmail_thread_f', 'f', '{owner}', 'Kokam cells', '{t(6)}'),
      ('gmail_thread_n', 'n', '{owner}', 'Newsletter', '{t(1)}');
    insert into mail_message (id, direction, transport, purpose, mailbox_owner_id, thread_id, subject, body_text, from_email, to_emails, state, sent_at, gmail_message_id) values
      ('ma1', 'outbound', 'gmail', 'personal', '{owner}', 'gmail_thread_a', 'Kia packs', 'Can you send photos?', 'alex@rebattery.io', '{{tom@dealer.no}}', 'accepted', '{t(3)}', 'ga1'),
      ('ma2', 'inbound', 'gmail', null, '{owner}', 'gmail_thread_a', 'Re: Kia packs', E'What price can you do for 20 packs?\\n\\nOn Mon, Alex wrote:\\n> Can you send photos?', 'tom@dealer.no', '{{alex@rebattery.io}}', 'received', '{t(1)}', 'ga2'),
      ('mf1', 'inbound', 'gmail', null, '{owner}', 'gmail_thread_f', 'Kokam cells', 'We want Kokam cells', 'buyer@cells.example', '{{alex@rebattery.io}}', 'received', '{t(9)}', 'gf1'),
      ('mf2', 'outbound', 'gmail', 'personal', '{owner}', 'gmail_thread_f', 'Re: Kokam cells', 'Would you take EUR 35 per cell?', 'alex@rebattery.io', '{{buyer@cells.example}}', 'accepted', '{t(6)}', 'gf2'),
      ('mn1', 'inbound', 'gmail', null, '{owner}', 'gmail_thread_n', 'Newsletter', 'News', 'noreply@news.example', '{{alex@rebattery.io}}', 'received', '{t(1)}', 'gn1');
    insert into crm_bulk_listings (id, kind, party, summary, quantity, status, email) values ('bl1', 'demand', 'Cells buyer', 'Kokam cells', '13,104 units', 'open', 'buyer@cells.example'),
      ('bl2', 'supply', 'us', 'Kokam cells from Firstground', '85,000 cells', 'open', 'helmuth@firstground.example');
    insert into crm_bulk_thread_links (channel, thread_id, bulk_listing_id, confidence, state, labelled_by, confirmed_by)
      values ('mail', 'gmail_thread_f', 'bl2', 'high', 'confirmed', 'test', 'test');
    """
    res = psql(TEST_DB, fixtures)
    assert res.returncode == 0, res.stderr[-2000:]
    triage = tmp_path / "triage"
    triage.mkdir()
    (triage / "state.json").write_text(json.dumps({"threads": {"a": {"automated_state": "1 Action", "automated_stream": "Deal"}}}))
    (triage / "briefs.json").write_text(json.dumps({"a": {"contact_type": "supplier", "who": "Tom"}}))
    monkeypatch.setattr(rs, "run_hermes", lambda prompt: json.dumps([
        {"key": "a", "headline": "Wants a price for 20 packs", "context": "Tom asks for a price.", "earlier": [], "contact_type": "supplier", "priority": "medium"},
        {"key": "f", "headline": "Waiting on Kokam answer", "context": "Alex offered EUR 35.", "earlier": [], "contact_type": "buyer", "priority": "high"},
    ]))
    dsn = f"host=/var/run/postgresql dbname={TEST_DB}"
    args = ["--apply", "--dsn", dsn, "--schema", SCHEMA, "--triage-dir", str(triage)]
    assert rs.main(args) == 0
    out = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert out["new"] == 2 and out["llm_calls"] == 1 and out["errors"] == []

    rows = subprocess.run(["psql", "-X", "-At", "-d", TEST_DB, "-c",
                           f"select gmail_thread_id, tab, priority, status, headline, deal_label, last_message->>'text', last_seen_message_id from {SCHEMA}.relay_item order by 1"],
                          text=True, capture_output=True, check=True).stdout.strip().splitlines()
    assert rows[0].split("|")[:6] == ["a", "action", "medium", "open", "Wants a price for 20 packs", ""]
    assert rows[0].split("|")[6] == "What price can you do for 20 packs?"
    assert rows[1].split("|")[:6] == ["f", "follow", "high", "open", "Waiting on Kokam answer", "Kokam cells · 13,104 units"]

    # User sets a note; Alex replies to Tom. Next run marks it done and keeps the note.
    psql(TEST_DB, f"""set search_path = {SCHEMA}, public;
      update relay_item set note = 'call him' where gmail_thread_id = 'a';
      insert into mail_message (id, direction, transport, purpose, mailbox_owner_id, thread_id, subject, body_text, from_email, to_emails, state, sent_at, gmail_message_id)
      values ('ma3', 'outbound', 'gmail', 'personal', '{owner}', 'gmail_thread_a', 'Re: Kia packs', 'EUR 1,500 each.', 'alex@rebattery.io', '{{tom@dealer.no}}', 'accepted', now(), 'ga3');""")
    assert rs.main(args) == 0
    out = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert out["done"] == 1 and out["llm_calls"] == 0
    a = subprocess.run(["psql", "-X", "-At", "-d", TEST_DB, "-c",
                        f"select status, done_reason, note from {SCHEMA}.relay_item where gmail_thread_id = 'a'"],
                       text=True, capture_output=True, check=True).stdout.strip()
    assert a == "done|replied|call him"


def _listing(id, kind, status, summary, email):
    return {"id": id, "kind": kind, "status": status, "summary": summary, "quantity": None,
            "updated_at": dt.datetime(2026, 10, 1, tzinfo=UTC), "email": email}


def test_choose_deal_links_the_buyers_own_demand_not_the_supply():
    stn = "jason@stnpower.com"
    owned = {stn: [_listing("d1", "demand", "open", "Toyota Proace 50 kWh trial pack", stn),
                   _listing("d2", "demand", "open", "52 kWh LFP Stellantis van packs", stn)]}
    owned["@stnpower.com"] = owned[stn]
    # The thread is tagged with Iveco's supply listing, which STN does not own.
    got = rs.choose_deal(stn, "buyer", {"iveco-supply"}, "Re: Stellantis 52 kWh LFP packs for the vans", owned)
    assert got["bulk_listing_id"] == "d2"


def test_choose_deal_prefers_the_tagged_own_listing_and_supply_for_suppliers():
    sup = "sven@b30.eu"
    owned = {sup: [_listing("s1", "supply", "open", "ZOE modules", sup), _listing("x", "demand", "open", "cells", sup)]}
    assert rs.choose_deal(sup, "supplier", {"s1"}, "hello", owned)["bulk_listing_id"] == "s1"


def test_choose_deal_none_when_nothing_owned_or_only_unrelated_closed():
    assert rs.choose_deal("a@b.com", "buyer", {"someone-else"}, "packs", {}) is None
    owned = {"a@b.com": [_listing("c", "demand", "closed", "Lucid Air packs", "a@b.com")]}
    assert rs.choose_deal("a@b.com", "buyer", set(), "Kona packs", owned) is None
