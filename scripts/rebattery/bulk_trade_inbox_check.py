#!/usr/bin/env python3
"""Bulk Trades inbox check: read Alex's new Gmail and Granola notes, place each thread on the trade
it is about, and update those trades with what it finds.

  bulk_trade_inbox_check.py                  # one run: collect, place, extract, apply, record the run
  bulk_trade_inbox_check.py --dry-run        # print what it would do, write nothing
  bulk_trade_inbox_check.py --summary        # the 08:00 list of overdue and due-today steps
  bulk_trade_inbox_check.py --history LOT_ID # one-off pass over a trade's whole email and call history
  bulk_trade_inbox_check.py --match          # match open demand to live trades that changed
  ... --only-at 08:00,10:30                  # act only within 15 minutes after these UK times

Hermes cron runs on UTC, so the jobs fire every half hour and --only-at keeps them on UK time
across daylight-saving changes. Outside those times the script exits silently.

Sources:
  Gmail   crm_email_messages for Alex's mailbox, synced hourly by gog_crm_sync.py.
  Granola raw notes saved by granola-ingestion, refreshed at the start of each run.

1. Candidates. A thread or call is a candidate for a trade when a participant is one of its
   contacts or linked buyers, or the thread is linked to it.
2. Placing. The same people often work on several deals, so people alone do not decide. A language
   model reads each new thread's subject, dates, people and opening lines against every live trade
   and places it on one trade, on none (another or finished deal), or marks it unclear. The verdict
   is kept per thread in crm_bulk_trade_threads, so later replies follow it without another call.
3. Extracting. Only threads placed on a trade are read in full, oldest first, and every finding must
   quote its source verbatim or it is dropped.
4. Applying. Findings are written straight to the trade and kept as "applied" proposals with what
   they replaced, so each can be undone in the app. A value Alex entered or accepted is never
   overwritten: a different value from email becomes a conflict for him to settle. Buyer status
   changes, unclear threads and possible new trades stay as cards for Alex.
5. Demand. New mail and calls in which someone asks to buy batteries in bulk become "possible
   demand" cards; after each run, live trades whose facts or the open demand changed are matched
   against open demand (one model call per changed trade) for their Suggested buyers.
Every run is recorded in crm_bulk_trade_check_runs, including failures.
"""

import argparse
import datetime as dt
import hashlib
import json
import mimetypes
import os
import re
import subprocess
import sys
import tempfile
import urllib.request
import uuid
from pathlib import Path
from zoneinfo import ZoneInfo

import psycopg2
import psycopg2.extras

REPO = Path(__file__).resolve().parents[2]
TEMPLATES = json.loads((REPO / "apps/web/lib/bulk-trade-templates.json").read_text())
BUY_BOX = json.loads((REPO / "apps/web/lib/buy-box-spec.json").read_text())
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
MAX_FILE_BYTES = 25 * 1024 * 1024
HISTORY_LOG_DIR = Path("/root/.hermes/workspace/logs/bulk-trades")


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

def load_trades(cur, lot_ids=None):
    """Live trades, or the given trades at any stage."""
    cur.execute(
        """select id, title, trade_kind, trade_stage, fact_line, next_step,
                  to_char(next_step_due, 'YYYY-MM-DD') as next_step_due, waiting_on,
                  to_char(created_at, 'YYYY-MM-DD') as created_on
           from crm_bulk_trade_lots
           where (%s::text[] is null and trade_stage = any(%s)) or id = any(%s::text[])""",
        (lot_ids, list(LIVE_STAGES), lot_ids or []),
    )
    trades = {row["id"]: {**row, "emails": set(), "contact_emails": set(), "threads": set(), "buyers": [], "fields": {},
                          "files": set()}
              for row in cur.fetchall()}
    if not trades:
        return trades
    ids = list(trades)

    cur.execute("select lot_id, name, email from crm_bulk_trade_contacts where lot_id = any(%s)", (ids,))
    for row in cur.fetchall():
        trades[row["lot_id"]]["emails"] |= emails_in([row["email"]])
        trades[row["lot_id"]]["contact_emails"] |= emails_in([row["email"]])
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
    # Threads linked to a trade by hand (Gmail or CRM thread ids). These are always read for it.
    cur.execute(
        """select link.lot_id, coalesce(thread.gmail_thread_id, link.evidence_id) as thread
           from crm_bulk_trade_evidence_links link
           left join crm_email_threads thread on thread.id = link.evidence_id
           where link.evidence_kind = 'gmail_thread' and link.lot_id = any(%s)""", (ids,))
    for row in cur.fetchall():
        trades[row["lot_id"]]["threads"].add(f"gmail:{row['thread']}")
    for trade in trades.values():
        trade["emails"] = external(trade["emails"])
    return trades


# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------

EMAIL_SELECT = """
    select m.id, m.gmail_message_id, thread.gmail_thread_id, m.subject, m.sent_at, m.created_at,
           m.from_email, coalesce(m.body, m.body_preview, '') as body, coalesce(m.has_attachments, false) as has_attachments,
           array_remove(array_agg(distinct p.email), null) as recipients
    from crm_email_messages m
    join crm_users owner on owner.id = m.mailbox_owner_id and lower(owner.email) = lower(%(mailbox)s)
    left join crm_email_threads thread on thread.id = m.thread_id
    left join crm_email_message_recipients r on r.message_id = m.id
    left join crm_people p on p.id = r.person_id
    where {where}
    group by m.id, thread.gmail_thread_id
    order by coalesce(m.sent_at, m.created_at)"""


def load_emails(cur, mailbox, since):
    """Messages synced since the cursor. Uses the sync time, so late-synced mail is not missed."""
    cur.execute(EMAIL_SELECT.format(where="m.created_at > %(since)s"), {"mailbox": mailbox, "since": since})
    return email_sources(cur.fetchall(), mailbox)


def load_trade_emails(cur, mailbox, emails, threads):
    """Every synced message from or to the trade's people, or on its threads, oldest first."""
    cur.execute(EMAIL_SELECT.format(where="""
        lower(m.from_email) = any(%(emails)s)
        or thread.gmail_thread_id = any(%(threads)s)
        or exists (select 1 from crm_email_message_recipients r2 join crm_people p2 on p2.id = r2.person_id
                   where r2.message_id = m.id and lower(p2.email) = any(%(emails)s))"""),
        {"mailbox": mailbox, "emails": sorted(emails), "threads": sorted(t for t in threads if t)})
    return email_sources(cur.fetchall(), mailbox)


