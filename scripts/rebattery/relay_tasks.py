#!/usr/bin/env python3
"""Relay tasks: Relay's view of the owner's open Work Tasks for the To-dos tab (relay_task_meta).

  relay_tasks.py                      # dry run: classify changed tasks and print a summary JSON, write nothing
  relay_tasks.py --apply              # classify and upsert relay_task_meta
  relay_tasks.py --no-llm             # skip the model; fallback content from the Work Task itself
  relay_tasks.py --limit N            # classify at most N tasks this run (the rest wait for the next run)
  relay_tasks.py --dsn ... --schema s # run against another database/schema (tests)

Open tasks are work_tasks assigned to --owner-email with status Planned or In Progress. A task is classified
when it has no relay_task_meta row or its source_hash (title + status + task_details) changed. Tasks Alex
added in Relay (relay_todo kind 'manual') become category 'mine' without the model.

The model (one call per 8 tasks, same Hermes command as relay_scan.py) writes the category, a short title,
the next step, urgency, a yes/no question for 'decide' tasks and a drafting note. It only returns hints for
links (counterpart, subject words, listing words). Links are resolved here, in code, and never guessed:
  mail  the Gmail thread named in the task, else the owner's open/review relay_item for the counterpart,
        else exactly one owner mail_thread whose subject matches the task's source subject
  deal  exactly one crm_bulk_listings row for the counterpart's email or party, or one listing whose summary
        carries the task's listing words (model numbers)
  shop  marketplace: ids stay null; link_url only when the task carries a rebattery.io URL
action_kind 'draft' needs a resolved thread (Relay replies on it); otherwise 'open' when something can be
opened, else 'none'. snooze_until is never written. A failed model call leaves an existing classification
alone (a new task gets fallback content with no source_hash, so it is retried next run).
"""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import psycopg2
import psycopg2.extras

DEFAULT_DSN = "host=/var/run/postgresql dbname=denchclaw"
LLM_BATCH = 8
OWN_DOMAIN = "rebattery.io"
OPEN_STATUSES = ("Planned", "In Progress")
CATEGORIES = ("market", "trade", "ops", "decide", "mine", "other")
ACTION_KINDS = ("draft", "open", "none")
LINK_KINDS = ("mail", "deal", "shop", "chat")
FREEMAIL = {"gmail.com", "googlemail.com", "hotmail.com", "outlook.com", "live.com", "yahoo.com", "icloud.com",
            "me.com", "aol.com", "gmx.de", "gmx.net", "web.de", "proton.me", "protonmail.com", "ukr.net"}

META_FIELDS = ("category", "title", "next_step", "urgent_reason", "due_at", "question", "yes_label", "no_label",
               "action_label", "action_kind", "action_note", "link_kind", "link_label", "relay_item_id",
               "mail_thread_id", "bulk_listing_id", "link_url", "source_hash", "classified_at")

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
GMAIL_ID_RE = re.compile(r"(?:mail\.google\.com/mail/[^\s#]*#[a-z]+/|Gmail thread\s+)([0-9a-f]{12,20})\b", re.I)
SOURCE_RE = re.compile(r"^\s*Source:\s*(.+)$", re.I | re.M)
SUBJECT_RE = re.compile(r"subject\s+[\"'“‘](.+?)[\"'”’](?:\s*[,.;]|\s*$)", re.I | re.M)
WHAT_RE = re.compile(r"^\s*What to do:\s*(.+)$", re.I | re.M)
REB_URL_RE = re.compile(r"https?://(?:[a-z0-9-]+\.)*rebattery\.io[^\s\"'<>)\]]*", re.I)
SUBJECT_PREFIX = re.compile(r"^\s*((re|fwd?|aw|sv|wg|tr)\s*:\s*)+", re.I)
WORD = re.compile(r"[a-z0-9][a-z0-9.-]{2,}")
STOP = {"the", "and", "for", "with", "from", "packs", "pack", "battery", "batteries", "kwh", "your", "you", "this",
        "that", "are", "have", "listing", "cells", "cell", "module", "modules", "offer", "buyer", "supplier"}


# ---------- small helpers ----------

def now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def source_hash(task: dict) -> str:
    raw = "\x1f".join([task.get("title") or "", task.get("status") or "", task.get("task_details") or ""])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def domain_of(email: str | None) -> str:
    email = (email or "").strip().lower()
    return email.rsplit("@", 1)[1] if "@" in email else ""


