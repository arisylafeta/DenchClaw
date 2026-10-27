"""Tests for relay_tasks.py: hashing, user state, link resolution and the write path against a scratch schema.

Run: /usr/bin/python3 -m pytest scripts/rebattery/test_relay_tasks.py -q
The model is always mocked. DB tests need the local Postgres scratch database (RELAY_TEST_DB) and denchclaw for
schema copies; they are skipped when either is unreachable.
"""
import argparse
import datetime as dt
import importlib.util
import json
import os
import re
import subprocess
from pathlib import Path

import psycopg2
import psycopg2.extras
import pytest

spec = importlib.util.spec_from_file_location("relay_tasks", Path(__file__).with_name("relay_tasks.py"))
rt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rt)

UTC = dt.timezone.utc
NOW = dt.datetime(2026, 10, 27, 12, 0, tzinfo=UTC)

DETAILS_SHAUN = """What to do: Highlight the wanted tag numbers in Shaun's batteries list and send it back
Why: Shaun Dunn at Silverlake sent a list of EV batteries in stock and asked Alex to highlight the tag numbers.
Source: email from Shaun Dunn <shaund@silverlake.co.uk>, subject "RE: Battery list"
Gmail: https://mail.google.com/mail/u/0/#all/19fd205b19b67eac
When done: mark this task Done."""


def task(id="t1", key="REB-1", title="Reply to Shaun", status="Planned", details=DETAILS_SHAUN, manual=False):
    return {"id": id, "reb_key": key, "title": title, "status": status, "priority": "P2", "task_details": details,
            "created_at": NOW - dt.timedelta(days=3), "updated_at": NOW, "manual": manual}


def args(**kw):
    base = {"no_llm": False, "limit": None}
    base.update(kw)
    return argparse.Namespace(**base)


def model_reply(*items):
    return lambda prompt: "Here you go:\n```json\n" + json.dumps(list(items)) + "\n```"


def cls(key="REB-1", **kw):
    base = {"key": key, "category": "trade", "title": "Send Shaun the wanted tag numbers",
            "next_step": "Highlight the tags you want and send the list back.", "urgent_reason": None, "due_at": None,
            "action": "draft", "action_label": "Draft reply", "action_note": "Send back the list with the wanted tags highlighted",
            "link_kind": "mail", "link_label": "Shaun Dunn, Silverlake", "counterpart_email": "shaund@silverlake.co.uk",
            "subject": "RE: Battery list", "listing_words": []}
    base.update(kw)
    return base


# ---------- parsing ----------

def test_parse_details_reads_source_subject_gmail_id():
    f = rt.parse_details(DETAILS_SHAUN)
    assert f["gmail_thread_id"] == "19fd205b19b67eac"
    assert f["source_email"] == "shaund@silverlake.co.uk" and f["source_name"] == "Shaun Dunn"
    assert f["subject"] == "RE: Battery list"
    assert f["what"].startswith("Highlight the wanted tag numbers")
    quoted = rt.parse_details("Source: Alex Gmail thread 19db07a47a65e4b8, subject 'Draft profile for A3 Aprofitament in the ReBattery directory'. More")
    assert quoted["gmail_thread_id"] == "19db07a47a65e4b8"
    assert quoted["subject"] == "Draft profile for A3 Aprofitament in the ReBattery directory"
    assert rt.parse_details("See https://www.rebattery.io/listings/abc123, thanks")["urls"] == ["https://www.rebattery.io/listings/abc123"]


def test_parse_classifications_cleans_text_and_validates():
    out = rt.parse_classifications(json.dumps([{"key": "REB-1", "category": "mine", "title": "Reply — now",
                                                "action": "weird", "due_at": "2026-10-30", "link_kind": "nope",
                                                "urgent_reason": "null", "counterpart_email": "not an email"}]))
    c = out["REB-1"]
    assert c["category"] == "other"  # the model may not claim 'mine'
    assert "—" not in c["title"] and c["action"] == "open" and c["due_at"] == dt.date(2026, 10, 30)
    assert c["link_kind"] is None and c["urgent_reason"] is None and c["counterpart_email"] is None