def email_sources(rows, mailbox):
    out = []
    for row in rows:
        sender = (row["from_email"] or "").lower()
        out.append({
            "kind": "gmail",
            "id": row["gmail_message_id"] or row["id"],
            "key": f"gmail:{row['gmail_thread_id']}" if row["gmail_thread_id"] else f"gmail-message:{row['gmail_message_id'] or row['id']}",
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
            "key": f"granola:{note['id']}",
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
    """Candidate trades for a source: shared people or a hand-linked thread."""
    return {lot for lot, t in trades.items() if source["participants"] & t["emails"] or source["key"] in t["threads"]}


def by_thread(sources):
    """Sources grouped by thread key, each group oldest first, groups in order of first message."""
    groups = {}
    for source in sorted(sources, key=lambda s: s["at"] or EPOCH):
        groups.setdefault(source["key"], []).append(source)
    return groups


# ---------------------------------------------------------------------------
# Placing threads on trades
# ---------------------------------------------------------------------------

THREAD_SYSTEM = """You sort email threads and call notes into ReBattery's bulk battery trades.
Reply with ONLY a JSON object: {"threads": [{"key", "verdict", "trade_id", "reason"}]}, one entry per thread.
For each thread decide which ONE trade in TRADES it is about. Judge by the batch being discussed (model,
chemistry, capacity, quantity, location, buyers), the dates against when each trade started, the subject and
what is said. The same people often work on several deals, so shared people alone are never enough:
- verdict "trade" with trade_id: the thread is about that trade's batch.
- verdict "none": about a different batch, an older or finished deal, or not about a deal at all.
- verdict "unclear": it really discusses two or more trades in TRADES, or you cannot tell.
"reason": a few words, for example "Serbian packs for Ecovip, March, not this batch"."""

THREAD_BATCH_CHARS = 30000


def trade_card(trade):
    """What the placing model needs to recognise a trade."""
    return {
        "trade_id": trade["id"], "title": trade["title"], "kind": trade["trade_kind"], "stage": trade["trade_stage"],
        "started": trade.get("created_on"), "facts": trade["fact_line"],
        "fields": {k: str(v["value"])[:120] for k, v in trade["fields"].items() if v.get("value")},
        "contacts": sorted(trade["contact_emails"])[:10], "buyers": [b["name"] for b in trade["buyers"]][:15],
    }


def thread_digest(key, sources):
    first, last = sources[0], sources[-1]
    digest = {
        "key": key, "type": first["kind"], "subject": first["title"], "messages": len(sources),
        "first_date": first["at"].date().isoformat() if first["at"] else None,
        "last_date": last["at"].date().isoformat() if last["at"] else None,
        "people": sorted(set().union(*(s["participants"] for s in sources)))[:12],
        "start": first["text"][:1500],
    }
    if len(sources) > 1:
        digest["latest"] = last["text"][:1000]
    return digest


def place_threads(groups, trades, key, report):
    """Asks the model which trade each thread belongs to. Returns {thread key: {verdict, lot_id, reason}};
    threads the model skips or a failed call leaves out get no verdict and are not read this time."""
    verdicts, chunk, size = {}, [], 0
    digests = [thread_digest(k, sources) for k, sources in groups.items()]
    chunks = []
    for digest in digests:
        length = len(json.dumps(digest, ensure_ascii=False, default=str))
        if chunk and size + length > THREAD_BATCH_CHARS:
            chunks.append(chunk)
            chunk, size = [], 0
        chunk.append(digest)
        size += length
    if chunk:
        chunks.append(chunk)
    cards = [trade_card(t) for t in trades.values()]
    for chunk in chunks:
        try:
            raw = call_model(THREAD_SYSTEM, json.dumps({"TRADES": cards, "THREADS": chunk}, ensure_ascii=False, default=str), key)
        except Exception as err:
            report["warnings"].append(f"placing threads failed ({type(err).__name__})")
            continue
        report["model_calls"] = report.get("model_calls", 0) + 1
        keys = {d["key"] for d in chunk}
        for item in raw.get("threads") or []:
            if not isinstance(item, dict) or item.get("key") not in keys:
                continue
            verdict, lot_id = item.get("verdict"), item.get("trade_id")
            if verdict == "trade" and lot_id not in trades:
                continue
            if verdict not in ("trade", "none", "unclear"):
                continue
            verdicts[item["key"]] = {"verdict": verdict, "lot_id": lot_id if verdict == "trade" else None,
                                     "reason": str(item.get("reason") or "").strip()[:200] or None}
    return verdicts


def load_verdicts(cur, keys):
    cur.execute("select thread_key, lot_id, verdict from crm_bulk_trade_threads where thread_key = any(%s)", (list(keys),))
    return {row["thread_key"]: row for row in cur.fetchall()}


def save_verdicts(cur, run_id, verdicts):
    for thread, v in verdicts.items():
        cur.execute(
            """insert into crm_bulk_trade_threads (thread_key, lot_id, verdict, reason, run_id) values (%s, %s, %s, %s, %s)
               on conflict (thread_key) do update set lot_id = excluded.lot_id, verdict = excluded.verdict,
                 reason = excluded.reason, run_id = excluded.run_id, decided_at = now()""",
            (thread, v["lot_id"], v["verdict"], v["reason"], run_id))


def triage_card(sources, lots):
    first = sources[0]
    summary = (f"Couldn't tell whether “{first['title']}” is about this trade." if len(lots) == 1
               else f"“{first['title']}” involves {len(lots)} trades. Check which it belongs to.")
    return {"kind": "needs_triage", "target": None, "proposed": {"lot_ids": sorted(lots)},
            "summary": summary, "quote": first["title"], "source": first}


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


TRADE_SYSTEM = """You extract updates for one bulk battery trade from emails and meeting notes that have already been
judged to be about this trade's batch. Still skip any detail that is clearly about a different batch or deal.
Reply with ONLY a JSON object: {"proposals": [ ... ]}. No prose, no tools.
Each proposal: {"kind", "target", "proposed", "summary", "quote", "source_id"}.
- kind "field": target = one field key from FIELDS; proposed = {"value": "...", "status": "confirmed" | "unverified"}.
  Only when the source states a value that is new or different from the current one.
- kind "buyer_update": target = a buyer id from BUYERS; proposed may hold "status" (one of STATUSES),
  "last_touch_on" (YYYY-MM-DD), "last_touch_via" ("Email" | "Call" | "Meeting"), "chase_on" (YYYY-MM-DD).
- kind "next_step": proposed = {"next_step": "...", "next_step_due": "YYYY-MM-DD" or null, "waiting_on": "us" | "them"}.
  Only when the source makes a concrete next action clear.
- kind "new_buyer": proposed = {"name": "...", "contact": "...", "wants": "..."} for a buyer not in BUYERS.
- kind "bid": target = a buyer id from BUYERS; proposed = {"amount": number, "unit": "kWh" | "pack" | "cell",
  "currency": "EUR" | "USD" | "GBP", "firmness": "firm" | "indicative", "delivery_terms"?, "payment_terms"?}.
  Only a price a buyer actually offers for this batch.
- kind "trade_kind": proposed = {"trade_kind": "packs" | "cells" | "systems" | "recycling"}, only when TRADE has none.
- kind "link_contact": proposed = {"name": "...", "email": "..."} for a supplier-side person on this trade who
  appears in the source (the email address must be in the source) and is not in CONTACTS.
- kind "file": target = one attachment name from the source's "Attachments:" line, proposed = {}. Only files about
  THIS trade (spec sheets, test reports, photos, stock lists, contracts, LCs, proposals for this batch). Skip logos,
  signatures and files about other batches. Use the file name itself as the quote.
- "summary": one short plain sentence for Alex.
- "quote": copied EXACTLY, word for word, from the source text (8-300 characters). A proposal without an exact quote is discarded.
- "source_id": the id of the source the quote comes from.
SOURCES are in date order; when two disagree, the later one wins.
Propose nothing that is already recorded (compare with TRADE, FIELDS and BUYERS), speculative, or only implied.
An empty list is a good answer."""


def trade_prompt(trade, sources):
    kind = trade["trade_kind"] or "packs"
    fields = [{"key": f["key"], "label": f["label"], "current": trade["fields"].get(f["key"])}
              for f in TEMPLATES["fields"][kind]]
    context = {
        "TRADE": {k: trade[k] for k in ("title", "trade_kind", "trade_stage", "fact_line", "next_step", "next_step_due", "waiting_on")},
        "CONTACTS": sorted(trade["contact_emails"]),
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
    early = ("To contact", "Teaser sent", "No reply", "NDA, specs sent")
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
            if not target or target not in buyers:
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
        elif kind == "bid":
            if not target or target not in buyers:
                continue
            try:
                amount = float(str(proposed.get("amount")).replace(",", ""))
            except ValueError:
                continue
            if amount <= 0 or proposed.get("unit") not in ("kWh", "pack", "cell") or proposed.get("currency") not in ("EUR", "USD", "GBP"):
                continue
            proposed = {"amount": amount, "unit": proposed["unit"], "currency": proposed["currency"],
                        "firmness": proposed.get("firmness") if proposed.get("firmness") in ("firm", "indicative") else "indicative",
                        **{k: str(proposed[k]).strip()[:200] for k in ("delivery_terms", "payment_terms") if str(proposed.get(k) or "").strip()}}
            if buyers[target].get("status") in early:  # moving the buyer on is Alex's call
                kept.append({"kind": "buyer_update", "target": target, "proposed": {"status": "Bid in"},
                             "summary": f"{buyers[target]['name']} made a bid. Move them to Bid in?",
                             "quote": str(p["quote"]).strip()[:300], "source": source})
        elif kind == "new_buyer":
            name = str(proposed.get("name") or "").strip()
            if not name or name.lower() in {b["name"].lower() for b in trade["buyers"]}:
                continue
            proposed = {k: str(proposed.get(k) or "").strip() or None for k in ("name", "contact", "wants")}
            target = None
        elif kind == "trade_kind":
            if trade["trade_kind"] or proposed.get("trade_kind") not in TEMPLATES["fields"]:
                continue
            proposed = {"trade_kind": proposed["trade_kind"]}
            target = None
        elif kind == "link_contact":
            email = str(proposed.get("email") or "").strip().lower()
            if (not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email) or email.endswith("@" + OWN_DOMAIN)
                    or email in trade["contact_emails"] or email not in source["text"].lower() + " ".join(source["participants"])):
                continue
            proposed = {"name": str(proposed.get("name") or "").strip()[:120] or email, "email": email}
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
    try:
        result = subprocess.run(
            ["gog", "--account", "alex@rebattery.io", "--readonly", "--no-input", "--json", "gmail", "get", source["id"]],
            capture_output=True, text=True, timeout=120, env=gog_env(), check=True)
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


def insert_proposal(cur, run_id, lot_id, p, status="new"):
    """Records a finding once per source. Returns its id, or None when this source already gave it
    (including when Alex ignored or undid it)."""
    s = p["source"]
    cur.execute(
        """insert into crm_bulk_trade_proposals
             (lot_id, run_id, kind, target, proposed, summary, quote, source_kind, source_id, source_thread,
              source_url, source_label, source_at, status, applied_at)
           values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, case when %s = 'applied' then now() end)
           on conflict do nothing returning id""",
        (lot_id, run_id, p["kind"], p["target"], json.dumps(p["proposed"], sort_keys=True), p["summary"], p["quote"],
         s["kind"], s["id"], s["thread"], s["url"], s["label"], s["at"], status, status))
    row = cur.fetchone()
    return row["id"] if row else None


# ---------------------------------------------------------------------------
# Applying findings
# ---------------------------------------------------------------------------

# Applied in this order, so the trade kind is set before fields and buyers exist before updates.
APPLY_ORDER = ["trade_kind", "link_contact", "new_buyer", "field", "file", "buyer_update", "bid", "next_step"]
CARD_KINDS = {"needs_triage", "possible_trade", "possible_demand"}


def is_card(p):
    return p["kind"] in CARD_KINDS or (p["kind"] == "buyer_update" and "status" in p["proposed"])


def split_status(p):
    """A buyer update that changes status becomes a card for the status and an applied change for the rest."""
    if p["kind"] != "buyer_update" or "status" not in p["proposed"] or len(p["proposed"]) == 1:
        return [p]
    rest = {k: v for k, v in p["proposed"].items() if k != "status"}
    return [{**p, "proposed": {"status": p["proposed"]["status"]}}, {**p, "proposed": rest}]


def log_event(cur, lot_id, kind, changes, buyer_id=None):
    """Inbox-check writes are logged with no actor, which is how later runs tell them from Alex's."""
    cur.execute("insert into crm_bulk_trade_events (lot_id, kind, changes, buyer_id) values (%s, %s, %s, %s)",
                (lot_id, kind, json.dumps(changes, default=str), buyer_id))


def source_date(p):
    return p["source"]["at"].date().isoformat() if p["source"]["at"] else None


def field_owned_by_alex(cur, lot_id, key):
    """True when the field's current value was typed, accepted or settled by a person. Only the
    latest event that set the value counts; a conflict the check added does not change the value."""
    cur.execute(
        """select actor_user_id is not null as by_hand from crm_bulk_trade_events
           where lot_id = %s and kind = 'field_updated' and changes->>'field' = %s
             and (changes ? 'value' or changes ? 'resolved')
           order by occurred_at desc, id desc limit 1""", (lot_id, key))
    row = cur.fetchone()
    return True if row is None else row["by_hand"]


def apply_field(cur, lot_id, p, trade, ctx):
    key, value, status = p["target"], p["proposed"]["value"], p["proposed"]["status"]
    claim = {"value": value, "source_label": p["source"]["label"], "source_url": p["source"]["url"], "source_date": source_date(p)}
    cur.execute(
        """select value, status, visibility, source_label, source_url, to_char(source_date, 'YYYY-MM-DD') as source_date,
                  alternatives from crm_bulk_trade_fields where lot_id = %s and field_key = %s for update""", (lot_id, key))
    before = cur.fetchone()
    change = {"field": key, "proposal_id": ctx["proposal_id"]}
    if before is None:
        template = next((f for f in TEMPLATES["fields"][trade["trade_kind"] or "packs"] if f["key"] == key), None)
        if not template:
            return None
        cur.execute(
            """insert into crm_bulk_trade_fields (lot_id, field_key, value, status, visibility, source_label, source_url, source_date)
               values (%s, %s, %s, %s, %s, %s, %s, %s)""",
            (lot_id, key, value, status, template["visibility"], claim["source_label"], claim["source_url"], claim["source_date"]))
        log_event(cur, lot_id, "field_updated", {**change, "value": [None, value], "status": [None, status]})
        return {"before": None, "value": value}
    if norm(before["value"]) == norm(value):
        return None
    before = dict(before)
    if before["value"] and field_owned_by_alex(cur, lot_id, key):
        alternatives = list(before["alternatives"] or [])
        if any(norm(a.get("value")) == norm(value) for a in alternatives):
            return None
        cur.execute(
            """update crm_bulk_trade_fields set alternatives = %s, status = 'conflict', updated_at = now()
               where lot_id = %s and field_key = %s""", (json.dumps(alternatives + [claim]), lot_id, key))
        log_event(cur, lot_id, "field_updated", {**change, "alternatives": [before["alternatives"], alternatives + [claim]]})
        return {"before": before, "conflict": True}
    if before["source_date"] and claim["source_date"] and claim["source_date"] < before["source_date"]:
        return None  # an older email never replaces a newer one
    cur.execute(
        """update crm_bulk_trade_fields set value = %s, status = %s, source_label = %s, source_url = %s, source_date = %s,
             updated_at = now() where lot_id = %s and field_key = %s""",
        (value, status, claim["source_label"], claim["source_url"], claim["source_date"], lot_id, key))
    log_event(cur, lot_id, "field_updated", {**change, "value": [before["value"], value], "status": [before["status"], status]})
    return {"before": before, "value": value}


def apply_next_step(cur, lot_id, p, trade, ctx):
    proposed = p["proposed"]
    cur.execute(
        """select next_step, to_char(next_step_due, 'YYYY-MM-DD') as next_step_due, waiting_on,
                  to_char(waiting_since, 'YYYY-MM-DD') as waiting_since, next_step_contact_id, next_step_buyer_id
           from crm_bulk_trade_lots where id = %s for update""", (lot_id,))
    before = dict(cur.fetchone())
    if norm(before["next_step"]) == norm(proposed["next_step"]):
        return None
    # Alex's own next step stands until something newer than it arrives.
    cur.execute(
        """select max(occurred_at) as at from crm_bulk_trade_events
           where lot_id = %s and kind = 'trade_updated' and changes ? 'next_step' and actor_user_id is not null""", (lot_id,))
    by_hand = cur.fetchone()["at"]
    if by_hand and (not p["source"]["at"] or p["source"]["at"] <= by_hand):
        return None
    after = {"next_step": proposed["next_step"], "next_step_due": proposed["next_step_due"], "waiting_on": proposed["waiting_on"],
             "waiting_since": source_date(p) if proposed["waiting_on"] == "them" else None,
             "next_step_contact_id": None, "next_step_buyer_id": None}
    cur.execute(
        """update crm_bulk_trade_lots set next_step = %(next_step)s, next_step_due = %(next_step_due)s,
             waiting_on = %(waiting_on)s, waiting_since = %(waiting_since)s, next_step_contact_id = null,
             next_step_buyer_id = null, updated_at = now() where id = %(id)s""", {**after, "id": lot_id})
    log_event(cur, lot_id, "trade_updated", {"proposal_id": ctx["proposal_id"],
                                             **{k: [before[k], v] for k, v in after.items() if before[k] != v}})
    return {"before": before, "after": after}


def apply_trade_kind(cur, lot_id, p, trade, ctx):
    cur.execute("update crm_bulk_trade_lots set trade_kind = %s, updated_at = now() where id = %s and trade_kind is null returning id",
                (p["proposed"]["trade_kind"], lot_id))
    if not cur.fetchone():
        return None
    log_event(cur, lot_id, "trade_updated", {"proposal_id": ctx["proposal_id"], "trade_kind": [None, p["proposed"]["trade_kind"]]})
    return {"before": None, "after": p["proposed"]["trade_kind"]}


def apply_contact(cur, lot_id, p, trade, ctx):
    email = p["proposed"]["email"]
    cur.execute("select 1 from crm_bulk_trade_contacts where lot_id = %s and lower(email) = %s", (lot_id, email))
    if cur.fetchone():
        return None
    contact_id = f"btc_{uuid.uuid4()}"
    cur.execute(
        """insert into crm_bulk_trade_contacts (id, lot_id, name, email, sort_order)
           select %s, %s, %s, %s, coalesce(max(sort_order), -1) + 1 from crm_bulk_trade_contacts where lot_id = %s""",
        (contact_id, lot_id, p["proposed"]["name"], email, lot_id))
    log_event(cur, lot_id, "contact_added", {"id": contact_id, "name": p["proposed"]["name"], "email": email,
                                             "proposal_id": ctx["proposal_id"]})
    ctx["new_contacts"].add(lot_id)
    return {"id": contact_id}


def apply_new_buyer(cur, lot_id, p, trade, ctx):
    proposed = p["proposed"]
    cur.execute("select 1 from crm_bulk_trade_buyers where lot_id = %s and lower(name) = lower(%s)", (lot_id, proposed["name"]))
    if cur.fetchone():
        return None
    buyer_id = f"btb_{uuid.uuid4()}"
    # Status and CRM person come only from platform records (the auction sync), never from email reading.
    cur.execute(
        """insert into crm_bulk_trade_buyers (id, lot_id, name, contact, wants, person_id, status, last_touch_on, last_touch_via)
           values (%s, %s, %s, %s, %s, %s, coalesce(%s, 'To contact'), %s, %s)""",
        (buyer_id, lot_id, proposed["name"], proposed.get("contact"), proposed.get("wants"), proposed.get("person_id"),
         proposed.get("status"), proposed.get("last_touch_on"), proposed.get("last_touch_via")))
    log_event(cur, lot_id, "buyer_added", {**proposed, "proposal_id": ctx["proposal_id"]}, buyer_id)
    return {"id": buyer_id}


def apply_buyer_update(cur, lot_id, p, trade, ctx):
    cur.execute(
        """select to_char(last_touch_on, 'YYYY-MM-DD') as last_touch_on, last_touch_via, to_char(chase_on, 'YYYY-MM-DD') as chase_on
           from crm_bulk_trade_buyers where id = %s and lot_id = %s for update""", (p["target"], lot_id))
    row = cur.fetchone()
    if not row:
        return None
    patch = {k: v for k, v in p["proposed"].items() if k in row and row[k] != v}
    if row["last_touch_on"] and patch.get("last_touch_on", "9999") < row["last_touch_on"]:
        patch.pop("last_touch_on", None)  # never move the last touch backwards
        patch.pop("last_touch_via", None)
    if not patch:
        return None
    cur.execute(f"update crm_bulk_trade_buyers set {', '.join(f'{k} = %s' for k in patch)}, updated_at = now() where id = %s",
                (*patch.values(), p["target"]))
    log_event(cur, lot_id, "buyer_updated", {"proposal_id": ctx["proposal_id"], **{k: [row[k], v] for k, v in patch.items()}}, p["target"])
    return {"before": {k: row[k] for k in patch}, "after": patch}


def apply_bid(cur, lot_id, p, trade, ctx):
    bid = p["proposed"]
    cur.execute(
        """select 1 from crm_bulk_trade_bids where buyer_id = %s and lot_id = %s and amount = %s and unit = %s and currency = %s""",
        (p["target"], lot_id, bid["amount"], bid["unit"], bid["currency"]))
    if cur.fetchone():
        return None
    cur.execute(
        """insert into crm_bulk_trade_bids (lot_id, buyer_id, amount, unit, currency, firmness, delivery_terms, payment_terms)
           values (%s, %s, %s, %s, %s, %s, %s, %s) returning id""",
        (lot_id, p["target"], bid["amount"], bid["unit"], bid["currency"], bid["firmness"],
         bid.get("delivery_terms"), bid.get("payment_terms")))
    bid_id = cur.fetchone()["id"]
    log_event(cur, lot_id, "bid_added", {**bid, "proposal_id": ctx["proposal_id"]}, p["target"])
    return {"id": str(bid_id)}


def gog_env():
    env = dict(os.environ)
    if KEYRING_FILE.exists() and "GOG_KEYRING_PASSWORD" not in env:
        env["GOG_KEYRING_PASSWORD"] = KEYRING_FILE.read_text().strip()
    return env


def download_attachment(mailbox, message_id, attachment_id):
    with tempfile.TemporaryDirectory(prefix="bt-attachment-") as folder:
        out = Path(folder) / "file"
        subprocess.run(["gog", "--account", mailbox, "--readonly", "--no-input", "gmail", "attachment", message_id,
                        attachment_id, "--out", str(out)], capture_output=True, timeout=300, env=gog_env(), check=True)
        return out.read_bytes()


def apply_file(cur, lot_id, p, trade, ctx):
    proposed = p["proposed"]
    cur.execute("select 1 from crm_bulk_trade_files where lot_id = %s and lower(file_name) = lower(%s)", (lot_id, proposed["file_name"]))
    if cur.fetchone() or not proposed.get("attachment_id"):
        return None
    content = ctx["download"](ctx["mailbox"], proposed["gmail_message_id"], proposed["attachment_id"])
    if not content or len(content) > MAX_FILE_BYTES:
        return None
    file_id = f"btf_{uuid.uuid4()}"
    cur.execute(
        """insert into crm_bulk_trade_files (id, lot_id, file_name, file_type, content_type, byte_size, content,
             source_label, source_date, visibility) values (%s, %s, %s, %s, %s, %s, %s, %s, %s, 'never')""",
        (file_id, lot_id, proposed["file_name"], proposed["file_type"], mimetypes.guess_type(proposed["file_name"])[0],
         len(content), psycopg2.Binary(content), p["source"]["label"], source_date(p)))
    log_event(cur, lot_id, "file_added", {"id": file_id, "file_name": proposed["file_name"], "byte_size": len(content),
                                          "file_type": proposed["file_type"], "proposal_id": ctx["proposal_id"]})
    return {"id": file_id}


APPLY = {"field": apply_field, "next_step": apply_next_step, "trade_kind": apply_trade_kind, "link_contact": apply_contact,
         "new_buyer": apply_new_buyer, "buyer_update": apply_buyer_update, "bid": apply_bid, "file": apply_file}


def settle(cur, run_id, lot_id, p, trade, ctx):
    """Writes one finding: a card for Alex, or the change itself with its undo record. Returns
    "card", "applied" or None (already known, or nothing left to change)."""
    if is_card(p):
        return "card" if insert_proposal(cur, run_id, lot_id, p) else None
    cur.execute("savepoint finding")
    ctx["proposal_id"] = insert_proposal(cur, run_id, lot_id, p, status="applied")
    if not ctx["proposal_id"]:
        cur.execute("release savepoint finding")
        return None
    try:
        undo = APPLY[p["kind"]](cur, lot_id, p, trade, ctx)
    except Exception as err:  # one bad finding must not lose the rest; it is tried again next run
        cur.execute("rollback to savepoint finding")
        ctx["warnings"].append(f"{p['kind']} {p['target'] or ''}: not applied ({type(err).__name__})".replace("  ", " "))
        return None
    if undo is None:
        cur.execute("rollback to savepoint finding")
        return None
    cur.execute("update crm_bulk_trade_proposals set undo = %s where id = %s", (json.dumps(undo, default=str), ctx["proposal_id"]))
    ctx["undo"] = undo
    cur.execute("release savepoint finding")
    return "applied"


def settle_all(cur, run_id, lot_id, findings, trade, ctx, report, dry_run):
    """Settles one trade's findings in APPLY_ORDER and adds them to the report."""
    items = [q for p in findings for q in split_status(p)]
    items.sort(key=lambda p: (is_card(p), APPLY_ORDER.index(p["kind"]) if p["kind"] in APPLY_ORDER else 99))
    for p in items:
        outcome = ("card" if is_card(p) else "apply") if dry_run else settle(cur, run_id, lot_id, p, trade, ctx)
        if outcome:
            report["cards" if outcome == "card" else "applied"].append(
                {"lot_id": lot_id, "kind": p["kind"], "target": p["target"], "proposed": p["proposed"],
                 "summary": p["summary"], "quote": p["quote"], "source": p["source"]["label"]})


def start_history(lot_id, args):
    """Reads a trade's past emails after the check links a new person to it. Detached; logs to a file."""
    HISTORY_LOG_DIR.mkdir(parents=True, exist_ok=True)
    log = HISTORY_LOG_DIR / f"history-{lot_id}.log"
    with open(log, "ab") as out:
        os.chmod(log, 0o600)
        subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--history", lot_id, "--dsn", args.dsn,
                          "--mailbox", args.mailbox], stdout=out, stderr=out, start_new_session=True)