def is_own(email: str | None) -> bool:
    d = domain_of(email)
    return d == OWN_DOMAIN or d.endswith("." + OWN_DOMAIN)


def clean(text, limit: int) -> str | None:
    """Model text made safe for the UI: no em or en dashes, single spaces, trimmed to limit."""
    if text is None:
        return None
    text = str(text).replace("—", ", ").replace(" – ", ", ").replace("–", "-")
    text = re.sub(r"\s+,", ",", re.sub(r",\s*,", ",", text))
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > limit:
        text = text[:limit].rsplit(" ", 1)[0].rstrip(",;:") + "..."
    return text or None


def core_subject(subject: str | None) -> str:
    return SUBJECT_PREFIX.sub("", (subject or "").strip()).strip()


def parse_details(details: str | None) -> dict:
    """Facts the Work Task carries in plain text: source sender, subject, Gmail thread id, URLs, next step."""
    details = details or ""
    out: dict = {"gmail_thread_id": None, "source_email": None, "source_name": None, "subject": None,
                 "what": None, "urls": [], "emails": []}
    m = GMAIL_ID_RE.search(details)
    if m:
        out["gmail_thread_id"] = m.group(1).lower()
    src = SOURCE_RE.search(details)
    src_line = src.group(1) if src else ""
    if src_line:
        sm = re.search(r"from\s+(.+?)\s*<([^>]+@[^>]+)>", src_line, re.I)
        if sm:
            out["source_name"], out["source_email"] = sm.group(1).strip(" \"'"), sm.group(2).strip().lower()
        else:
            em = EMAIL_RE.search(src_line)
            out["source_email"] = em.group(0).lower() if em else None
    for text in ([src_line] if src_line else []) + [details]:
        sub = SUBJECT_RE.search(text)
        if sub:
            out["subject"] = sub.group(1).strip()
            break
    what = WHAT_RE.search(details)
    if what:
        out["what"] = what.group(1).strip()
    out["urls"] = [u.rstrip(".,;") for u in REB_URL_RE.findall(details)]
    out["emails"] = sorted({e.lower() for e in EMAIL_RE.findall(details)})
    return out


def first_sentence(text: str | None) -> str:
    text = re.sub(r"\s+", " ", text or "").strip()
    text = re.sub(r"^(Objective|What to do)\s*:\s*", "", text, flags=re.I)
    m = re.match(r"(.+?[.!?])(\s|$)", text)
    return (m.group(1) if m else text)[:240]


# ---------- data loading ----------

def table_exists(cur, name: str) -> bool:
    cur.execute("select to_regclass(%s) is not null as ok", (name,))
    return bool(cur.fetchone()["ok"])


def load_owner(cur, owner_email: str) -> str:
    cur.execute("select id from crm_users where lower(email) = lower(%s)", (owner_email,))
    row = cur.fetchone()
    if not row:
        raise SystemExit(f"no crm_users row for {owner_email}")
    return str(row["id"])


def load_tasks(cur, owner_email: str) -> list[dict]:
    manual = "false"
    if table_exists(cur, "relay_todo"):
        manual = "exists (select 1 from relay_todo t where t.work_task_id = w.id and t.kind = 'manual')"
    cur.execute(
        f"""select w.id, w.reb_key, w.title, w.status, w.priority, w.task_details, w.created_at, w.updated_at,
                   {manual} as manual
              from work_tasks w
             where lower(w.assignee_email) = lower(%s) and w.status = any(%s)
             order by w.created_at""",
        (owner_email, list(OPEN_STATUSES)))
    return [dict(r) for r in cur.fetchall()]


def load_meta(cur) -> dict[str, dict]:
    if not table_exists(cur, "relay_task_meta"):
        return {}
    cur.execute("select * from relay_task_meta")
    return {r["work_task_id"]: dict(r) for r in cur.fetchall()}


# ---------- link resolution (code, never the model) ----------

def _one(rows: list[dict], key: str = "id") -> dict | None:
    ids = {r[key] for r in rows}
    return rows[0] if len(ids) == 1 else None