def test_source_hash_tracks_title_status_details():
    a = task()
    assert rt.source_hash(a) == rt.source_hash(dict(a))
    assert rt.source_hash(a) != rt.source_hash({**a, "status": "In Progress"})
    assert rt.source_hash(a) != rt.source_hash({**a, "task_details": a["task_details"] + "x"})
    assert rt.source_hash(a) != rt.source_hash({**a, "title": "other"})


# ---------- plan (model and link resolution mocked) ----------

@pytest.fixture
def links(monkeypatch):
    found = {"relay_item_id": None, "mail_thread_id": "mt1", "bulk_listing_id": None, "link_url": None}
    monkeypatch.setattr(rt, "resolve_links", lambda cur, owner, task, facts, hints: dict(found))
    return found


def test_hash_skips_unchanged_tasks(links):
    t1, t2 = task(), task(id="t2", key="REB-2", title="Changed task")
    meta = {"t1": {"source_hash": rt.source_hash(t1), "classified_at": NOW},
            "t2": {"source_hash": "stale", "classified_at": NOW}}
    calls = []

    def model(prompt):
        calls.append(prompt)
        return json.dumps([cls("REB-2")])

    res = rt.plan(None, "owner", [t1, t2], meta, args(), NOW, model=model)
    assert res["skipped"] == 1 and [r["work_task_id"] for r in res["rows"]] == ["t2"]
    assert len(calls) == 1 and "REB-2" in calls[0] and "REB-1" not in calls[0]
    assert res["rows"][0]["source_hash"] == rt.source_hash(t2)


def test_manual_task_is_mine_without_model(links):
    def model(prompt):
        raise AssertionError("model must not be called for manual tasks")

    t = task(title="Call the bank", details="Due Fri 30 Oct", manual=True)
    res = rt.plan(None, "owner", [t], {}, args(), NOW, model=model)
    row = res["rows"][0]
    assert row["category"] == "mine" and row["title"] == "Call the bank" and row["action_kind"] == "none"
    assert row["source_hash"] == rt.source_hash(t) and res["llm_calls"] == 0


def test_draft_only_with_a_thread(links):
    res = rt.plan(None, "owner", [task()], {}, args(), NOW, model=model_reply(cls()))
    assert res["rows"][0]["action_kind"] == "draft" and res["rows"][0]["action_note"].startswith("Send back")
    links["mail_thread_id"] = None
    res = rt.plan(None, "owner", [task()], {}, args(), NOW, model=model_reply(cls()))
    row = res["rows"][0]
    assert row["action_kind"] == "none" and row["action_note"] == ""  # nothing to reply on or open
    links["bulk_listing_id"] = "bl1"
    row = rt.plan(None, "owner", [task()], {}, args(), NOW, model=model_reply(cls()))["rows"][0]
    assert row["action_kind"] == "open" and row["link_kind"] == "deal" and row["action_label"] == "Open deal"


def test_stock_list_wording_and_open_when_linked(links):
    t = task(title="Export 20-30 sample stock records and send to Piers", details="Send Piers sample stock records.")
    row = rt.plan(None, "owner", [t], {}, args(), NOW, model=model_reply(cls(action_note="Send Piers the sample export")))["rows"][0]
    assert row["action_kind"] == "draft" and "attach a stock list" in row["action_note"].lower()
    row = rt.plan(None, "owner", [task()], {}, args(), NOW, model=model_reply(cls()))["rows"][0]
    assert "stock list" not in row["action_note"].lower()  # Shaun's own battery list is not our stock
    row = rt.plan(None, "owner", [task()], {}, args(), NOW, model=model_reply(cls(action="none")))["rows"][0]
    assert row["action_kind"] == "open" and row["action_label"] == "Open thread"


