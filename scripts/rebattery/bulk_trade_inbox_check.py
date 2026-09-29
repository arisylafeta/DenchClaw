#!/usr/bin/env python3
"""Bulk Trades inbox check: read Alex's new Gmail and Granola notes, match them to trades, and
store proposals for Alex to accept or ignore in the app. It never changes a trade itself.

  bulk_trade_inbox_check.py                  # one run: collect, match, propose, record the run
  bulk_trade_inbox_check.py --dry-run        # print proposals, write nothing
  bulk_trade_inbox_check.py --summary        # the 08:00 list of overdue and due-today steps
  ... --only-at 08:00,10:30                  # act only within 15 minutes after these UK times

Hermes cron runs on UTC, so the jobs fire every half hour and --only-at keeps them on UK time
across daylight-saving changes. Outside those times the script exits silently.

Sources:
  Gmail   crm_email_messages for Alex's mailbox, synced hourly by gog_crm_sync.py.
  Granola raw notes saved by granola-ingestion, refreshed at the start of each run.

Matching is deterministic: a message or meeting belongs to a trade when a participant is one of
its contacts or linked buyers, or the Gmail thread is already tied to it. A thread that touches
several trades becomes one "needs triage" item instead of a guess. Only then does a language model
read the matched material and propose changes, and every proposal must quote its source verbatim
or it is dropped. Unmatched inbound mail that looks like a battery deal becomes a "possible new
trade". Every run is recorded in crm_bulk_trade_check_runs, including failures.
"""

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

import psycopg2
import psycopg2.extras

REPO = Path(__file__).resolve().parents[2]
TEMPLATES = json.loads((REPO / "apps/web/lib/bulk-trade-templates.json").read_text())
GRANOLA_DIR = Path(os.environ.get("GRANOLA_DATA_DIR", "/root/.local/share/rebattery/granola"))
GRANOLA_BIN = os.environ.get("GRANOLA_INGESTION_BIN", "/root/.local/bin/granola-ingestion")
GATEWAY_URL = os.environ.get("HERMES_API_BASE_URL", "http://127.0.0.1:8642") + "/v1/chat/completions"
HERMES_ENV = Path("/root/.hermes/.env")
KEYRING_FILE = Path("/root/.hermes/workspace/.secrets/gog-keyring-password")

LIVE_STAGES = ("Needs info", "With buyers", "Closing")
BUYER_STATUSES = [
    "To contact", "Teaser sent", "No reply", "NDA, specs sent", "Bid in", "LOI or deposit", "Won",
    "Declined: price", "Declined: specs", "Declined: logistics", "Declined: timing",
]
OWN_DOMAIN = "rebattery.io"
DEAL_WORDS = re.compile(
    r"\b(batter(y|ies)|packs?|cells?|kwh|mwh|bess|modules?|lithium|li-ion|lfp|nmc|inventory|batch|recycl\w*)\b", re.I)
MAX_SOURCE_CHARS = 8000
MAX_SCREENED_EMAILS = 25  # possible-new-trade screen, per run
MIN_QUOTE_CHARS = 8
FIRST_RUN_LOOKBACK = dt.timedelta(days=3)


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def norm(text):
    """Comparable text: straight quotes, single spaces, case-folded."""
    text = (text or "").replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    return re.sub(r"\s+", " ", text).strip().casefold()


def quote_ok(quote, source_text):
    return len((quote or "").strip()) >= MIN_QUOTE_CHARS and norm(quote) in norm(source_text)


def emails_in(values):
    return {v.strip().lower() for v in values if v and "@" in v}


def external(emails):
    return {e for e in emails if not e.endswith("@" + OWN_DOMAIN)}