def find_thread_by_gmail_id(cur, owner_id: str, gmail_id: str) -> tuple[dict | None, dict | None]:
    """(relay_item, mail_thread) for the owner's copy of one Gmail thread."""
    item = thread = None
    cur.execute("select id, mail_thread_id, status from relay_item where owner_id = %s and gmail_thread_id = %s",
                (owner_id, gmail_id))
    rows = [dict(r) for r in cur.fetchall()]
    item = rows[0] if rows else None
    cur.execute("""select id, subject, gmail_thread_id from mail_thread
                    where mailbox_owner_id = %s and gmail_thread_id = %s
                    order by message_count desc, last_message_at desc nulls last limit 1""", (owner_id, gmail_id))
    r = cur.fetchone()
    thread = dict(r) if r else None
    return item, thread


def find_item_by_email(cur, owner_id: str, emails: list[str], subject: str | None) -> dict | None:
    """The owner's relay_item for a counterpart: open/review first; several left -> narrow by subject, else none."""
    emails = [e.lower() for e in emails if e and not is_own(e)]
    if not emails:
        return None
    cur.execute(
        """select i.id, i.mail_thread_id, i.status, i.gmail_thread_id, coalesce(t.subject, '') as subject
             from relay_item i left join mail_thread t on t.id = i.mail_thread_id
            where i.owner_id = %s and lower(i.counterpart_email) = any(%s)""", (owner_id, emails))
    rows = [dict(r) for r in cur.fetchall()]
    preferred = [r for r in rows if r["status"] in ("open", "review")]
    for pool in (preferred, rows):
        if not pool:
            continue
        if len(pool) == 1:
            return pool[0]
        core = core_subject(subject).lower()
        if core:
            narrowed = [r for r in pool if core in core_subject(r["subject"]).lower()]
            if len(narrowed) == 1:
                return narrowed[0]
        return None  # ambiguous: never guess
    return None


def find_thread_by_subject(cur, owner_id: str, subject: str | None) -> dict | None:
    core = core_subject(subject)
    if len(core) < 8:
        return None
    pattern = "%" + core.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    cur.execute("""select id, subject, gmail_thread_id, message_count from mail_thread
                    where mailbox_owner_id = %s and subject ilike %s
                    order by message_count desc, last_message_at desc nulls last""", (owner_id, pattern))
    rows = [dict(r) for r in cur.fetchall()]
    return _one(rows, "gmail_thread_id")


def listing_tokens(words) -> set[str]:
    text = " ".join(words) if isinstance(words, (list, tuple)) else str(words or "")
    return set(WORD.findall(text.lower())) - STOP


def strong(token: str) -> bool:
    """A model number or similar: letters and digits together, at least 5 characters."""
    return len(token) >= 5 and bool(re.search(r"\d", token)) and bool(re.search(r"[a-z]", token))


def find_deal(cur, emails: list[str], names: list[str], words) -> dict | None:
    if not table_exists(cur, "crm_bulk_listings"):
        return None
    tokens = listing_tokens(words)

    def narrow(rows: list[dict]) -> dict | None:
        if len(rows) <= 1:
            return rows[0] if rows else None
        live = [r for r in rows if r["status"] in ("open", "qualifying")]
        if len(live) == 1:
            return live[0]
        pool = live or rows
        if tokens:
            scored = [(len(tokens & listing_tokens(r["summary"])), r) for r in pool]
            top = max(s for s, _ in scored)
            best = [r for s, r in scored if s == top]
            if top >= 1 and len(best) == 1:
                return best[0]
        return None

    emails = [e.lower() for e in emails if e and not is_own(e)]
    if emails:
        cur.execute("""select b.id, b.kind, b.party, b.summary, b.status from crm_bulk_listings b
                        left join crm_people p on p.id = b.person_id
                        where lower(coalesce(b.email, p.email, '')) = any(%s)""", (emails,))
        rows = [dict(r) for r in cur.fetchall()]
        if rows:
            return narrow(rows)
    for name in [n for n in names if n and len(n.strip()) >= 4]:
        cur.execute("select id, kind, party, summary, status from crm_bulk_listings where party ilike %s",
                    ("%" + name.strip().replace("%", "") + "%",))
        rows = [dict(r) for r in cur.fetchall()]
        if rows:
            return narrow(rows)
    strong_tokens = [t for t in tokens if strong(t)]
    if strong_tokens:
        cur.execute("""select id, kind, party, summary, status from crm_bulk_listings
                        where status in ('open', 'qualifying') and summary ilike all(%s)""",
                    (["%" + t + "%" for t in strong_tokens],))
        rows = [dict(r) for r in cur.fetchall()]
        if len(rows) == 1:
            return rows[0]
    return None