def test_marketplace_task_keeps_ids_null(links):
    links["mail_thread_id"] = "mt-notification"
    c = cls(category="market", action="open", action_label="Open chat", link_kind="shop", link_label="Kokam KCL255103EN1")
    row = rt.plan(None, "owner", [task()], {}, args(), NOW, model=model_reply(c))["rows"][0]
    assert row["category"] == "market" and row["link_kind"] == "shop" and row["mail_thread_id"] is None
    assert row["link_label"] == "Kokam KCL255103EN1" and row["action_kind"] == "none"


def test_decide_needs_a_question(links):
    c = cls(category="decide", question="Was the listing date changed?", yes_label="Yes, mark done", no_label="Not yet", action="open")
    row = rt.plan(None, "owner", [task()], {}, args(), NOW, model=model_reply(c))["rows"][0]
    assert (row["category"], row["yes_label"], row["no_label"]) == ("decide", "Yes, mark done", "Not yet")
    c2 = cls(category="decide", question=None)
    row = rt.plan(None, "owner", [task()], {}, args(), NOW, model=model_reply(c2))["rows"][0]
    assert row["category"] == "other" and row["question"] is None
    row = rt.plan(None, "owner", [task()], {}, args(), NOW, model=model_reply(cls(question="stray?")))["rows"][0]
    assert row["question"] is None and row["yes_label"] is None


def test_fallback_on_model_failure(links):
    def broken(prompt):
        raise RuntimeError("boom")

    res = rt.plan(None, "owner", [task()], {}, args(), NOW, model=broken)
    row = res["rows"][0]
    assert res["fallbacks"] == 1 and len(res["errors"]) == 1
    assert row["category"] == "other" and row["title"] == "Reply to Shaun"
    assert row["next_step"].startswith("Highlight the wanted tag numbers") and row["action_kind"] == "open"
    assert row["source_hash"] is None  # retried next run
    # An earlier classification is left alone when the model fails.
    res = rt.plan(None, "owner", [task()], {"t1": {"source_hash": "old", "classified_at": NOW}}, args(), NOW, model=broken)
    assert res["rows"] == [] and res["fallbacks"] == 1
    # Garbage replies count as failures too.
    res = rt.plan(None, "owner", [task()], {}, args(), NOW, model=lambda p: "sorry, no idea")
    assert res["rows"][0]["category"] == "other" and res["errors"]


def test_no_llm_stores_fallback_with_hash(links):
    res = rt.plan(None, "owner", [task()], {}, args(no_llm=True), NOW, model=None)
    assert res["rows"][0]["source_hash"] == rt.source_hash(task()) and res["llm_calls"] == 0


def test_batches_of_eight_and_limit(links):
    tasks = [task(id=f"t{i}", key=f"REB-{i}") for i in range(10)]
    calls = []

    def model(prompt):
        calls.append(prompt)
        keys = re.findall(r'"key": "(REB-\d+)"', prompt)
        return json.dumps([cls(k) for k in keys])

    res = rt.plan(None, "owner", tasks, {}, args(), NOW, model=model)
    assert len(calls) == 2 and len(res["rows"]) == 10 and res["fallbacks"] == 0
    res = rt.plan(None, "owner", tasks, {}, args(limit=3), NOW, model=model)
    assert len(res["rows"]) == 3 and res["deferred"] == 7


def test_clean_removes_dashes():
    assert rt.clean("Call Tom — today – maybe", 100) == "Call Tom, today, maybe"
    assert len(rt.clean("word " * 100, 40)) <= 43


# ---------- DB: link resolution and the write path against a scratch schema ----------

TEST_DB = os.environ.get("RELAY_TEST_DB", "stock_test_9e426f3f65c340ea8fbd892fd0fabf84")
SCHEMA = "relay_tasks_t"
MIGRATION = Path(__file__).resolve().parents[2] / "apps/web/lib/crm-postgres/migrations/092_relay_task_meta.sql"
TABLES = ["crm_users", "work_tasks", "relay_item", "relay_todo", "mail_thread", "mail_message", "crm_bulk_listings",
          "crm_people", "crm_companies"]