def parse_time(value):
    if not value:
        return None
    if isinstance(value, dt.datetime):
        return value if value.tzinfo else value.replace(tzinfo=dt.timezone.utc)
    return dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def read_env_value(path, name):
    try:
        for line in path.read_text().splitlines():
            if line.startswith(name + "="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return None


# ---------------------------------------------------------------------------
# Trades
# ---------------------------------------------------------------------------

def load_trades(cur):
    cur.execute(
        """select id, title, trade_kind, trade_stage, fact_line, next_step,
                  to_char(next_step_due, 'YYYY-MM-DD') as next_step_due, waiting_on
           from crm_bulk_trade_lots where trade_stage = any(%s)""",
        (list(LIVE_STAGES),),
    )
    trades = {row["id"]: {**row, "emails": set(), "threads": set(), "buyers": [], "fields": {}, "files": set()}
              for row in cur.fetchall()}
    if not trades:
        return trades
    ids = list(trades)

    cur.execute("select lot_id, name, email from crm_bulk_trade_contacts where lot_id = any(%s)", (ids,))
    for row in cur.fetchall():
        trades[row["lot_id"]]["emails"] |= emails_in([row["email"]])
    cur.execute(
        """select b.lot_id, b.id, b.name, b.contact, b.status, p.email,
                  to_char(b.last_touch_on, 'YYYY-MM-DD') as last_touch_on, b.last_touch_via,
                  to_char(b.chase_on, 'YYYY-MM-DD') as chase_on
           from crm_bulk_trade_buyers b left join crm_people p on p.id = b.person_id
           where b.lot_id = any(%s) order by b.created_at""", (ids,))
    for row in cur.fetchall():
        trades[row["lot_id"]]["buyers"].append(
            {k: row[k] for k in ("id", "name", "contact", "status", "last_touch_on", "last_touch_via", "chase_on")})
        trades[row["lot_id"]]["emails"] |= emails_in([row["email"]])
    cur.execute("select lot_id, lower(file_name) as name from crm_bulk_trade_files where lot_id = any(%s)", (ids,))
    for row in cur.fetchall():
        trades[row["lot_id"]]["files"].add(row["name"])
    cur.execute("select lot_id, field_key, value, status from crm_bulk_trade_fields where lot_id = any(%s)", (ids,))
    for row in cur.fetchall():
        trades[row["lot_id"]]["fields"][row["field_key"]] = {"value": row["value"], "status": row["status"]}
    # Threads already tied to a trade: evidence links (Gmail or CRM thread ids) and earlier proposals.
    cur.execute(
        """select link.lot_id, coalesce(thread.gmail_thread_id, link.evidence_id) as thread
           from crm_bulk_trade_evidence_links link
           left join crm_email_threads thread on thread.id = link.evidence_id
           where link.evidence_kind = 'gmail_thread' and link.lot_id = any(%s)
           union
           select lot_id, source_thread from crm_bulk_trade_proposals
           where source_thread is not null and lot_id = any(%s)""", (ids, ids))
    for row in cur.fetchall():
        trades[row["lot_id"]]["threads"].add(row["thread"])
    for trade in trades.values():
        trade["emails"] = external(trade["emails"])
    return trades


# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------

def load_emails(cur, mailbox, since):
    """Messages synced since the cursor. Uses the sync time, so late-synced mail is not missed."""
    cur.execute(
        """select m.id, m.gmail_message_id, thread.gmail_thread_id, m.subject, m.sent_at, m.created_at,
                  m.from_email, coalesce(m.body, m.body_preview, '') as body, coalesce(m.has_attachments, false) as has_attachments,
                  array_remove(array_agg(distinct p.email), null) as recipients
           from crm_email_messages m
           join crm_users owner on owner.id = m.mailbox_owner_id and lower(owner.email) = lower(%s)
           left join crm_email_threads thread on thread.id = m.thread_id
           left join crm_email_message_recipients r on r.message_id = m.id
           left join crm_people p on p.id = r.person_id
           where m.created_at > %s
           group by m.id, thread.gmail_thread_id
           order by m.created_at""", (mailbox, since))
    out = []
    for row in cur.fetchall():
        sender = (row["from_email"] or "").lower()
        out.append({
            "kind": "gmail",
            "id": row["gmail_message_id"] or row["id"],
            "thread": row["gmail_thread_id"],
            "at": parse_time(row["sent_at"] or row["created_at"]),
            "synced_at": parse_time(row["created_at"]),
            "label": f"Gmail · {row['from_email'] or 'unknown'}",
            "url": f"https://mail.google.com/mail/u/?authuser={mailbox}#all/{row['gmail_thread_id']}" if row["gmail_thread_id"] else None,
            "inbound": not sender.endswith("@" + OWN_DOMAIN),
            "from": sender,
            "participants": external(emails_in([sender, *row["recipients"]])),
            "title": row["subject"] or "(no subject)",
            "text": f"Subject: {row['subject'] or ''}\nFrom: {row['from_email'] or ''}\n\n{row['body']}",
            "has_attachments": row["has_attachments"],
        })
    return out


def refresh_granola():
    """Pull today's notes; a failure here only means older notes are used."""
    try:
        subprocess.run([GRANOLA_BIN, "collect", "today", "--json"], capture_output=True, timeout=300, check=True)
        return None
    except (OSError, subprocess.SubprocessError) as err:
        return f"granola refresh failed: {type(err).__name__}"


def load_granola(since):
    notes = []
    for path in sorted((GRANOLA_DIR / "raw").glob("*.json")):
        try:
            note = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        updated = parse_time(note.get("updated_at") or note.get("created_at"))
        if not updated or updated <= since:
            continue
        people = [a.get("email") for a in note.get("attendees") or []]
        people += [i.get("email") for i in (note.get("calendar_event") or {}).get("invitees") or []]
        transcript = "\n".join(
            f"{(seg.get('speaker') or {}).get('source', 'speaker')}: {seg.get('text', '')}" for seg in note.get("transcript") or [])
        notes.append({
            "kind": "granola",
            "id": note["id"],
            "thread": None,
            "at": parse_time(note.get("created_at")),
            "synced_at": updated,
            "label": f"Call · {note.get('title') or 'Granola note'}",
            "url": note.get("web_url"),
            "inbound": True,
            "from": None,
            "participants": external(emails_in(people)),
            "title": note.get("title") or "Call",
            "text": f"Meeting: {note.get('title') or ''}\n\nSummary:\n{note.get('summary_markdown') or note.get('summary_text') or ''}\n\nTranscript:\n{transcript}",
            "has_attachments": False,
        })
    return notes


def match(source, trades):
    lots = {lot for lot, t in trades.items() if source["participants"] & t["emails"]}
    if source["thread"]:
        lots |= {lot for lot, t in trades.items() if source["thread"] in t["threads"]}
    return lots


# ---------------------------------------------------------------------------
# Proposals
# ---------------------------------------------------------------------------

def call_model(system, user, key):
    body = json.dumps({
        "model": "hermes-agent",
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "temperature": 0,
    }).encode()
    request = urllib.request.Request(GATEWAY_URL, data=body, headers={
        "Authorization": f"Bearer {key}", "content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=300) as response:
        content = json.loads(response.read())["choices"][0]["message"]["content"]
    match_json = re.search(r"\{.*\}", content, re.S)
    if not match_json:
        raise ValueError("model reply had no JSON object")
    return json.loads(match_json.group(0))


TRADE_SYSTEM = """You extract proposed updates for one bulk battery trade from new emails and meeting notes.
Reply with ONLY a JSON object: {"proposals": [ ... ]}. No prose, no tools.
Each proposal: {"kind", "target", "proposed", "summary", "quote", "source_id"}.
- kind "field": target = one field key from FIELDS; proposed = {"value": "...", "status": "confirmed" | "unverified"}.
  Only when the source states a value that is new or different from the current one.
- kind "buyer_update": target = a buyer id from BUYERS; proposed may hold "status" (one of STATUSES),
  "last_touch_on" (YYYY-MM-DD), "last_touch_via" ("Email" | "Call" | "Meeting"), "chase_on" (YYYY-MM-DD).
- kind "next_step": proposed = {"next_step": "...", "next_step_due": "YYYY-MM-DD" or null, "waiting_on": "us" | "them"}.
  Only when the source makes a concrete next action clear.
- kind "new_buyer": proposed = {"name": "...", "contact": "...", "wants": "..."} for a buyer not in BUYERS.
- kind "file": target = one attachment name from the source's "Attachments:" line, proposed = {}. Only files about
  THIS trade (spec sheets, test reports, photos, stock lists, contracts, LCs, proposals for this batch). Skip logos,
  signatures and files about other batches. Use the file name itself as the quote.
- "summary": one short plain sentence for Alex.
- "quote": copied EXACTLY, word for word, from the source text (8-300 characters). A proposal without an exact quote is discarded.
- "source_id": the id of the source the quote comes from.
Propose nothing that is already recorded (compare with TRADE, FIELDS and BUYERS), speculative, or only implied.
An empty list is a good answer."""


def trade_prompt(trade, sources):
    kind = trade["trade_kind"] or "packs"
    fields = [{"key": f["key"], "label": f["label"], "current": trade["fields"].get(f["key"])}
              for f in TEMPLATES["fields"][kind]]
    context = {
        "TRADE": {k: trade[k] for k in ("title", "trade_stage", "fact_line", "next_step", "next_step_due", "waiting_on")},
        "FIELDS": fields,
        "BUYERS": trade["buyers"],
        "STATUSES": BUYER_STATUSES,
        "SOURCES": [{"source_id": s["id"], "type": s["kind"], "date": s["at"].date().isoformat() if s["at"] else None,
                     "title": s["title"], "text": s["text"][:MAX_SOURCE_CHARS]} for s in sources],
    }
    return json.dumps(context, ensure_ascii=False, default=str)


POSSIBLE_SYSTEM = """You screen inbound emails for possible new bulk battery trades for ReBattery, which brokers
second-life and surplus EV batteries, cells, BESS and recycling lots. Reply with ONLY JSON:
{"trades": [{"source_id", "title", "trade_kind": "packs" | "cells" | "systems" | "recycling", "summary", "quote",
             "existing_trade_id": null or the id from EXISTING when the email is about that trade}]}.
Include an email only if someone offers or seeks a specific batch (quantity, model or location). Skip newsletters,
events, invoices, marketing and anything already vague. "quote" must be copied exactly from the email (8-300 characters).
The input is {"EXISTING": [{"id", "title"}], "EMAILS": [...]}. Set existing_trade_id only for a clear match."""


HASH_IMAGE = re.compile(r"^(image\d+|[A-Za-z0-9_-]{12,})\.(png|gif|jpe?g)$", re.I)


def validate(raw, trade, sources_by_id):
    """Keep only proposals that are well-formed, point at real targets, quote their source and
    change something that is not already recorded."""
    kind_fields = {f["key"] for f in TEMPLATES["fields"][trade["trade_kind"] or "packs"]}
    buyers = {b["id"]: b for b in trade["buyers"]}
    files_seen = set(trade["files"])
    kept = []
    for p in raw.get("proposals") or []:
        if not isinstance(p, dict):
            continue
        source = sources_by_id.get(str(p.get("source_id")))
        proposed = p.get("proposed") if isinstance(p.get("proposed"), dict) else None
        if not source or proposed is None or not quote_ok(p.get("quote"), source["text"]):
            continue
        kind, target = p.get("kind"), p.get("target")
        if kind == "field":
            if target not in kind_fields or not str(proposed.get("value") or "").strip():
                continue
            current = (trade["fields"].get(target) or {}).get("value")
            if current and norm(current) == norm(str(proposed["value"])):
                continue
            proposed = {"value": str(proposed["value"]).strip(),
                        "status": proposed.get("status") if proposed.get("status") in ("confirmed", "unverified") else "unverified"}
        elif kind == "buyer_update":
            if target not in buyers:
                continue
            clean = {}
            if proposed.get("status") in BUYER_STATUSES:
                clean["status"] = proposed["status"]
            for key in ("last_touch_on", "chase_on"):
                if re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(proposed.get(key) or "")):
                    clean[key] = proposed[key]
            if proposed.get("last_touch_via") in ("Email", "Call", "Meeting"):
                clean["last_touch_via"] = proposed["last_touch_via"]
            clean = {k: v for k, v in clean.items() if buyers[target].get(k) != v}
            if not clean:
                continue
            proposed = clean
        elif kind == "next_step":
            step = str(proposed.get("next_step") or "").strip()
            if not step or norm(step) == norm(trade.get("next_step")):
                continue
            due = proposed.get("next_step_due")
            proposed = {"next_step": step[:300],
                        "next_step_due": due if re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(due or "")) else None,
                        "waiting_on": proposed.get("waiting_on") if proposed.get("waiting_on") in ("us", "them") else "us"}
            target = None
        elif kind == "new_buyer":
            name = str(proposed.get("name") or "").strip()
            if not name or name.lower() in {b["name"].lower() for b in trade["buyers"]}:
                continue
            proposed = {k: str(proposed.get(k) or "").strip() or None for k in ("name", "contact", "wants")}
            target = None
        elif kind == "file":
            attachment = next((a for a in source.get("attachments", []) if a["name"] == target), None)
            if not attachment or HASH_IMAGE.match(target) or target.lower() in files_seen:
                continue
            files_seen.add(target.lower())
            proposed = {"file_name": target, "gmail_message_id": source["id"],
                        "attachment_id": attachment["id"], "file_type": guess_type(target)}
            p = {**p, "summary": p.get("summary") or f"Attachment: {target}"}
            target = None
        else:
            continue
        kept.append({"kind": kind, "target": target, "proposed": proposed,
                     "summary": str(p.get("summary") or "").strip()[:300] or "Proposed update",
                     "quote": str(p["quote"]).strip()[:300], "source": source})
    return kept


def add_attachments(source):
    """Lists a Gmail message's attachments in the source text, so the model can pick the ones that
    belong to the trade and quote their names. Read-only."""
    source.setdefault("attachments", [])
    if source["kind"] != "gmail" or not source["has_attachments"]:
        return
    env = dict(os.environ)
    if KEYRING_FILE.exists() and "GOG_KEYRING_PASSWORD" not in env:
        env["GOG_KEYRING_PASSWORD"] = KEYRING_FILE.read_text().strip()
    try:
        result = subprocess.run(
            ["gog", "--account", "alex@rebattery.io", "--readonly", "--no-input", "--json", "gmail", "get", source["id"]],
            capture_output=True, text=True, timeout=120, env=env, check=True)
        payload = (json.loads(result.stdout).get("message") or {}).get("payload") or {}
    except (OSError, subprocess.SubprocessError, ValueError):
        return

    def walk(part):
        if part.get("filename"):
            source["attachments"].append({"name": part["filename"], "id": (part.get("body") or {}).get("attachmentId")})
        for child in part.get("parts") or []:
            walk(child)
    walk(payload)
    if source["attachments"]:
        source["text"] += "\n\nAttachments: " + ", ".join(a["name"] for a in source["attachments"])


def guess_type(name):
    lower = name.lower()
    if re.search(r"\.(jpe?g|png|heic|webp)$", lower):
        return "Photos"
    if "msds" in lower or "un38" in lower or "dgd" in lower or "transport" in lower:
        return "Transport documents"
    if "datasheet" in lower or "spec" in lower:
        return "Datasheet"
    if "test" in lower or "soh" in lower or "report" in lower:
        return "Test report"
    if re.search(r"\.(xlsx?|csv)$", lower):
        return "Stock list"
    if "contract" in lower or "invoice" in lower or "loi" in lower:
        return "Contract"
    return "Other"


def insert_proposal(cur, run_id, lot_id, p):
    s = p["source"]
    cur.execute(
        """insert into crm_bulk_trade_proposals
             (lot_id, run_id, kind, target, proposed, summary, quote, source_kind, source_id, source_thread,
              source_url, source_label, source_at)
           values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
           on conflict do nothing returning id""",
        (lot_id, run_id, p["kind"], p["target"], json.dumps(p["proposed"], sort_keys=True), p["summary"], p["quote"],
         s["kind"], s["id"], s["thread"], s["url"], s["label"], s["at"]))
    return cur.fetchone() is not None


# ---------------------------------------------------------------------------
# Runs
# ---------------------------------------------------------------------------

def last_cursor(cur):
    cur.execute("select cursor from crm_bulk_trade_check_runs where status = 'ok' order by started_at desc limit 1")
    row = cur.fetchone()
    return row["cursor"] if row else {}


def run(conn, args):
    now = dt.datetime.now(dt.timezone.utc)
    key = os.environ.get("HERMES_API_KEY") or read_env_value(HERMES_ENV, "API_SERVER_KEY")
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("select pg_try_advisory_lock(hashtext('bulk_trade_inbox_check')) as locked")
        if not cur.fetchone()["locked"]:
            print("Another inbox check is running; skipped.")
            return 0
        cursor = last_cursor(cur)
        default_since = now - FIRST_RUN_LOOKBACK
        gmail_since = parse_time(args.since or cursor.get("gmail_since")) or default_since
        granola_since = parse_time(args.since or cursor.get("granola_since")) or default_since
        run_id = None
        if not args.dry_run:
            cur.execute("insert into crm_bulk_trade_check_runs default values returning id")
            run_id = cur.fetchone()["id"]
            conn.commit()

    report = {"run_id": run_id, "emails_read": 0, "notes_read": 0, "proposals": [], "warnings": []}
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            warning = refresh_granola()
            if warning:
                report["warnings"].append(warning)
            trades = load_trades(cur)
            emails = load_emails(cur, args.mailbox, gmail_since)
            notes = load_granola(granola_since)
            report["emails_read"], report["notes_read"] = len(emails), len(notes)

            by_trade, triage, unmatched = {}, [], []
            for source in emails + notes:
                lots = match(source, trades)
                if len(lots) == 1:
                    by_trade.setdefault(lots.pop(), []).append(source)
                elif len(lots) > 1:
                    triage.append((source, sorted(lots)))
                elif source["kind"] == "gmail" and source["inbound"] and DEAL_WORDS.search(source["text"][:3000]):
                    unmatched.append(source)

            proposals = []  # (lot_id, proposal)
            for lot_id, sources in by_trade.items():
                trade = trades[lot_id]
                for source in sources:
                    add_attachments(source)
                if key:
                    try:
                        raw = call_model(TRADE_SYSTEM, trade_prompt(trade, sources), key)
                        proposals += [(lot_id, p) for p in validate(raw, trade, {s["id"]: s for s in sources})]
                    except Exception as err:  # one trade's failure must not stop the others
                        report["warnings"].append(f"{trade['title']}: model failed ({type(err).__name__})")
                else:
                    report["warnings"].append("no gateway key; proposals from content skipped")

            for source, lots in triage:
                proposals.append((lots[0], {
                    "kind": "needs_triage", "target": None, "proposed": {"lot_ids": lots},
                    "summary": f"“{source['title']}” involves {len(lots)} trades. Check which it belongs to.",
                    "quote": source["title"], "source": source}))

            if unmatched and key:
                try:
                    cur.execute("select id, title from crm_bulk_trade_lots where trade_stage <> 'Lost' order by title")
                    existing = {row["id"]: row["title"] for row in cur.fetchall()}
                    raw = call_model(POSSIBLE_SYSTEM, json.dumps({
                        "EXISTING": [{"id": k, "title": v} for k, v in existing.items()],
                        "EMAILS": [{"source_id": s["id"], "text": s["text"][:3000]} for s in unmatched[-MAX_SCREENED_EMAILS:]],
                    }, ensure_ascii=False), key)
                    by_id = {s["id"]: s for s in unmatched}
                    for t in raw.get("trades") or []:
                        source = by_id.get(str(t.get("source_id")))
                        if not source or not quote_ok(t.get("quote"), source["text"]) or not str(t.get("title") or "").strip():
                            continue
                        existing_id = t.get("existing_trade_id")
                        if existing_id in existing and source.get("from"):
                            proposals.append((existing_id, {
                                "kind": "link_contact", "target": None,
                                "proposed": {"name": source["from"], "email": source["from"]},
                                "summary": f"Looks like {existing[existing_id]}. Add {source['from']} as a contact so their emails match.",
                                "quote": str(t["quote"]).strip()[:300], "source": source}))
                            continue
                        kind = t.get("trade_kind") if t.get("trade_kind") in TEMPLATES["fields"] else None
                        proposals.append((None, {
                            "kind": "possible_trade", "target": None,
                            "proposed": {"title": str(t["title"]).strip()[:120], "trade_kind": kind},
                            "summary": str(t.get("summary") or "").strip()[:300] or "Possible new trade",
                            "quote": str(t["quote"]).strip()[:300], "source": source}))
                except Exception as err:
                    report["warnings"].append(f"possible-trade screen failed ({type(err).__name__})")

            made = 0
            for lot_id, p in proposals:
                report["proposals"].append({"lot_id": lot_id, "kind": p["kind"], "target": p["target"],
                                            "proposed": p["proposed"], "summary": p["summary"], "quote": p["quote"],
                                            "source": p["source"]["label"]})
                if not args.dry_run:
                    made += insert_proposal(cur, run_id, lot_id, p)

            if not args.dry_run:
                latest = lambda items, fallback: max([s["synced_at"] for s in items if s["synced_at"]] + [fallback])
                cur.execute(
                    """update crm_bulk_trade_check_runs set status = 'ok', finished_at = now(), emails_read = %s,
                         notes_read = %s, proposals_made = %s, cursor = %s,
                         error = %s where id = %s""",
                    (len(emails), len(notes), made,
                     json.dumps({"gmail_since": latest(emails, gmail_since).isoformat(),
                                 "granola_since": latest(notes, granola_since).isoformat()}),
                     "; ".join(report["warnings"]) or None, run_id))
                report["proposals_made"] = made
            conn.commit()
    except Exception as err:
        conn.rollback()
        if run_id:
            with conn.cursor() as cur:
                cur.execute("update crm_bulk_trade_check_runs set status = 'failed', finished_at = now(), error = %s where id = %s",
                            (f"{type(err).__name__}: {str(err)[:300]}", run_id))
            conn.commit()
        raise
    json.dump(report, sys.stdout, indent=2, ensure_ascii=False, default=str)
    print()
    return 0


def summary(conn):
    """The 08:00 list: overdue and due-today next steps, plus new proposals waiting."""
    today = dt.datetime.now(ZoneInfo("Europe/London")).date()
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """select l.title, l.next_step, l.next_step_due,
                      (select count(*) from crm_bulk_trade_proposals p where p.lot_id = l.id and p.status = 'new') as new
               from crm_bulk_trade_lots l
               where l.trade_stage = any(%s) and l.next_step_due <= %s
               order by l.next_step_due, l.title""", (list(LIVE_STAGES), today))
        rows = cur.fetchall()
        cur.execute("select count(*) as n from crm_bulk_trade_proposals where lot_id is null and status = 'new'")
        possible = cur.fetchone()["n"]
    lines = [f"Bulk Trades, {today:%a %d %b}"]
    for row in rows:
        days = (today - row["next_step_due"]).days
        when = "today" if days == 0 else f"{days}d late"
        extra = f" ({row['new']} new)" if row["new"] else ""
        lines.append(f"- {row['title']}: {row['next_step'] or 'set a next step'} [{when}]{extra}")
    if not rows:
        lines.append("Nothing overdue or due today.")
    if possible:
        lines.append(f"{possible} possible new trade{'s' if possible != 1 else ''} to review.")
    lines.append("https://crm.rebattery.io/?path=bulk_trade")
    print("\n".join(lines))
    return 0


def due_now(times, now=None):
    """True within 15 minutes after any of the given UK times (HH:MM)."""
    now = now or dt.datetime.now(ZoneInfo("Europe/London"))
    for value in times:
        hour, minute = map(int, value.split(":"))
        start = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if dt.timedelta(0) <= now - start < dt.timedelta(minutes=15):
            return True
    return False


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dsn", default="host=/var/run/postgresql dbname=denchclaw")
    parser.add_argument("--mailbox", default="alex@rebattery.io")
    parser.add_argument("--since", help="override the cursor (ISO time), e.g. for a backfill")
    parser.add_argument("--dry-run", action="store_true", help="print proposals and write nothing")
    parser.add_argument("--summary", action="store_true", help="print the overdue and due-today list")
    parser.add_argument("--only-at", help="comma-separated UK times; do nothing outside them")
    args = parser.parse_args()
    if args.only_at and not due_now([t.strip() for t in args.only_at.split(",") if t.strip()]):
        return 0
    conn = psycopg2.connect(args.dsn)
    try:
        return summary(conn) if args.summary else run(conn, args)
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
