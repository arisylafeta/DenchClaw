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
    ("ana@naturgy.com", "Respuesta automática: Supply Update"), ("jan@x.nl", "Automatisch antwoord: Kia"),
    ("eva@x.pl", "Automatyczna odpowiedź: packs"), ("luc@x.fr", "Réponse automatique : packs"),
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



def test_spam_kept_when_it_replies_to_us():
    postmark = msg("inbound", 1, "Yes, still for sale", labels=["SPAM"], in_reply_to="<872149c5-9e74@mtasv.net>")
    in_thread = [msg("outbound", 3, "How many packs?"), msg("inbound", 1, "Twelve", labels=["SPAM"])]
    stranger = msg("inbound", 1, "Cheap SEO", labels=["SPAM"], in_reply_to="<abc@mail.gmail.com>")
    assert [m["text"] for m in rs.real_messages([postmark])] == ["Yes, still for sale"]
    assert [m["text"] for m in rs.real_messages(in_thread)] == ["How many packs?", "Twelve"]
    assert rs.real_messages([stranger]) == []
    assert rs.real_messages([{**postmark, "labels": ["SPAM", "TRASH"]}]) == []

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



def test_action_from_fresh_triage_proposal():
    msgs = [msg("inbound", 1, "We have 1,000 Polarium modules for sale.", frm="ryan@broker.example", mid="g7")]
    fresh = ctx(known=False, triage={"automated_state": None, "proposed_state": "1 Action", "last_classified_message_id": "g7"})
    stale = ctx(known=False, triage={"automated_state": None, "proposed_state": "1 Action", "last_classified_message_id": "g6"})
    assert rs.classify_thread(msgs, fresh, NOW)["tab"] == "action"
    assert rs.classify_thread(msgs, stale, NOW)["tab"] == "other"


def test_reply_to_our_postmark_send_is_action():
    reply = msg("inbound", 1, "Yes, still for sale.", frm="dave@outlook.example",
                in_reply_to="<872149c5-9e74@mtasv.net>")
    assert rs.classify_thread([reply], ctx(known=False), NOW)["tab"] == "action"

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