OWNER = "7b98322f-e439-4000-97ce-cce1c36a0d2a"
OTHER = "607b1447-4036-4779-9d62-c12f80424864"
DSN = f"host=/var/run/postgresql dbname={TEST_DB}"


def psql(db, sql):
    return subprocess.run(["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", db], input=sql, text=True, capture_output=True)


FIXTURES = f"""
insert into crm_users (id, email, password_hash) values ('{OWNER}', 'alex@rebattery.io', 'x'), ('{OTHER}', 'ari@rebattery.io', 'x');
insert into mail_thread (id, gmail_thread_id, mailbox_owner_id, subject, message_count) values
  ('mt_shaun', '19fd205b19b67eac', '{OWNER}', 'Re: Battery list', 20),
  ('mt_shaun_other_box', '19fd205b19b67eac', null, 'Re: Battery list', 4),
  ('mt_piers', 'g_piers', '{OWNER}', 'Great to catch up', 3),
  ('mt_alpha', 'g_alpha', '{OWNER}', 'Re: Alpha ESS Recycling', 5),
  ('mt_kokam1', 'g_k1', '{OWNER}', 'New message about Kokam cells', 1),
  ('mt_kokam2', 'g_k2', '{OWNER}', 'New message about Kokam cells', 1),
  ('mt_ari', 'g_ari', '{OTHER}', 'Quarterly numbers review', 1);
insert into relay_item (id, owner_id, gmail_thread_id, mail_thread_id, tab, status, counterpart_email) values
  ('ri_piers', '{OWNER}', 'g_piers', 'mt_piers', 'action', 'open', 'piers@piers.co'),
  ('ri_piers_old', '{OWNER}', 'g_piers_old', null, 'action', 'done', 'piers@piers.co'),
  ('ri_r3a', '{OWNER}', 'g_r3a', null, 'action', 'open', 'fec@r3robotics.ai'),
  ('ri_r3b', '{OWNER}', 'g_r3b', null, 'follow', 'open', 'fec@r3robotics.ai');
insert into crm_bulk_listings (id, kind, party, summary, status, email, closed_reason) values
  ('bl_eel', 'supply', 'EEL Greentech', 'Eight pallets of faulty Dyness batteries in Belfast', 'open', 'daniel.luke@eelgreentech.co.uk', null),
  ('bl_r3_open', 'demand', 'R3 Robotics', 'Ioniq 5 packs', 'open', 'fec@r3robotics.ai', null),
  ('bl_r3_closed', 'demand', 'R3 Robotics', 'Zoe packs', 'closed', 'fec@r3robotics.ai', 'other'),
  ('bl_byd1', 'supply', 'GreenLoop', '2 unused BYD CS40HN containers', 'open', null, null),
  ('bl_byd2', 'demand', 'Usman', 'BYD CS40HN containers wanted', 'open', null, null);
"""


@pytest.fixture
def scratch():
    if psql(TEST_DB, "select 1").returncode or psql("denchclaw", "select 1").returncode:
        pytest.skip("local Postgres not reachable")
    psql(TEST_DB, f"drop schema if exists {SCHEMA} cascade")
    dump = subprocess.run(["pg_dump", "-s", "-O", "-x", *sum([["-t", f"public.{t}"] for t in TABLES], []), "denchclaw"],
                          text=True, capture_output=True, check=True).stdout
    keep = [line for line in dump.splitlines()
            if not line.startswith(("SELECT pg_catalog.set_config('search_path'", "CREATE TRIGGER", "\\restrict", "\\unrestrict"))]
    ddl = "\n".join(keep).replace("public.", f"{SCHEMA}.")
    ddl = re.sub(r"ALTER TABLE ONLY [^;]*?FOREIGN KEY[^;]*?REFERENCES " + SCHEMA + r"\.(?!(" + "|".join(TABLES) + r")\b)[^;]*;", "", ddl, flags=re.S)
    res = psql(TEST_DB, f"create schema {SCHEMA};\nset search_path = {SCHEMA}, public;\n{ddl}\n")
    assert res.returncode == 0, res.stderr[-2000:]
    migration = MIGRATION.read_text().replace("grant select", "-- grant select")
    res = psql(TEST_DB, f"set search_path = {SCHEMA}, public;\n{migration}\n{FIXTURES}")
    assert res.returncode == 0, res.stderr[-2000:]
    yield
    psql(TEST_DB, f"drop schema if exists {SCHEMA} cascade")