# ---------------------------------------------------------------------------
# Demand
# ---------------------------------------------------------------------------

DEMAND_INTENT = re.compile(
    r"\b(looking for|we (?:are |'re )?(?:looking|searching) for|we (?:need|require)|in need of|"
    r"interested in (?:buying|purchasing|acquiring|sourcing)|want to (?:buy|purchase)|wish to (?:buy|purchase)|"
    r"would like to (?:buy|purchase)|wtb|in the market for|rfq|request for quot\w*|can you supply|"
    r"monthly (?:volume|demand|requirement)|offtake|to source)\b", re.I)
NEWSLETTER = re.compile(r"unsubscribe|view (?:this email )?in (?:your )?browser|newsletter|webinar", re.I)
MAX_DEMAND_SOURCES = 30
STALE_DAYS = 60  # stated and agreed buy-boxes to reconfirm; matches STALE_DAYS in apps/web/lib/bulk-demand.ts
WAITING_DAYS = 30  # unanswered buyer email older than this has usually moved to WhatsApp or the phone; matches the app

DEMAND_SYSTEM = """You find BULK BUY DEMAND for ReBattery, a broker of second-life and surplus EV batteries, modules, cells and BESS.
Reply with ONLY JSON: {"demands": [{"source_id", "buyer_company", "contact_name", "contact_email", "wants", "quantity",
"where", "kind", "needed_by", "volume", "volume_unit", "max_price", "price_currency", "price_unit", "spec", "quote"}]}.
Include a source only when a person or company OUTSIDE ReBattery says they want to BUY or source batteries in bulk
(2 or more packs/modules/systems, cells in volume, or recycling feedstock by the tonne), now or on a recurring basis.
Skip sellers offering stock, ReBattery's own outreach, newsletters, marketing, single-battery retail requests, and
vague "keep us in mind".
- "wants": one plain line in the buyer's terms, e.g. "NMC EV packs 30-70 kWh for storage builds, up to ~EUR 20/kWh".
- "quantity": the amount in their words, e.g. "100+ packs" or null; "where": delivery country or region, or null.
- "kind": "request" for a one-off need (a quantity wanted now or by a date), "standing" for ongoing or repeat buying.
- "needed_by": YYYY-MM-DD, requests only, only when a date or deadline is stated; else null.
- "volume" + "volume_unit" (%(volume_units)s): a number, the total for a request, per month for standing; else null.
- "max_price" + "price_currency" (%(currencies)s) + "price_unit" (%(price_units)s): only when a ceiling is stated.
- "spec": only these keys, each a list of values copied exactly from its options, only what is stated:
%(lists)s
  and numbers kwh_min, kwh_max (per unit), min_soh (0-100); mixed_ok true/false. {} when nothing is stated.
  Storage systems (BESS, containers): formats "Systems", origins "Stationary storage", brand in system_brands, not makes.
- "quote": copied EXACTLY from the source (8-300 characters). An empty list is a good answer.""" % {
    "volume_units": ", ".join(BUY_BOX["volume_units"]), "currencies": ", ".join(BUY_BOX["currencies"]),
    "price_units": ", ".join(BUY_BOX["price_units"]),
    "lists": "\n".join(f"  {key}: {' | '.join(values)}" for key, values in BUY_BOX["lists"].items())}