def resolve_links(cur, owner_id: str, task: dict, facts: dict, hints: dict) -> dict:
    """relay_item_id / mail_thread_id / bulk_listing_id / link_url from the task text and the model's hints."""
    out = {"relay_item_id": None, "mail_thread_id": None, "bulk_listing_id": None, "link_url": None}
    link_kind = hints.get("link_kind")
    if facts.get("urls"):
        out["link_url"] = facts["urls"][0]
    if link_kind == "shop":
        return out  # marketplace conversations: no CRM ids to point at
    subject = facts.get("subject") or hints.get("subject")
    emails = [e for e in [facts.get("source_email"), hints.get("counterpart_email")] if e and not is_own(e)]
    if not emails:
        emails = [e for e in facts.get("emails", []) if not is_own(e)][:3]
    # mail
    item = thread = None
    if facts.get("gmail_thread_id"):
        item, thread = find_thread_by_gmail_id(cur, owner_id, facts["gmail_thread_id"])
    if not item and not thread:
        item = find_item_by_email(cur, owner_id, emails, subject)
    if not item and not thread:
        thread = find_thread_by_subject(cur, owner_id, subject)
        if thread and thread.get("gmail_thread_id"):
            item, _ = find_thread_by_gmail_id(cur, owner_id, thread["gmail_thread_id"])
    if item:
        out["relay_item_id"] = item["id"]
        out["mail_thread_id"] = (thread or {}).get("id") or item.get("mail_thread_id")
    elif thread:
        out["mail_thread_id"] = thread["id"]
    # deal
    names = [n for n in [hints.get("counterpart_name"), facts.get("source_name"), hints.get("company")] if n]
    deal = find_deal(cur, emails, names, hints.get("listing_words") or [])
    if deal:
        out["bulk_listing_id"] = deal["id"]
    return out


# ---------- model ----------

INSTRUCTIONS = """You sort Alex Polglase's open work tasks for the To-dos tab of Relay, his email workbench at ReBattery
(a marketplace for used EV batteries, cells and storage systems). Today is {today}.
Reply with ONLY a JSON array, no prose, one object per task, in any order:
{{"key": "<the task key>",
 "category": "market|trade|ops|decide|other",
 "title": "<at most 8 plain words: what the task is, e.g. 'Send Simlionics the second-life slides'>",
 "next_step": "<one or two short sentences: exactly what Alex does next>",
 "urgent_reason": "<short chip such as 'Call due 30 Oct', 'Before next week', 'Offer expires 23 Oct', or null>",
 "due_at": "<YYYY-MM-DD when a date is stated or clearly implied, else null>",
 "question": "<decide only: a yes/no question for Alex, else null>",
 "yes_label": "<decide only, at most 3 words, e.g. 'Yes, mark done' or 'Retire'>",
 "no_label": "<decide only, at most 3 words, e.g. 'Not yet' or 'Keep'>",
 "action": "draft|open|none",
 "action_label": "<at most 3 words for the button, e.g. 'Draft reply', 'Open chat', 'Open thread'>",
 "action_note": "<draft only: the note Relay drafts the email from, else ''>",
 "link_kind": "mail|deal|shop|chat|null",
 "link_label": "<at most 5 words naming the linked thing, e.g. 'Shaun Dunn, Silverlake' or 'Kokam KCL255103EN1'>",
 "counterpart_email": "<the external person's email if the task names one, else null>",
 "counterpart_name": "<their name or company, else null>",
 "company": "<their company, else null>",
 "subject": "<the email subject the task came from, else null>",
 "listing_words": ["<model numbers or product words of the listing involved>"]}}
Categories:
- market: replying to a marketplace offer or marketplace chat (support@rebattery.io notifications about messages or offers on a listing). link_kind "shop", action "open" (the reply happens in the marketplace, never by email).
- trade: replying to or chasing a buyer, supplier or partner by email or WhatsApp, sending them slides, lists or samples. Usually link_kind "mail", action "draft".
- ops: recycler quotes, invoices, checklists and forms, collections, listing fixes, sign-in or account problems.
- decide: the task is really a yes/no for Alex, e.g. it may already be done ("Was the listing date changed?" -> "Yes, mark done" / "Not yet"), or it is stale (an offer that already expired, a months-old ticket: "Retire this?" -> "Retire" / "Keep").
- other: anything else.
Rules:
- urgent_reason only when genuinely time-critical (a stated deadline or meeting within about a week, an expiry still ahead, someone waiting on a draft). Otherwise null. Never mark something urgent just because it is important. A deadline or expiry that has already passed is not urgent: the task is then usually a decide ("Retire this?").
- next_step speaks to Alex in the imperative ("Call David...", "Check whether..."). Do not say Relay or anyone else has prepared something.
- action "draft" means Relay drafts an email reply on the task's thread from action_note. Write action_note as Alex's instruction to his drafter, e.g. "Send the second-life slides and OEM case studies, and propose a call around 30 Oct, UK morning". When the reply needs a stock list or stock export, say "attach a stock list" (and its scope) in the note. Never put prices, figures or facts in the note that the task does not give; say what Alex must fill in instead.
- When the reply must carry ReBattery stock (a stock list, stock export or sample stock records), the note must contain the words "attach a stock list".
- action "open" means Alex opens the linked thing (marketplace chat, listing, thread). action "none" when nothing needs opening.
- British English. No em dashes or en dashes. Plain words, no filler. Never invent facts that are not in the task.

## Tasks
"""