@pytest.fixture
def cur(scratch):
    conn = psycopg2.connect(DSN)
    c = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    c.execute("select set_config('search_path', %s, false)", (f"{SCHEMA}, public",))
    yield c
    conn.rollback()
    conn.close()


def resolve(cur, details, **hints):
    return rt.resolve_links(cur, OWNER, {}, rt.parse_details(details), hints)


def test_links_gmail_id_picks_the_owners_thread(cur):
    out = resolve(cur, DETAILS_SHAUN, link_kind="mail")
    assert out["mail_thread_id"] == "mt_shaun" and out["relay_item_id"] is None


def test_links_relay_item_by_counterpart_email(cur):
    out = resolve(cur, 'Source: email from Piers <piers@piers.co>, subject "Something else"', link_kind="mail")
    assert out["relay_item_id"] == "ri_piers" and out["mail_thread_id"] == "mt_piers"  # open beats done
    out = resolve(cur, "Reply to Piers.", counterpart_email="Piers@Piers.co", link_kind="mail")
    assert out["relay_item_id"] == "ri_piers"


def test_links_thread_by_subject(cur):
    out = resolve(cur, 'Source: email from support@rebattery.io, subject "RE: Alpha ESS Recycling"', link_kind="mail")
    assert out["mail_thread_id"] == "mt_alpha" and out["relay_item_id"] is None
    # Another mailbox's thread never matches.
    assert resolve(cur, 'Source: x, subject "Quarterly numbers review"', link_kind="mail")["mail_thread_id"] is None


def test_links_ambiguous_resolve_to_none(cur):
    # Two open relay items for the same person, no subject to tell them apart.
    out = resolve(cur, "Reply to Faysal.", counterpart_email="fec@r3robotics.ai", link_kind="mail")
    assert out["relay_item_id"] is None and out["mail_thread_id"] is None
    # Two threads with the same subject.
    out = resolve(cur, 'Source: email from support@rebattery.io, subject "New message about Kokam cells"', link_kind="mail")
    assert out["mail_thread_id"] is None
    # Two open BYD listings: words alone do not decide.
    out = resolve(cur, "Look at the BYD offer.", listing_words=["BYD", "CS40HN"], link_kind="deal")
    assert out["bulk_listing_id"] is None


def test_links_deal_single_confident_match(cur):
    out = resolve(cur, 'Source: email from Daniel Luke <daniel.luke@eelgreentech.co.uk>, subject "Nothing like it"')
    assert out["bulk_listing_id"] == "bl_eel"
    out = resolve(cur, "Reply to Faysal.", counterpart_email="fec@r3robotics.ai")
    assert out["bulk_listing_id"] == "bl_r3_open"  # the one open listing among several
    out = resolve(cur, "x", counterpart_name="Unknown Party Ltd")
    assert out["bulk_listing_id"] is None


def test_links_marketplace_leaves_ids_null(cur):
    out = resolve(cur, DETAILS_SHAUN + "\nhttps://www.rebattery.io/marketplace/abc", link_kind="shop")
    assert out == {"relay_item_id": None, "mail_thread_id": None, "bulk_listing_id": None,
                   "link_url": "https://www.rebattery.io/marketplace/abc"}