def clean_spec(raw):
    """Keeps the valid parts of a model-written spec: known list values, in-range numbers, a boolean mixed_ok."""
    out = {}
    if not isinstance(raw, dict):
        return out
    for key, value in raw.items():
        if key in BUY_BOX["lists"] and isinstance(value, list):
            kept = [v for v in dict.fromkeys(value) if v in BUY_BOX["lists"][key]]
            if kept:
                out[key] = kept
        elif key in BUY_BOX["numbers"] and isinstance(value, (int, float)) and not isinstance(value, bool):
            limits = BUY_BOX["numbers"][key]
            if limits["min"] <= value <= limits["max"]:
                out[key] = value
        elif key == "mixed_ok" and isinstance(value, bool):
            out[key] = value
    if "kwh_min" in out and "kwh_max" in out and out["kwh_min"] > out["kwh_max"]:
        out.pop("kwh_min"), out.pop("kwh_max")
    return out


def clean_structured(d):
    """The structured part of a found demand, keeping only values the app will accept."""
    out = {"kind": d.get("kind") if d.get("kind") in ("request", "standing") else None}
    needed = str(d.get("needed_by") or "")
    if out["kind"] == "request" and re.fullmatch(r"\d{4}-\d{2}-\d{2}", needed):
        out["needed_by"] = needed
    volume = d.get("volume")
    if isinstance(volume, (int, float)) and not isinstance(volume, bool) and volume > 0 and d.get("volume_unit") in BUY_BOX["volume_units"]:
        out["volume"], out["volume_unit"] = volume, d["volume_unit"]
    price = d.get("max_price")
    if (isinstance(price, (int, float)) and not isinstance(price, bool) and price > 0
            and d.get("price_currency") in BUY_BOX["currencies"] and d.get("price_unit") in BUY_BOX["price_units"]):
        out["max_price"], out["price_currency"], out["price_unit"] = price, d["price_currency"], d["price_unit"]
    spec = clean_spec(d.get("spec"))
    if spec:
        out["spec"] = spec
    return {k: v for k, v in out.items() if v is not None}