def task_record(task: dict, facts: dict) -> dict:
    return {"key": task["reb_key"], "title": task["title"], "status": task["status"], "priority": task.get("priority"),
            "created": task["created_at"].strftime("%d %b %Y") if task.get("created_at") else None,
            "source_subject": facts.get("subject"), "source_from": facts.get("source_email"),
            "details": (task.get("task_details") or "")[:3500]}


def build_prompt(records: list[dict], today: dt.date) -> str:
    return INSTRUCTIONS.format(today=today.strftime("%A %d %B %Y")) + json.dumps(records, ensure_ascii=False, default=str)


def run_hermes(prompt: str) -> str:
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as handle:
        handle.write(prompt)
        path = handle.name
    try:
        result = subprocess.run(
            ["hermes", "-p", "default", "chat", "-Q", "--oneshot", "--ignore-rules", "-t", "none", "--reasoning", "medium",
             "--source", "relay-tasks", "--query-file", path],
            text=True, capture_output=True, timeout=600, check=False)
    finally:
        Path(path).unlink(missing_ok=True)
    if result.returncode:
        raise RuntimeError(f"model call failed: {(result.stderr or result.stdout).strip()[-300:]}")
    return result.stdout


def _json_array(text: str):
    """The last JSON array in the reply that holds objects (the model may print notes or code fences)."""
    decoder = json.JSONDecoder()
    found = None
    for m in re.finditer(r"\[", text):
        try:
            value, _ = decoder.raw_decode(text[m.start():])
        except ValueError:
            continue
        if isinstance(value, list) and any(isinstance(v, dict) for v in value):
            found = value
            break
    if found is None:
        raise ValueError("model reply contains no JSON array")
    return found


def _date(value) -> dt.date | None:
    if not value:
        return None
    try:
        return dt.date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def parse_classifications(text: str) -> dict[str, dict]:
    out = {}
    for item in _json_array(text):
        if not isinstance(item, dict) or not item.get("key"):
            continue
        category = item.get("category") if item.get("category") in CATEGORIES and item.get("category") != "mine" else "other"
        action = item.get("action") if item.get("action") in ACTION_KINDS else "open"
        words = item.get("listing_words") or []
        if isinstance(words, str):
            words = [words]
        email = str(item.get("counterpart_email") or "").strip().lower()
        out[str(item["key"])] = {
            "category": category,
            "title": clean(item.get("title"), 90),
            "next_step": clean(item.get("next_step"), 400),
            "urgent_reason": clean(item.get("urgent_reason"), 40) if str(item.get("urgent_reason") or "").lower() not in ("", "null", "none") else None,
            "due_at": _date(item.get("due_at")),
            "question": clean(item.get("question"), 200),
            "yes_label": clean(item.get("yes_label"), 24),
            "no_label": clean(item.get("no_label"), 24),
            "action": action,
            "action_label": clean(item.get("action_label"), 30),
            "action_note": clean(item.get("action_note"), 1000) or "",
            "link_kind": item.get("link_kind") if item.get("link_kind") in LINK_KINDS else None,
            "link_label": clean(item.get("link_label"), 60),
            "counterpart_email": email if EMAIL_RE.fullmatch(email) else None,
            "counterpart_name": clean(item.get("counterpart_name"), 80),
            "company": clean(item.get("company"), 80),
            "subject": clean(item.get("subject"), 200),
            "listing_words": [str(w)[:40] for w in words if w][:8],
        }
    return out