def row(gid="t1", tab="action", newest="m2", summarised=True, **kw):
    r = {"gmail_thread_id": gid, "tab": tab, "priority": "medium", "newest_message_id": newest, "new_message": True, "seen_known": True,
         "last_seen_message_id": newest, "summary_message_id": newest if summarised else None, "summarised": summarised, "headline": "H", "context": "C", "earlier": [],
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
    same = rs.plan_writes([row(newest="m1", new_message=False, seen_known=True)], {"t1": item(status="done", last_seen="m1")}, NOW, {"t1"})
    assert same == []
    newer = rs.plan_writes([row(newest="m2", new_message=True, seen_known=True)], {"t1": item(status="done", user_tab="action")}, NOW, {"t1"})
    assert newer[0]["kind"] == "reopen" and newer[0]["values"]["status"] == "open" and newer[0]["values"]["user_tab"] is None
    review_seen = rs.plan_writes([row(newest="m2", new_message=False, seen_known=True)], {"t1": item(status="review")}, NOW, {"t1"})
    assert review_seen == []


def test_plan_closed_item_with_unknown_last_seen_adopts_without_reopening():
    ops = rs.plan_writes([row(newest="m2", new_message=False, seen_known=False)], {"t1": item(status="review", last_seen=None)}, NOW, {"t1"})
    assert ops == [{"op": "update", "gmail_thread_id": "t1", "id": "i1", "kind": "adopt", "values": {"last_seen_message_id": "m2"}}]


def test_reply_synced_after_done_still_counts_as_new():
    # Tom replied at 11:55; Alex clicked Done at 12:00 without seeing it; the sync brought it in at 12:30.
    seen = msg("outbound", NOW - dt.timedelta(hours=3), mid="m1")
    reply = msg("inbound", NOW - dt.timedelta(minutes=5), "Any update?", mid="m2")
    assert rs.newer_than([seen, reply], reply, "m1") == (True, True)
    assert rs.newer_than([seen, reply], seen, "m1") == (False, True)
    assert rs.newer_than([seen, reply], reply, None) == (False, False)
    assert rs.newer_than([reply], reply, "gone") == (False, False)
    ops = rs.plan_writes([row(newest="m2", new_message=True, seen_known=True)],
                         {"t1": item(status="done", done_reason="user_done", updated=NOW + dt.timedelta(minutes=30))}, NOW, {"t1"})
    assert ops[0]["kind"] == "reopen"


def test_alex_own_send_does_not_reopen_but_a_due_chase_does():
    # A third chase sent from Relay closes the item as sent; it must not bounce back into Other.
    third = rs.plan_writes([row(tab="other", newest="m4", new_message=False, seen_known=True)],
                           {"t1": item(status="done", done_reason="sent", last_seen="m3")}, NOW, {"t1"})
    assert third == []
    due = rs.plan_writes([row(tab="follow", newest="m4", new_message=False, seen_known=True)],
                         {"t1": item(status="done", done_reason="sent", last_seen="m3")}, NOW, {"t1"})
    assert due[0]["kind"] == "reopen" and due[0]["values"]["tab"] == "follow"


def test_closed_as_replied_but_still_waiting_reopens_in_action():
    # An answer that no longer counts (a reply in another conversation) leaves the thread waiting on Alex: back to Action.
    ops = rs.plan_writes([row(tab="action", newest="m1", new_message=False, seen_known=True)],
                         {"t1": item(status="done", done_reason="replied", last_seen="m1")}, NOW, {"t1"})
    assert ops[0]["kind"] == "reopen" and ops[0]["values"]["tab"] == "action"
    assert rs.plan_writes([row(tab="action", newest="m1", new_message=False, seen_known=True)],
                          {"t1": item(status="done", done_reason="user_done", last_seen="m1")}, NOW, {"t1"}) == []


def test_dont_chase_stays_dismissed_until_they_write():
    # "Don't chase" closes a Follow up item with done_reason no_chase: a due chase never reopens it, their reply does.
    due = rs.plan_writes([row(tab="follow", newest="m4", new_message=False, seen_known=True)],
                         {"t1": item(status="done", done_reason="no_chase", last_seen="m3")}, NOW, {"t1"})
    assert due == []
    replied = rs.plan_writes([row(tab="action", newest="m5", new_message=True, seen_known=True)],
                             {"t1": item(status="done", done_reason="no_chase", last_seen="m3")}, NOW, {"t1"})
    assert replied[0]["kind"] == "reopen" and replied[0]["values"]["tab"] == "action"


def test_sender_rule_covers_subdomains():
    assert rs.sender_rule({"@acme.com": "other"}, "Bob <bob@uk.acme.com>") == "other"
    assert rs.sender_rule({"@acme.com": "other", "bob@uk.acme.com": "action"}, "bob@uk.acme.com") == "action"
    assert rs.sender_rule({"@acme.com": "other"}, "bob@notacme.com") is None


def test_older_internal_last_seen_does_not_reopen():
    # Old rows recorded any newest message; an internal note newer than the last real message is not "new".
    real = msg("inbound", NOW - dt.timedelta(hours=5), "Price?", mid="m1")
    internal = msg("inbound", NOW - dt.timedelta(hours=1), "fyi", frm="ari@rebattery.io", mid="m9")
    assert rs.newer_than([real, internal], real, "m9") == (False, True)


# ---------- the owner's choices: moved tabs and sender rules ----------

def test_moved_tab_holds_until_a_newer_message():
    first = msg("inbound", 2, "FYI our new price list", mid="m1")
    other = {"tab": "other", "reason": "unsolicited or FYI", "counterpart_email": "tom@dealer.no", "waiting_since": first["at"]}
    moved = {"status": "open", "user_tab": "action", "user_tab_seen_id": "m1", "last_seen_message_id": "m1"}
    held, clear = rs.apply_user_choices(other, first, moved, [first], {})
    assert held["tab"] == "action" and held["reason"] == "moved by you" and not clear
    expired = {"tab": None, "reason": "older than window", "done_reason": "expired", "counterpart_email": "tom@dealer.no"}
    assert rs.apply_user_choices(expired, first, moved, [first], {})[0]["tab"] == "action"
    replied = {"tab": None, "reason": "owner wrote to them since", "done_reason": "replied"}
    assert rs.apply_user_choices(replied, first, moved, [first], {}) == (replied, False)
    later = msg("inbound", 1, "Also, are you at the show?", mid="m2")
    again, clear = rs.apply_user_choices(other, later, moved, [first, later], {})
    assert again["tab"] == "other" and clear


def test_moved_tab_ignored_once_closed():
    first = msg("inbound", 2, "hi", mid="m1")
    other = {"tab": "other", "reason": "x", "counterpart_email": "tom@dealer.no"}
    assert rs.apply_user_choices(other, first, {"status": "done", "user_tab": "action"}, [first], {}) == (other, False)


def test_sender_rules_by_email_then_domain_inbound_only():
    rules = {"tom@dealer.no": "action", "@spam.example": "other"}
    inbound = msg("inbound", 1, "FYI", mid="m1")
    other = {"tab": "other", "reason": "unsolicited or FYI", "counterpart_email": "tom@dealer.no"}
    assert rs.apply_user_choices(other, inbound, None, [inbound], rules)[0] == {**other, "tab": "action", "reason": "sender rule: action"}
    pitch = msg("inbound", 1, "Can you quote?", frm="bob@spam.example", mid="m2")
    action = {"tab": "action", "reason": "inbound question or request", "counterpart_email": "bob@spam.example"}
    assert rs.apply_user_choices(action, pitch, None, [pitch], rules)[0]["tab"] == "other"
    chase = msg("outbound", 5, "Any news?", to=["bob@spam.example"], mid="m3")
    follow = {"tab": "follow", "reason": "no reply", "counterpart_email": "bob@spam.example"}
    assert rs.apply_user_choices(follow, chase, None, [chase], rules)[0]["tab"] == "follow"
    none = {"tab": None, "reason": "owner wrote to them since", "done_reason": "replied", "counterpart_email": "tom@dealer.no"}
    assert rs.apply_user_choices(none, inbound, None, [inbound], rules)[0]["tab"] is None


def test_plan_snoozed_only_content():
    ops = rs.plan_writes([row(tab="other")], {"t1": item(snooze_until=NOW + dt.timedelta(days=2))}, NOW, {"t1"})
    assert ops[0]["kind"] == "content" and "tab" not in ops[0]["values"] and "status" not in ops[0]["values"]


def test_plan_marks_replied_done():
    ops = rs.plan_writes([row(tab=None, done_reason="replied")], {"t1": item()}, NOW, {"t1"})
    assert ops[0]["kind"] == "done" and ops[0]["values"]["done_reason"] == "replied"


def test_plan_unsummarised_keeps_old_content():
    ops = rs.plan_writes([row(summarised=False, priority="high", summary_message_id=None)], {"t1": item(summary_message_id="m1")}, NOW, {"t1"})
    v = ops[0]["values"]
    assert "headline" not in v and v.get("priority") == "high"
    # last_seen moves on (so a later close knows what was seen); the summary is retried next run.
    assert v["last_seen_message_id"] == "m2" and "summary_message_id" not in v


def test_plan_clears_user_tab_on_new_message():
    ops = rs.plan_writes([row(tab="other", clear_user_tab=True)], {"t1": item(tab="action", user_tab="action")}, NOW, {"t1"})
    assert ops[0]["values"]["user_tab"] is None and ops[0]["values"]["tab"] == "other"


# ---------- DB write path against a scratch schema ----------

TEST_DB = os.environ.get("RELAY_TEST_DB", "stock_test_9e426f3f65c340ea8fbd892fd0fabf84")
SCHEMA = "relay_scan_t"
MIGRATIONS = [Path(__file__).resolve().parents[2] / f"apps/web/lib/crm-postgres/migrations/{name}" for name in ("089_relay.sql", "098_relay_sticky_fresh.sql", "099_relay_voice.sql")]
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
    for path in MIGRATIONS:
        migration = path.read_text().replace("grant select", "-- grant select")
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
      values ('mail', 'gmail_thread_f', 'bl2', 'high', 'confirmed', 'test', 'test'),
      -- Alex linked Tom's quote to the cells buyer's request with "Link to deal": it stays, though Tom doesn't own that deal.
             ('mail', 'gmail_thread_a', 'bl1', 'high', 'confirmed', 'relay', 'alex@rebattery.io');
    """
    res = psql(TEST_DB, fixtures)
    assert res.returncode == 0, res.stderr[-2000:]
    triage = tmp_path / "triage"
    triage.mkdir()
    (triage / "state.json").write_text(json.dumps({"threads": {"a": {"automated_state": "1 Action", "automated_stream": "Deal"}}}))
    (triage / "briefs.json").write_text(json.dumps({"a": {"contact_type": "supplier", "who": "Tom"}}))
    monkeypatch.setattr(rs, "run_hermes", lambda prompt: json.dumps([
        {"key": "a", "headline": "Wants a price for 20 packs", "context": "Tom asks for a price.", "earlier": [], "contact_type": "supplier", "priority": "medium", "situation": "supplier_price"},
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
    assert rows[0].split("|")[:6] == ["a", "action", "high", "open", "Wants a price for 20 packs", "Kokam cells · 13,104 units"]
    assert rows[0].split("|")[6] == "What price can you do for 20 packs?"
    assert subprocess.run(["psql", "-X", "-At", "-d", TEST_DB, "-c", f"select situation from {SCHEMA}.relay_item where gmail_thread_id = 'a'"],
                          text=True, capture_output=True, check=True).stdout.strip() == "supplier_price"
    assert rows[1].split("|")[:6] == ["f", "follow", "high", "open", "Waiting on Kokam answer", "Kokam cells · 13,104 units"]

    # Alex answers Tom inside a different, older conversation (Tom wrote there first): Tom's price question stays open.
    psql(TEST_DB, f"""set search_path = {SCHEMA}, public;
      insert into mail_thread (id, gmail_thread_id, mailbox_owner_id, subject, last_message_at) values ('gmail_thread_o', 'o', '{owner}', 'Collection', now());
      insert into mail_message (id, direction, transport, purpose, mailbox_owner_id, thread_id, subject, body_text, from_email, to_emails, state, sent_at, gmail_message_id) values
        ('mo1', 'inbound', 'gmail', null, '{owner}', 'gmail_thread_o', 'Collection', 'When can you collect?', 'tom@dealer.no', '{{alex@rebattery.io}}', 'received', '{t(5)}', 'go1'),
        ('mo2', 'outbound', 'gmail', 'personal', '{owner}', 'gmail_thread_o', 'Re: Collection', 'Thursday works.', 'alex@rebattery.io', '{{tom@dealer.no}}', 'accepted', now(), 'go2');""")
    assert rs.main(args) == 0
    capsys.readouterr()
    assert subprocess.run(["psql", "-X", "-At", "-d", TEST_DB, "-c", f"select status, tab from {SCHEMA}.relay_item where gmail_thread_id = 'a'"],
                          text=True, capture_output=True, check=True).stdout.strip() == "open|action"

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

    # Alex marks the Kokam chase done; a reply sent before that click reaches the CRM only afterwards. It reopens.
    q = lambda sql: subprocess.run(["psql", "-X", "-At", "-d", TEST_DB, "-c", sql], env={**os.environ, "PGOPTIONS": f"-c search_path={SCHEMA},public"},
                                   text=True, capture_output=True, check=True).stdout.strip()
    q("update relay_item set status = 'done', done_reason = 'user_done', updated_at = now() + interval '1 hour' where gmail_thread_id = 'f'")
    psql(TEST_DB, f"""set search_path = {SCHEMA}, public;
      insert into mail_message (id, direction, transport, purpose, mailbox_owner_id, thread_id, subject, body_text, from_email, to_emails, state, sent_at, gmail_message_id)
      values ('mf3', 'inbound', 'gmail', null, '{owner}', 'gmail_thread_f', 'Re: Kokam cells', 'Can you do 33 per cell instead?', 'buyer@cells.example', '{{alex@rebattery.io}}', 'received', now() - interval '5 minutes', 'gf3');""")
    assert rs.main(args) == 0
    out = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert out["reopened"] == 1
    assert q("select status, tab, last_seen_message_id, summary_message_id from relay_item where gmail_thread_id = 'f'") == "open|action|mf3|mf3"

    # Alex moves a newsletter-like FYI to Action: the next scan keeps it there.
    psql(TEST_DB, f"""set search_path = {SCHEMA}, public;
      insert into mail_thread (id, gmail_thread_id, mailbox_owner_id, subject, last_message_at) values ('gmail_thread_p', 'p', '{owner}', 'Price list', now());
      insert into mail_message (id, direction, transport, purpose, mailbox_owner_id, thread_id, subject, body_text, from_email, to_emails, state, sent_at, gmail_message_id)
      values ('mp1', 'inbound', 'gmail', null, '{owner}', 'gmail_thread_p', 'Price list', 'Our autumn price list for modules.', 'sales@newco.example', '{{alex@rebattery.io}}', 'received', now() - interval '1 hour', 'gp1');""")
    assert rs.main(args) == 0
    capsys.readouterr()
    assert q("select tab from relay_item where gmail_thread_id = 'p'") == "other"
    q("update relay_item set tab = 'action', user_tab = 'action', user_tab_seen_id = last_seen_message_id where gmail_thread_id = 'p'")
    assert rs.main(args) == 0
    capsys.readouterr()
    assert q("select tab, user_tab from relay_item where gmail_thread_id = 'p'") == "action|action"

    # A move made while a scan was running survives that scan's write; clearing the move sets the tab outright.
    conn = rs.psycopg2.connect(dsn, options=f"-c search_path={SCHEMA},public")
    pid = q("select id from relay_item where gmail_thread_id = 'p'")
    rs.apply_ops(conn, owner, [{"op": "update", "id": pid, "kind": "update", "gmail_thread_id": "p", "values": {"tab": "other"}}])
    assert q("select tab from relay_item where gmail_thread_id = 'p'") == "action"
    rs.apply_ops(conn, owner, [{"op": "update", "id": pid, "kind": "update", "gmail_thread_id": "p", "values": {"tab": "other", **rs.CLEAR_USER_TAB}}])
    assert q("select tab, coalesce(user_tab, '-') from relay_item where gmail_thread_id = 'p'") == "other|-"
    conn.close()
    assert q("select errors::text from relay_scan_run") == "[]"


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


def test_choose_deal_never_links_a_supplier_to_someone_elses_demand():
    rob = "rob@donkersvagparts.nl"
    # The thread is tagged with R3's demand (Rob's colleague is a candidate on it), but Rob owns no listing.
    assert rs.choose_deal(rob, "supplier", {"r3-demand"}, "What do you offer for 58 kW packs?", {}) is None


@pytest.mark.parametrize("text,lot", [
    ("8.44 MWh Polarium Lithium Battery Lot | 1,000 Modules | Georgia", "8.44 MWh"),
    ("a 1,000-unit lot of commercial lithium telecom batteries", "1,000-unit"),
    ("Re: 677,000 Panasonic 21700 cells", "677,000 cells"),
    ("Wir haben 1.200 kWh an Modulen", "1.200 kWh"),
    ("We have 120 packs from a fleet", "120 packs"),
    ("One 13.8kWh Outlander pack, 2 modules", None),
    ("Roughly 2-2.2 KWH", None),
    ("We have 30 packs", None),
    ("320 US2000 modules, 10 pallets", "320 modules"),
    ("Recliner with 18650 batteries", None),
    ("Re: Your Jaguar Land Rover LR166066 packs", None),
    ("R: [EXTERNAL]Fiat e500 packs", None),
    ("In 2026 Tesla packs got cheaper", None),
    ("Contact Rex 07938309456 320 US2000 modules", "320 modules"),
    ("Indicative budget: around €1,200–3,500 per battery pack", None),
    ("load and unload the 370 kg battery pack", None),
])
def test_large_lot(text, lot):
    assert (rs.large_lot(text) is not None) == (lot is not None)


def test_large_lot_is_urgent():
    msgs = [msg("inbound", 1, "a 1,000-unit lot of telecom batteries for sale", subject="Polarium lot")]
    pr, why = rs.compute_priority({"tab": "action"}, msgs, ctx(contact_type="supplier"), NOW)
    assert pr == "urgent" and "1,000" in why
    assert rs.compute_priority({"tab": "action"}, msgs, ctx(contact_type="admin"), NOW)[0] != "urgent"


def test_new_lead_is_urgent():
    msgs = [msg("inbound", 1, "Do you buy used Tesla packs? We have some.", frm="new@seller.example")]
    pr, why = rs.compute_priority({"tab": "action"}, msgs, ctx(contact_type="supplier", first_contact=True), NOW)
    assert pr == "urgent" and why == "new lead: supplier"
    assert rs.compute_priority({"tab": "action"}, msgs, ctx(contact_type="supplier", first_contact=False), NOW)[0] != "urgent"
    assert rs.compute_priority({"tab": "action"}, msgs, ctx(contact_type="logistics", first_contact=True), NOW)[0] != "urgent"
    replied = [msg("outbound", 2, "Which packs?"), msgs[0]]
    assert rs.compute_priority({"tab": "action"}, replied, ctx(contact_type="supplier", first_contact=True), NOW)[0] != "urgent"


# ---------- a deal's other contacts (migration 112) ----------

class FakeCursor:
    """Answers table_exists and returns the given rows for the listing query, recording the SQL it was sent."""
    def __init__(self, rows, tables=("crm_bulk_listings", "crm_bulk_offers")):
        self.rows, self.tables, self.sql, self._next = rows, set(tables), [], None

    def execute(self, sql, params=None):
        self.sql.append(sql)
        self._next = [{"ok": params[0] in self.tables}] if "to_regclass" in sql else self.rows

    def fetchone(self):
        return self._next[0]

    def fetchall(self):
        return self._next


def test_owned_listings_include_the_deals_other_contacts():
    at = NOW - dt.timedelta(days=1)
    row = {"id": "btd_1", "kind": "demand", "status": "open", "summary": "Kona packs", "quantity": "20 packs", "updated_at": at}
    cur = FakeCursor([{**row, "email": "main@buyer.example"}, {**row, "email": "second@buyer.example"}])
    owned = rs.load_owned_listings(cur)
    assert "role = 'contact'" in cur.sql[-1]
    assert [r["id"] for r in owned["second@buyer.example"]] == ["btd_1"]
    # The second contact's email now links their thread to the same deal.
    assert rs.choose_deal("second@buyer.example", "buyer", set(), "Re: Kona packs", owned)["bulk_listing_id"] == "btd_1"


def test_owned_listings_without_the_offers_table_reads_listings_only():
    cur = FakeCursor([], tables=("crm_bulk_listings",))
    rs.load_owned_listings(cur)
    assert "crm_bulk_offers" not in cur.sql[-1]