def test_db_apply_twice_is_idempotent_and_keeps_snooze(scratch, monkeypatch, capsys):
    psql(TEST_DB, f"""set search_path = {SCHEMA}, public;
      insert into work_tasks (id, reb_key, title, status, task_details, assignee_email) values
        ('wt1', 'REB-1', 'Highlight the wanted tag numbers', 'Planned', $${DETAILS_SHAUN}$$, 'alex@rebattery.io'),
        ('wt2', 'REB-2', 'Call the bank', 'Planned', 'Due Fri', 'alex@rebattery.io'),
        ('wt3', 'REB-3', 'Done already', 'Done', 'x', 'alex@rebattery.io'),
        ('wt4', 'REB-4', 'Ari task', 'Planned', 'x', 'ari@rebattery.io');
      insert into relay_todo (title, kind, state, work_task_id, owner_id) values ('Call the bank', 'manual', 'accepted', 'wt2', '{OWNER}');
      insert into relay_task_meta (work_task_id, snooze_until) values ('wt1', now() + interval '2 days');""")
    calls = []

    def model(prompt):
        calls.append(prompt)
        return json.dumps([cls("REB-1", urgent_reason="Before Friday", due_at="2026-10-30")])

    monkeypatch.setattr(rt, "run_hermes", model)
    argv = ["--apply", "--dsn", DSN, "--schema", SCHEMA]
    assert rt.main(argv) == 0
    out = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert out["open_tasks"] == 2 and out["classified"] == 2 and out["manual"] == 1 and out["llm_calls"] == 1
    assert out["categories"] == {"trade": 1, "mine": 1} and out["urgent"][0]["key"] == "REB-1"

    def rows():
        return subprocess.run(["psql", "-X", "-At", "-d", TEST_DB, "-c",
                               f"select work_task_id, category, action_kind, mail_thread_id, urgent_reason, snooze_until is not null, "
                               f"source_hash is not null, classified_at from {SCHEMA}.relay_task_meta order by 1"],
                              text=True, capture_output=True, check=True).stdout.strip().splitlines()

    first = rows()
    assert [r.split("|")[:7] for r in first] == [
        ["wt1", "trade", "draft", "mt_shaun", "Before Friday", "t", "t"],
        ["wt2", "mine", "none", "", "", "f", "t"]]

    # Second run: nothing changed, nothing classified, nothing written.
    assert rt.main(argv) == 0
    out = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert out["classified"] == 0 and out["unchanged"] == 2 and out["llm_calls"] == 0 and len(calls) == 1
    assert rows() == first

    # A changed task is reclassified and its snooze survives.
    psql(TEST_DB, f"update {SCHEMA}.work_tasks set status = 'In Progress' where id = 'wt1'")
    assert rt.main(argv) == 0
    out = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert out["classified"] == 1 and len(calls) == 2
    assert rows()[0].split("|")[5] == "t"


def test_db_dry_run_writes_nothing(scratch, monkeypatch, capsys):
    psql(TEST_DB, f"""set search_path = {SCHEMA}, public;
      insert into work_tasks (id, reb_key, title, status, task_details, assignee_email) values
        ('wt1', 'REB-1', 'Highlight the wanted tag numbers', 'Planned', $${DETAILS_SHAUN}$$, 'alex@rebattery.io');""")
    monkeypatch.setattr(rt, "run_hermes", lambda p: json.dumps([cls("REB-1")]))
    assert rt.main(["--dsn", DSN, "--schema", SCHEMA]) == 0
    out = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert out["mode"] == "dry-run" and out["classified"] == 1 and out["examples"][0]["action"] == "draft"
    n = subprocess.run(["psql", "-X", "-At", "-d", TEST_DB, "-c", f"select count(*) from {SCHEMA}.relay_task_meta"],
                       text=True, capture_output=True, check=True).stdout.strip()
    assert n == "0"