def classify(batches: list[list[dict]], today: dt.date, model=None) -> tuple[dict[str, dict], int, list[str]]:
    """One model call per batch. Returns ({key: classification}, calls, errors); failed batches are absent."""
    model = model or run_hermes
    found, calls, errors = {}, 0, []
    for batch in batches:
        calls += 1
        try:
            found.update(parse_classifications(model(build_prompt(batch, today))))
        except Exception as exc:
            errors.append(f"llm batch of {len(batch)}: {str(exc)[:200]}")
    return found, calls, errors


# ---------- building rows ----------

OPEN_LABELS = {"shop": "Open chat", "mail": "Open thread", "deal": "Open deal", "chat": "Open chat"}


def fallback(task: dict, facts: dict) -> dict:
    return {"category": "other", "title": clean(task["title"], 90) or task["reb_key"],
            "next_step": clean(facts.get("what") or first_sentence(task.get("task_details")) or task["title"], 400) or "",
            "urgent_reason": None, "due_at": None, "question": None, "yes_label": None, "no_label": None,
            "action": "open", "action_label": None, "action_note": "", "link_kind": None, "link_label": None,
            "counterpart_email": None, "counterpart_name": facts.get("source_name"), "company": None,
            "subject": facts.get("subject"), "listing_words": []}


STOCK_LIST = re.compile(r"\b(stock (list|export|records?|sample)|sample stock|inventory list|supply list)\b", re.I)


def needs_stock_list(task: dict) -> bool:
    """The reply must carry ReBattery stock, so Relay's agent job should build a stock list."""
    return bool(STOCK_LIST.search(f"{task.get('title') or ''}\n{task.get('task_details') or ''}"))


def finish_row(task: dict, cls: dict, links: dict, facts: dict, digest: str | None, now: dt.datetime) -> dict:
    """Combine the classification with the resolved links into one relay_task_meta row."""
    category = cls["category"]
    question, yes_label, no_label = cls.get("question"), cls.get("yes_label"), cls.get("no_label")
    if category == "decide" and not question:
        category = "other"
    if category != "decide":
        question = yes_label = no_label = None
    else:
        yes_label = yes_label or "Yes"
        no_label = no_label or "Not yet"

    has_thread = bool(links.get("relay_item_id") or links.get("mail_thread_id"))
    resolved_kind = {"mail": has_thread, "deal": bool(links.get("bulk_listing_id")),
                     "shop": bool(links.get("link_url")), "chat": False}
    link_kind = cls.get("link_kind")
    if category == "market" and not link_kind:
        link_kind = "shop"
    if not link_kind or not resolved_kind.get(link_kind):
        for kind in ("mail", "deal"):
            if resolved_kind[kind] and link_kind != "shop":
                link_kind = kind
                break
    if link_kind == "shop":
        links = {**links, "relay_item_id": None, "mail_thread_id": None, "bulk_listing_id": None}
        has_thread = False
    link_label = cls.get("link_label")
    if not link_label and link_kind == "mail":
        link_label = clean(cls.get("counterpart_name") or facts.get("source_name") or cls.get("subject"), 60)

    openable = has_thread or bool(links.get("bulk_listing_id") or links.get("link_url"))
    action = cls.get("action") or "open"
    if action == "draft" and not has_thread:
        action = "open"
    if action == "none" and openable:
        action = "open"
    if action == "open" and not openable:
        action = "none"
    if action == "draft":
        action_label = cls.get("action_label") or "Draft reply"
        note = cls.get("action_note") or cls.get("next_step") or ""
        if needs_stock_list(task) and "stock list" not in note.lower():
            note = (note.rstrip(". ") + ". Attach a stock list.").lstrip(". ")
    elif action == "open":
        action_label = cls.get("action_label") if cls.get("action") == "open" and cls.get("action_label") else OPEN_LABELS.get(link_kind or "mail", "Open")
        note = ""
    else:
        action_label, note = None, ""
    if action == "open" and re.match(r"^\s*draft", action_label or "", re.I):
        action_label = OPEN_LABELS.get(link_kind or "mail", "Open")

    return {
        "work_task_id": task["id"], "category": category,
        "title": cls.get("title") or clean(task["title"], 90) or task["reb_key"],
        "next_step": cls.get("next_step") or "",
        "urgent_reason": cls.get("urgent_reason"), "due_at": cls.get("due_at"),
        "question": question, "yes_label": yes_label, "no_label": no_label,
        "action_label": action_label, "action_kind": action, "action_note": note,
        "link_kind": link_kind, "link_label": link_label,
        "relay_item_id": links.get("relay_item_id"), "mail_thread_id": links.get("mail_thread_id"),
        "bulk_listing_id": links.get("bulk_listing_id"), "link_url": links.get("link_url"),
        "source_hash": digest, "classified_at": now,
    }