def screen_demand(cur, sources, key, report):
    """Possible-demand cards for new mail and calls that ask to buy in bulk. A buyer who already has
    an open demand row gets an update card for that row instead."""
    candidates = [s for s in sources if s["inbound"] and DEMAND_INTENT.search(s["text"][:6000])
                  and DEAL_WORDS.search(s["text"][:6000]) and not NEWSLETTER.search(s["text"])][-MAX_DEMAND_SOURCES:]
    if not candidates:
        return []
    try:
        raw = call_model(DEMAND_SYSTEM, json.dumps({"SOURCES": [
            {"source_id": s["id"], "type": s["kind"], "date": s["at"].date().isoformat() if s["at"] else None,
             "from": s.get("from"), "text": s["text"][:5000 if s["kind"] == "granola" else 3000]} for s in candidates]},
            ensure_ascii=False, default=str), key)
        report["model_calls"] = report.get("model_calls", 0) + 1
    except Exception as err:
        report["warnings"].append(f"demand screen failed ({type(err).__name__})")
        return []
    by_id = {s["id"]: s for s in candidates}
    out = []
    for d in raw.get("demands") or []:
        source = by_id.get(str(d.get("source_id")))
        wants = str(d.get("wants") or "").strip()
        if not source or not wants or not quote_ok(d.get("quote"), source["text"]):
            continue
        email = str(d.get("contact_email") or source.get("from") or "").strip().lower() or None
        if email and email.endswith("@" + OWN_DOMAIN):
            continue
        company = str(d.get("buyer_company") or "").strip() or None
        cur.execute(
            """select id from crm_bulk_trade_demand where status = 'open'
                 and ((%s::text is not null and email = %s) or (%s::text is not null and lower(buyer) = lower(%s)))
               order by updated_at desc limit 1""", (email, email, company, company))
        existing = cur.fetchone()
        name = company or str(d.get("contact_name") or "").strip() or email or "Unknown buyer"
        proposed = {"buyer": name[:120], "contact": str(d.get("contact_name") or "").strip()[:120] or None, "email": email,
                    "wants": wants[:300], "quantity": str(d.get("quantity") or "").strip()[:80] or None,
                    "location": str(d.get("where") or "").strip()[:80] or None,
                    "demand_id": existing["id"] if existing else None, **clean_structured(d)}
        label = "needs" if proposed.get("kind") == "request" else "wants"
        out.append({"kind": "possible_demand", "target": proposed["demand_id"], "proposed": proposed,
                    "summary": f"{name} {'updated what they want' if existing else label}: {wants}"[:300],
                    "quote": str(d["quote"]).strip()[:300], "source": source})
    return out


MATCH_SYSTEM = """You match open buyer DEMAND rows to bulk battery TRADES (supply) for ReBattery, a broker of second-life
and surplus EV batteries, modules, cells and BESS. Reply with ONLY JSON:
{"matches": [{"trade_id", "demand_id", "strength", "reason"}]}, one entry per trade and row that fit; leave out the rest.
Each DEMAND row is a "request" (a one-off need, maybe by "needed_by") or a "standing" buy-box with a "basis":
"agreed" and "stated" come from the buyer; "estimated" is ReBattery's guess from research, so match it only on a
clear fit with its spec. "spec", "volume" and "max_price" are structured; "wants" is the buyer's own words; "note"
holds other requirements (voltage, connectors, use, risk answers) that rule a batch out as surely as the spec.
A missing spec value means unknown, not "no".
A TRADE's "seller_price", when given, is what ReBattery pays the seller (internal). A buyer's max_price must leave
room above it; when it does not, the pair is at best "partial" with price as the catch.
- "strong": the trade's batch is the kind of thing the buyer asked for (form, chemistry, size, quantity, use) and
  nothing obvious rules it out, including anything in spec "excludes".
- "partial": a plausible fit with one clear catch (e.g. packs vs cells, region, price, volume); name the catch.
"reason": one short plain sentence for Alex, naming the fit and any catch."""

MATCH_ROWS_PER_CALL = 60
# What a demand row is judged on. A "Still wanted" confirmation, a close or a contact edit changes none of it.
MATCH_CONTENT = ("kind", "basis", "buyer", "wants", "quantity", "location", "needed_by", "volume", "volume_unit",
                 "max_price", "price_currency", "price_unit", "spec", "note")