def manual_row(task: dict, existing: dict | None, digest: str, now: dt.datetime) -> dict:
    facts = parse_details(task.get("task_details"))
    next_step = (existing or {}).get("next_step") or clean(facts.get("what") or first_sentence(task.get("task_details")), 400) or ""
    if next_step.strip().rstrip(".").lower() == (task["title"] or "").strip().rstrip(".").lower():
        next_step = ""
    return {"work_task_id": task["id"], "category": "mine", "title": clean(task["title"], 160) or task["reb_key"],
            "next_step": next_step, "urgent_reason": None, "due_at": (existing or {}).get("due_at"),
            "question": None, "yes_label": None, "no_label": None, "action_label": None, "action_kind": "none",
            "action_note": "", "link_kind": None, "link_label": None, "relay_item_id": None, "mail_thread_id": None,
            "bulk_listing_id": None, "link_url": None, "source_hash": digest, "classified_at": now}


def needs_classifying(task: dict, existing: dict | None, digest: str) -> bool:
    return not existing or existing.get("source_hash") != digest


def upsert(conn, rows: list[dict]) -> None:
    """Insert or update relay_task_meta. snooze_until is never written, so Alex's snoozes survive."""
    cols = ["work_task_id", *META_FIELDS]
    updates = ", ".join(f"{c} = excluded.{c}" for c in META_FIELDS) + ", updated_at = now()"
    with conn.cursor() as cur:
        for row in rows:
            cur.execute(
                f"""insert into relay_task_meta ({', '.join(cols)}) values ({', '.join(['%s'] * len(cols))})
                    on conflict (work_task_id) do update set {updates}""",
                [row.get(c) for c in cols])
    conn.commit()


# ---------- run ----------

def plan(cur, owner_id: str, tasks: list[dict], meta: dict[str, dict], args, now: dt.datetime, model=None) -> dict:
    """Decide which tasks to classify, call the model, resolve links. Returns rows to write and run stats."""
    rows: list[dict] = []
    jobs: list[dict] = []
    skipped = 0
    for task in tasks:
        digest = source_hash(task)
        existing = meta.get(task["id"])
        if not needs_classifying(task, existing, digest):
            skipped += 1
            continue
        if task.get("manual"):
            rows.append(manual_row(task, existing, digest, now))
            continue
        jobs.append({"task": task, "digest": digest, "existing": existing, "facts": parse_details(task.get("task_details"))})
    deferred = 0
    if args.limit is not None and len(jobs) > args.limit:
        deferred = len(jobs) - args.limit
        jobs = jobs[: max(0, args.limit)]

    found, calls, errors = {}, 0, []
    if jobs and not args.no_llm:
        records = [task_record(j["task"], j["facts"]) for j in jobs]
        batches = [records[i:i + LLM_BATCH] for i in range(0, len(records), LLM_BATCH)]
        found, calls, errors = classify(batches, now.date(), model=model)

    fallbacks = 0
    for job in jobs:
        task, facts = job["task"], job["facts"]
        cls = found.get(task["reb_key"])
        digest = job["digest"]
        if cls is None:
            if not args.no_llm:
                fallbacks += 1
                if job["existing"] and job["existing"].get("classified_at"):
                    continue  # keep the earlier classification; retried next run
                digest = None  # fallback content only; retried next run
            cls = fallback(task, facts)
        links = resolve_links(cur, owner_id, task, facts, cls)
        row = finish_row(task, cls, links, facts, digest, now)
        row["_key"] = task["reb_key"]
        rows.append(row)
    for r in rows:
        r.setdefault("_key", next((t["reb_key"] for t in tasks if t["id"] == r["work_task_id"]), r["work_task_id"]))
    return {"rows": rows, "skipped": skipped, "deferred": deferred, "llm_calls": calls, "fallbacks": fallbacks, "errors": errors}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--apply", action="store_true", help="write relay_task_meta (default: dry run)")
    parser.add_argument("--owner-email", default="alex@rebattery.io")
    parser.add_argument("--no-llm", action="store_true", help="skip the model; fallback content from the Work Task")
    parser.add_argument("--limit", type=int, default=None, help="classify at most N tasks this run")
    parser.add_argument("--dsn", default=os.environ.get("RELAY_DSN", DEFAULT_DSN))
    parser.add_argument("--schema", help="search_path schema (tests)")
    parser.add_argument("--examples", type=int, default=5, help="include N classified tasks in the summary")
    args = parser.parse_args(argv)

    lock_handle = open(f"/tmp/relay-tasks-{re.sub(r'[^a-z0-9]', '_', args.owner_email.lower())}.lock", "w")
    try:
        fcntl.flock(lock_handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print(json.dumps({"skipped": "another relay tasks run is going"}))
        return 0

    now = now_utc()
    conn = psycopg2.connect(args.dsn)
    conn.set_session(readonly=not args.apply)
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        if args.schema:
            cur.execute("select set_config('search_path', %s, false)", (f"{args.schema}, public",))
        owner_id = load_owner(cur, args.owner_email)
        tasks = load_tasks(cur, args.owner_email)
        meta = load_meta(cur)
        result = plan(cur, owner_id, tasks, meta, args, now)
        rows = result["rows"]
        table = table_exists(cur, "relay_task_meta")
        if args.apply and rows:
            if not table:
                raise SystemExit("relay_task_meta does not exist: apply migration 092_relay_task_meta.sql first")
            upsert(conn, [{k: v for k, v in r.items() if not k.startswith("_")} for r in rows])

        # Category counts over every open task: this run's rows, else the stored classification.
        by_task = {r["work_task_id"]: r for r in rows}
        categories: dict[str, int] = {}
        urgent = []
        for t in tasks:
            r = by_task.get(t["id"]) or meta.get(t["id"]) or {}
            cat = "mine" if t.get("manual") else (r.get("category") or "unclassified")
            categories[cat] = categories.get(cat, 0) + 1
            if r.get("urgent_reason"):
                urgent.append({"key": t["reb_key"], "urgent_reason": r["urgent_reason"],
                               "due_at": r["due_at"].isoformat() if r.get("due_at") else None})
        summary = {
            "mode": "apply" if args.apply else "dry-run", "owner": args.owner_email,
            "open_tasks": len(tasks), "classified": len(rows), "unchanged": result["skipped"],
            "deferred": result["deferred"], "manual": sum(1 for r in rows if r["category"] == "mine"),
            "llm_calls": result["llm_calls"], "fallbacks": result["fallbacks"],
            "categories": dict(sorted(categories.items(), key=lambda kv: -kv[1])),
            "urgent": urgent, "meta_table": table, "errors": result["errors"],
        }
        if args.examples:
            summary["examples"] = [
                {"key": r["_key"], "category": r["category"], "title": r["title"], "next_step": r["next_step"],
                 "urgent_reason": r["urgent_reason"], "due_at": r["due_at"].isoformat() if r.get("due_at") else None,
                 "question": r["question"], "yes_label": r["yes_label"], "no_label": r["no_label"],
                 "action": r["action_kind"], "action_label": r["action_label"], "action_note": r["action_note"],
                 "link_kind": r["link_kind"], "link_label": r["link_label"],
                 "relay_item_id": r["relay_item_id"], "mail_thread_id": r["mail_thread_id"],
                 "bulk_listing_id": r["bulk_listing_id"], "link_url": r["link_url"], "hashed": bool(r["source_hash"])}
                for r in rows[: args.examples]]
        print(json.dumps(summary, ensure_ascii=False, default=str))
    finally:
        if not args.apply:
            conn.rollback()
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