def content_hash(value):
    return hashlib.sha1(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()


def live_trade_facts(trade):
    """What the matching sees of a trade. seller_price is included for the price check; the model's reasons are
    shown only to Alex, never to buyers."""
    fields = {k: v["value"] for k, v in sorted(trade["fields"].items()) if v.get("value")}
    return {k: trade[k] for k in ("title", "trade_kind", "trade_stage", "fact_line")} | {"fields": fields}


def judge(trades, rows, key, report):
    """Asks the model which (trade, row) pairs fit, in calls of at most MATCH_ROWS_PER_CALL rows. Returns the valid
    pairs, or None when a call failed (so nothing is recorded as judged)."""
    trade_ids = {lot for lot, _ in trades}
    pairs = []
    for start in range(0, len(rows), MATCH_ROWS_PER_CALL):
        chunk = rows[start:start + MATCH_ROWS_PER_CALL]
        row_ids = {r["id"] for r in chunk}
        payload = {"TRADES": [{"trade_id": lot, **facts} for lot, facts in trades], "DEMAND": chunk}
        try:
            raw = call_model(MATCH_SYSTEM, json.dumps(payload, ensure_ascii=False, default=str), key)
            report["model_calls"] += 1
        except Exception as err:
            report["warnings"].append(f"demand matching failed ({type(err).__name__})")
            return None
        # One trade per call needs no trade_id from the model.
        only = next(iter(trade_ids)) if len(trade_ids) == 1 else None
        for m in raw.get("matches") or []:
            if not isinstance(m, dict):
                continue
            lot = m.get("trade_id") if m.get("trade_id") in trade_ids else only
            if lot and m.get("demand_id") in row_ids and m.get("strength") in ("strong", "partial") \
                    and str(m.get("reason") or "").strip():
                pairs.append({"lot_id": lot, "demand_id": m["demand_id"], "strength": m["strength"],
                              "reason": str(m["reason"]).strip()[:300]})
    return pairs


def store_pairs(cur, lot_ids, demand_ids, pairs):
    """Replaces the verdicts for every judged (trade, row) pair. Hidden pairs stay hidden; pairs whose buyer is already
    on the trade are left alone."""
    keep = [(p["lot_id"], p["demand_id"]) for p in pairs]
    cur.execute(
        """delete from crm_bulk_trade_demand_matches m
           where m.lot_id = any(%s) and m.demand_id = any(%s) and not m.hidden and m.buyer_id is null
             and not exists (select 1 from unnest(%s::text[], %s::text[]) as k(lot_id, demand_id)
                             where k.lot_id = m.lot_id and k.demand_id = m.demand_id)""",
        (list(lot_ids), list(demand_ids), [k[0] for k in keep], [k[1] for k in keep]))
    for p in pairs:
        cur.execute(
            """insert into crm_bulk_trade_demand_matches (demand_id, lot_id, strength, reason) values (%s, %s, %s, %s)
               on conflict (demand_id, lot_id) do update set strength = excluded.strength, reason = excluded.reason,
                 matched_at = now()""", (p["demand_id"], p["lot_id"], p["strength"], p["reason"]))


def match_demand(conn, key, report=None, dry_run=False):
    """Judges only what changed: a live trade whose facts changed against every open row, and rows whose matching
    content changed against the other live trades. A closed or expired row loses its suggestions without a call.
    Recorded as a run of kind 'match'; the summary is also returned (and put under report["demand_matching"])."""
    out = {"model_calls": 0, "trades_rejudged": 0, "rows_rejudged": 0, "matches": [], "warnings": []}
    if report is not None:
        report["demand_matching"] = out
    run_id = None
    if not dry_run:
        with conn.cursor() as cur:
            cur.execute("insert into crm_bulk_trade_check_runs (kind) values ('match') returning id")
            run_id = cur.fetchone()[0]
        conn.commit()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """select id, kind, basis, buyer, wants, quantity, location, to_char(needed_by, 'YYYY-MM-DD') as needed_by,
                          volume::float8 as volume, volume_unit, max_price::float8 as max_price, price_currency, price_unit,
                          spec, left(note, 600) as note, to_char(confirmed_on, 'YYYY-MM-DD') as confirmed, match_hash
                   from crm_bulk_trade_demand
                   where status = 'open' and (kind <> 'request' or needed_by is null or needed_by >= current_date)
                   order by id""")
            demand = cur.fetchall()
            trades = load_trades(cur)
            cur.execute("select id, demand_fingerprint from crm_bulk_trade_lots where id = any(%s)", (list(trades),))
            stored = {r["id"]: r["demand_fingerprint"] for r in cur.fetchall()}

            facts = {lot: live_trade_facts(t) for lot, t in trades.items()}
            trade_hash = {lot: content_hash(f) for lot, f in facts.items()}
            row_hash = {d["id"]: content_hash({k: d[k] for k in MATCH_CONTENT}) for d in demand}
            rows = {d["id"]: {k: v for k, v in d.items() if k != "match_hash" and v not in (None, {}, [])} for d in demand}
            all_ids = list(rows)

            changed_trades = [lot for lot in trades if stored.get(lot) != trade_hash[lot]]
            steady_trades = [lot for lot in trades if lot not in changed_trades]
            changed_rows = [d["id"] for d in demand if d["match_hash"] != row_hash[d["id"]]]
            every_trade_judged = True

            for lot in changed_trades:  # 1. a changed trade against every open row
                pairs = judge([(lot, facts[lot])], list(rows.values()), key, out) if rows else []
                if pairs is None:
                    every_trade_judged = False
                    continue
                out["trades_rejudged"] += 1
                out["matches"] += pairs
                if not dry_run:
                    store_pairs(cur, [lot], all_ids, pairs)
                    cur.execute("update crm_bulk_trade_lots set demand_fingerprint = %s where id = %s", (trade_hash[lot], lot))
                    conn.commit()

            judged_rows = changed_rows if every_trade_judged else []
            if changed_rows and steady_trades:  # 2. changed rows against the trades that did not change
                pairs = judge([(lot, facts[lot]) for lot in steady_trades], [rows[i] for i in changed_rows], key, out)
                if pairs is None:
                    judged_rows = []
                else:
                    out["matches"] += pairs
                    if not dry_run:
                        store_pairs(cur, steady_trades, changed_rows, pairs)
            out["rows_rejudged"] = len(judged_rows)

            if not dry_run:
                for row_id in judged_rows:
                    cur.execute("update crm_bulk_trade_demand set match_hash = %s where id = %s", (row_hash[row_id], row_id))
                # 3. closed or expired rows, and trades no longer live, keep no open suggestions
                cur.execute(
                    """delete from crm_bulk_trade_demand_matches m
                       where not m.hidden and m.buyer_id is null
                         and (not (m.demand_id = any(%s)) or not (m.lot_id = any(%s)))""", (all_ids, list(trades)))
                cur.execute(
                    """update crm_bulk_trade_check_runs set status = 'ok', finished_at = now(), proposals_made = %s,
                         error = %s where id = %s""",
                    (len(out["matches"]), "; ".join(out["warnings"]) or None, run_id))
                conn.commit()
    except Exception as err:  # matching must never take the inbox check or auction sync down with it
        fail_run(conn, run_id, err)
        out["warnings"].append(f"demand matching stopped ({type(err).__name__}: {str(err)[:200]})")
    return out


# ---------------------------------------------------------------------------
# Runs
# ---------------------------------------------------------------------------

def last_cursor(cur):
    cur.execute("select cursor from crm_bulk_trade_check_runs where status = 'ok' and kind = 'check' order by started_at desc limit 1")
    row = cur.fetchone()
    return row["cursor"] if row else {}


def new_run(conn, args, kind="check", lot_id=None):
    if args.dry_run:
        return None
    with conn.cursor() as cur:
        cur.execute("insert into crm_bulk_trade_check_runs (kind, lot_id) values (%s, %s) returning id", (kind, lot_id))
        run_id = cur.fetchone()[0]
    conn.commit()
    return run_id


def fail_run(conn, run_id, err):
    conn.rollback()
    if run_id:
        with conn.cursor() as cur:
            cur.execute("update crm_bulk_trade_check_runs set status = 'failed', finished_at = now(), error = %s where id = %s",
                        (f"{type(err).__name__}: {str(err)[:300]}", run_id))
        conn.commit()


def extract(trade, sources, key, report):
    """Reads a trade's placed sources in date-ordered batches. Returns the latest finding per thing
    it changes; each batch sees the picture left by the ones before."""
    latest = {}
    for batch in batches(sources, HISTORY_BATCH_CHARS):
        for source in batch:
            add_attachments(source)
        try:
            raw = call_model(TRADE_SYSTEM, trade_prompt(trade, batch), key)
        except Exception as err:  # one batch failing must not lose the rest
            report["warnings"].append(f"{trade['title']}: reading failed ({type(err).__name__})")
            continue
        report["model_calls"] = report.get("model_calls", 0) + 1
        fold(trade, validate(raw, trade, {s["id"]: s for s in batch}), latest)
    return list(latest.values())


def gateway_key():
    return os.environ.get("HERMES_API_KEY") or read_env_value(HERMES_ENV, "API_SERVER_KEY")


def new_report(**extra):
    return {**extra, "emails_read": 0, "notes_read": 0, "threads": {}, "model_calls": 0,
            "applied": [], "cards": [], "warnings": []}


def finish_run(cur, run_id, report, cursor=None):
    made = len(report["applied"]) + len(report["cards"])
    cur.execute(
        """update crm_bulk_trade_check_runs set status = 'ok', finished_at = now(), emails_read = %s, notes_read = %s,
             proposals_made = %s, cursor = coalesce(%s, cursor), error = %s where id = %s""",
        (report["emails_read"], report["notes_read"], made, json.dumps(cursor) if cursor else None,
         "; ".join(report["warnings"]) or None, run_id))


def run(conn, args):
    now = dt.datetime.now(dt.timezone.utc)
    key = gateway_key()
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("select pg_try_advisory_lock(hashtext('bulk_trade_inbox_check')) as locked")
        if not cur.fetchone()["locked"]:
            print("Another inbox check is running; skipped.")
            return 0
        cursor = last_cursor(cur)
    default_since = now - FIRST_RUN_LOOKBACK
    gmail_since = parse_time(args.since or cursor.get("gmail_since")) or default_since
    granola_since = parse_time(args.since or cursor.get("granola_since")) or default_since
    run_id = new_run(conn, args)

    report = new_report(run_id=run_id)
    ctx = {"mailbox": args.mailbox, "download": download_attachment, "new_contacts": set(), "warnings": report["warnings"]}
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            warning = refresh_granola()
            if warning:
                report["warnings"].append(warning)
            trades = load_trades(cur)
            emails = load_emails(cur, args.mailbox, gmail_since)
            notes = load_granola(granola_since)
            report["emails_read"], report["notes_read"] = len(emails), len(notes)

            groups = by_thread(emails + notes)
            verdicts = load_verdicts(cur, groups)
            by_trade, to_place, candidates, unmatched = {}, {}, {}, []
            for thread, sources in groups.items():
                known = verdicts.get(thread)
                if known:  # placed before: later messages follow the thread
                    if known["verdict"] == "trade" and known["lot_id"] in trades:
                        by_trade.setdefault(known["lot_id"], []).extend(sources)
                    continue
                lots = set().union(*(match(s, trades) for s in sources))
                if lots:
                    to_place[thread], candidates[thread] = sources, lots
                else:
                    unmatched += [s for s in sources
                                  if s["kind"] == "gmail" and s["inbound"] and DEAL_WORDS.search(s["text"][:3000])]

            findings = {}  # lot_id or None -> [finding]
            if to_place and key:
                placed = place_threads(to_place, trades, key, report)
                if not args.dry_run:
                    save_verdicts(cur, run_id, placed)
                for thread, v in placed.items():
                    report["threads"][v["verdict"]] = report["threads"].get(v["verdict"], 0) + 1
                    if v["verdict"] == "trade":
                        by_trade.setdefault(v["lot_id"], []).extend(to_place[thread])
                    elif v["verdict"] == "unclear":
                        lots = sorted(candidates[thread])
                        findings.setdefault(lots[0], []).append(triage_card(to_place[thread], lots))
            elif to_place:
                report["warnings"].append("no gateway key; new threads not read")

            for lot_id, sources in by_trade.items():
                findings.setdefault(lot_id, []).extend(extract(trades[lot_id], sorted(sources, key=lambda s: s["at"] or EPOCH), key, report))

            if key:
                findings.setdefault(None, []).extend(screen_demand(cur, emails + notes, key, report))
            if unmatched and key:
                for item in screen_possible(cur, unmatched, key, report):
                    findings.setdefault(item.pop("lot_id", None), []).append(item)

            for lot_id, items in findings.items():
                settle_all(cur, run_id, lot_id, items, trades.get(lot_id), ctx, report, args.dry_run)

            if not args.dry_run:
                latest = lambda items, fallback: max([s["synced_at"] for s in items if s["synced_at"]] + [fallback])
                finish_run(cur, run_id, report, {"gmail_since": latest(emails, gmail_since).isoformat(),
                                                 "granola_since": latest(notes, granola_since).isoformat()})
            conn.commit()
    except Exception as err:
        fail_run(conn, run_id, err)
        raise
    for lot_id in ctx["new_contacts"]:  # someone new on a trade: read their past emails for it
        start_history(lot_id, args)
    if key:
        match_demand(conn, key, report, dry_run=args.dry_run)
    json.dump(report, sys.stdout, indent=2, ensure_ascii=False, default=str)
    print()
    return 0


def screen_possible(cur, unmatched, key, report):
    """Inbound deal-like mail from unknown people: a possible new trade, or a new person on an existing one."""
    out = []
    try:
        cur.execute("select id, title from crm_bulk_trade_lots where trade_stage <> 'Lost' order by title")
        existing = {row["id"]: row["title"] for row in cur.fetchall()}
        raw = call_model(POSSIBLE_SYSTEM, json.dumps({
            "EXISTING": [{"id": k, "title": v} for k, v in existing.items()],
            "EMAILS": [{"source_id": s["id"], "text": s["text"][:3000]} for s in unmatched[-MAX_SCREENED_EMAILS:]],
        }, ensure_ascii=False), key)
        report["model_calls"] += 1
    except Exception as err:
        report["warnings"].append(f"possible-trade screen failed ({type(err).__name__})")
        return out
    by_id = {s["id"]: s for s in unmatched}
    for t in raw.get("trades") or []:
        source = by_id.get(str(t.get("source_id")))
        if not source or not quote_ok(t.get("quote"), source["text"]) or not str(t.get("title") or "").strip():
            continue
        existing_id = t.get("existing_trade_id")
        if existing_id in existing and source.get("from"):
            # Settled against its own trade below; the contact makes the rest of their mail match.
            out.append({"kind": "link_contact", "target": None, "lot_id": existing_id,
                        "proposed": {"name": source["from"], "email": source["from"]},
                        "summary": f"{source['from']} wrote about {existing[existing_id]}; added as a contact.",
                        "quote": str(t["quote"]).strip()[:300], "source": source})
            continue
        kind = t.get("trade_kind") if t.get("trade_kind") in TEMPLATES["fields"] else None
        out.append({"kind": "possible_trade", "target": None,
                    "proposed": {"title": str(t["title"]).strip()[:120], "trade_kind": kind, "email": source.get("from")},
                    "summary": str(t.get("summary") or "").strip()[:300] or "Possible new trade",
                    "quote": str(t["quote"]).strip()[:300], "source": source})
    return out


EPOCH = dt.datetime(2000, 1, 1, tzinfo=dt.timezone.utc)
HISTORY_BATCH_CHARS = 24000


def batches(sources, budget=HISTORY_BATCH_CHARS):
    """Consecutive groups of sources that fit one model call."""
    batch, size = [], 0
    for source in sources:
        length = min(len(source["text"]), MAX_SOURCE_CHARS)
        if batch and size + length > budget:
            yield batch
            batch, size = [], 0
        batch.append(source)
        size += length
    if batch:
        yield batch


def fold(trade, kept, latest):
    """Apply one batch's proposals to the working picture of the trade, so the next batch only
    proposes real changes, and keep the latest proposal per thing it changes."""
    for p in kept:
        kind, proposed = p["kind"], p["proposed"]
        if kind == "field":
            trade["fields"][p["target"]] = {"value": proposed["value"], "status": proposed["status"]}
            key = ("field", p["target"])
        elif kind == "buyer_update":
            buyer = next(b for b in trade["buyers"] if b["id"] == p["target"])
            buyer.update(proposed)
            key = ("buyer_update", p["target"])
            earlier = latest.get(key)
            if earlier:  # several updates to one buyer merge; later values win
                p = {**p, "proposed": {**earlier["proposed"], **proposed}}
        elif kind == "next_step":
            trade["next_step"] = proposed["next_step"]
            key = ("next_step",)
        elif kind == "new_buyer":
            # Listed for later batches, without an id, so nothing can target it before it exists.
            trade["buyers"].append({"id": None, "name": proposed["name"], "contact": proposed.get("contact"), "status": "To contact"})
            key = ("new_buyer", proposed["name"].lower())
        elif kind == "trade_kind":
            trade["trade_kind"] = proposed["trade_kind"]
            key = ("trade_kind",)
        elif kind == "link_contact":
            trade["contact_emails"].add(proposed["email"])
            key = ("link_contact", proposed["email"])
        elif kind == "file":
            key = ("file", proposed["file_name"].lower())
        elif kind == "bid":
            key = ("bid", p["target"], proposed["amount"], proposed["unit"], proposed["currency"])
        else:
            continue
        latest[key] = p


def history(conn, args):
    """One-off pass over a trade's whole email and call history. Threads not yet placed on a trade
    (or placed on none, since the trades may have changed) are placed first; only this trade's
    threads are then read, oldest first, and what they say is applied."""
    lot_id = args.history
    key = gateway_key()
    if not key:
        raise SystemExit("no gateway key")
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("select pg_try_advisory_lock(hashtext('bulk_trade_history:' || %s)) as locked", (lot_id,))
        if not cur.fetchone()["locked"]:
            print("A history pass for this trade is already running; skipped.")
            return 0
        trades = load_trades(cur)  # every live trade, so a thread can be placed on the right one
        trades.update(load_trades(cur, [lot_id]))
        if lot_id not in trades:
            raise SystemExit(f"No trade {lot_id}")
    run_id = new_run(conn, args, "history", lot_id)

    report = new_report(run_id=run_id, lot_id=lot_id)
    ctx = {"mailbox": args.mailbox, "download": download_attachment, "new_contacts": set(), "warnings": report["warnings"]}
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            trade = trades[lot_id]
            cur.execute("select thread_key from crm_bulk_trade_threads where lot_id = %s", (lot_id,))
            placed_here = {row["thread_key"] for row in cur.fetchall()} | trade["threads"]
            if not trade["emails"] and not placed_here:
                report["warnings"].append("no contacts, linked buyers or linked threads: nothing to match")
            warning = refresh_granola()
            if warning:
                report["warnings"].append(warning)
            gmail_threads = {k.split(":", 1)[1] for k in placed_here if k.startswith("gmail:")}
            emails = load_trade_emails(cur, args.mailbox, trade["emails"], gmail_threads)
            notes = [n for n in load_granola(EPOCH) if n["participants"] & trade["emails"] or n["key"] in placed_here]
            report["emails_read"], report["notes_read"] = len(emails), len(notes)

            groups = by_thread(emails + notes)
            verdicts = load_verdicts(cur, groups)
            relevant, to_place = [], {}
            for thread, sources in groups.items():
                known = verdicts.get(thread)
                if thread in placed_here:
                    relevant += sources
                elif known and known["verdict"] == "trade":
                    continue  # another trade's thread
                else:
                    to_place[thread] = sources
            findings = []
            if to_place:
                placed = place_threads(to_place, trades, key, report)
                if not args.dry_run:
                    save_verdicts(cur, run_id, placed)
                for thread, v in placed.items():
                    report["threads"][v["verdict"]] = report["threads"].get(v["verdict"], 0) + 1
                    if v["verdict"] == "trade" and v["lot_id"] == lot_id:
                        relevant += to_place[thread]
                    elif v["verdict"] == "unclear":
                        findings.append(triage_card(to_place[thread], [lot_id]))
            report["threads"]["read"] = len({s["key"] for s in relevant})

            findings += extract(trade, sorted(relevant, key=lambda s: s["at"] or EPOCH), key, report)
            settle_all(cur, run_id, lot_id, findings, trade, ctx, report, args.dry_run)
            if not args.dry_run:
                finish_run(cur, run_id, report)
            conn.commit()
    except Exception as err:
        fail_run(conn, run_id, err)
        raise
    json.dump(report, sys.stdout, indent=2, ensure_ascii=False, default=str)
    print()
    return 0


def summary(conn):
    """The 08:00 list: buyers waiting on a reply, requests due within a week with no offer, overdue and due-today
    next steps, new auction offers, auctions closing soon, new demand matches, cards waiting, and buy-boxes to reconfirm."""
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
        cur.execute(
            """select l.title, count(*) as n, string_agg(p.quote, '; ' order by p.applied_at) as offers
               from crm_bulk_trade_proposals p join crm_bulk_trade_lots l on l.id = p.lot_id
               where p.source_kind = 'auction' and p.kind = 'bid' and p.status = 'applied' and p.applied_at > now() - interval '24 hours'
               group by l.title order by l.title""")
        offers = cur.fetchall()
        cur.execute(
            """select title, auction_closes_at from crm_bulk_trade_lots
               where auction_status = 'published' and auction_closes_at between now() and now() + interval '2 days'
               order by auction_closes_at""")
        closing = cur.fetchall()
        cur.execute(
            """select l.title, string_agg(d.buyer || case when d.kind = 'request' then ' (request)'
                                                          when d.basis = 'agreed' then ' (agreed)'
                                                          when d.basis = 'estimated' then ' (estimated)' else '' end,
                                          ', ' order by case c.buyer_tier when 'A' then 0 when 'B' then 1 when 'C' then 2 else 3 end,
                                                        case when d.kind = 'request' then 0 when d.basis = 'agreed' then 1
                                                             when d.basis = 'stated' then 2 else 3 end, d.buyer) as buyers
               from crm_bulk_trade_demand_matches m join crm_bulk_trade_demand d on d.id = m.demand_id
               join crm_bulk_trade_lots l on l.id = m.lot_id left join crm_companies c on c.id = d.company_id
               where m.strength = 'strong' and not m.hidden and m.buyer_id is null and d.status = 'open'
                 and (d.kind <> 'request' or d.needed_by is null or d.needed_by >= current_date)
                 and m.matched_at > now() - interval '24 hours' and l.trade_stage = any(%s)
               group by l.title order by l.title""", (list(LIVE_STAGES),))
        matches = cur.fetchall()
        cur.execute(
            """select w.full_name, w.email, c.name as company, c.buyer_tier as tier, w.waiting_since, w.last_in_subject
               from crm_bulk_trade_buyer_waiting w left join crm_companies c on c.id = w.company_id
               where w.waiting_since > now() - interval '%s days'
               order by case c.buyer_tier when 'A' then 0 when 'B' then 1 when 'C' then 2 else 3 end, w.waiting_since
               limit 10""" % WAITING_DAYS)
        waiting = cur.fetchall()
        cur.execute("select count(*) as n from crm_bulk_trade_buyer_waiting where waiting_since <= now() - interval '%s days'"
                    % WAITING_DAYS)
        older_waiting = cur.fetchone()["n"]
        cur.execute(
            """select d.buyer, d.wants, d.needed_by from crm_bulk_trade_demand d
               where d.status = 'open' and d.kind = 'request' and d.needed_by between %s and %s
                 and not exists (select 1 from crm_bulk_trade_buyers b where b.demand_id = d.id and b.status <> 'To contact')
               order by d.needed_by, d.buyer""", (today, today + dt.timedelta(days=7)))
        due = cur.fetchall()
        cur.execute(
            """select d.buyer, d.basis from crm_bulk_trade_demand d
               where d.status = 'open' and d.kind = 'standing' and d.basis in ('stated', 'agreed')
                 and (d.confirmed_on is null or d.confirmed_on < %s)
               order by d.basis = 'agreed' desc, d.confirmed_on nulls first, d.buyer""", (today - dt.timedelta(days=STALE_DAYS),))
        reconfirm = cur.fetchall()
    lines = [f"Bulk Trades, {today:%a %d %b}"]
    if waiting:
        lines.append("Buyers waiting on you:")
        for row in waiting:
            days = (today - row["waiting_since"].astimezone(ZoneInfo("Europe/London")).date()).days
            who = row["full_name"] or row["email"] or "Unknown"
            at = f" ({row['company']}{', tier ' + row['tier'] if row['tier'] else ''})" if row["company"] else ""
            subject = f": {row['last_in_subject']}" if row["last_in_subject"] else ""
            lines.append(f"- {who}{at}{subject} [{'today' if days < 1 else f'{days}d'}]")
    if older_waiting:
        lines.append(f"({older_waiting} older unanswered buyer email{'s' if older_waiting != 1 else ''}, over {WAITING_DAYS} days, not listed.)")
    for row in due:
        days = (row["needed_by"] - today).days
        lines.append(f"- Request from {row['buyer']}: {row['wants']}, needed {'today' if days == 0 else f'in {days}d'}, no offer yet")
    if waiting or due:
        lines.append("Trades:")
    for row in rows:
        days = (today - row["next_step_due"]).days
        when = "today" if days == 0 else f"{days}d late"
        extra = f" ({row['new']} new)" if row["new"] else ""
        lines.append(f"- {row['title']}: {row['next_step'] or 'set a next step'} [{when}]{extra}")
    if not rows:
        lines.append("Nothing overdue or due today.")
    for row in offers:
        lines.append(f"- {row['title']}: {row['n']} new auction offer{'s' if row['n'] != 1 else ''} ({row['offers']})")
    for row in closing:
        lines.append(f"- {row['title']}: auction closes {row['auction_closes_at'].astimezone(ZoneInfo('Europe/London')):%a %d %b %H:%M}")
    for row in matches:
        lines.append(f"- {row['title']}: matches open demand from {row['buyers']}")
    if possible:
        lines.append(f"{possible} possible new trade{'s' if possible != 1 else ''} to review.")
    if reconfirm:
        names = ", ".join(f"{r['buyer']}{' (agreed)' if r['basis'] == 'agreed' else ''}" for r in reconfirm[:8])
        more = f" and {len(reconfirm) - 8} more" if len(reconfirm) > 8 else ""
        lines.append(f"Buy-boxes to reconfirm: {names}{more}.")
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
    parser.add_argument("--history", metavar="LOT_ID", help="one-off pass over this trade's whole history")
    parser.add_argument("--match", action="store_true", help="match open demand to live trades that changed")
    args = parser.parse_args()
    if args.only_at and not due_now([t.strip() for t in args.only_at.split(",") if t.strip()]):
        return 0
    conn = psycopg2.connect(args.dsn)
    try:
        if args.history:
            return history(conn, args)
        if args.match:
            report = match_demand(conn, gateway_key(), dry_run=args.dry_run)
            json.dump(report, sys.stdout, indent=2, ensure_ascii=False, default=str)
            print()
            return 0
        return summary(conn) if args.summary else run(conn, args)
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
