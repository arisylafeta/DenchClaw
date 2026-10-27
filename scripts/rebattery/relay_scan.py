#!/usr/bin/env python3
"""Relay scan: sort the owner's recent Gmail threads into the Relay workbench (relay_item).

  relay_scan.py                      # dry run: classify and print a summary JSON, write nothing
  relay_scan.py --apply              # classify, summarise new/changed threads, upsert relay_item
  relay_scan.py --no-llm             # skip the model; headline/context fall back to subject + opening lines
  relay_scan.py --sync --apply       # refresh the owner's Gmail into mail_message first (rebattery-mail)
  relay_scan.py --dsn ... --schema s # run against another database/schema (tests)

Tabs:
  action  the last real message is inbound from an external person and needs a reply. Gmail triage's
          "1 Action" is the strongest signal. Skipped when the owner has written to that person since,
          in any thread (the same rule as the email sprint's "waiting on Alex").
  follow  the owner wrote last, asked something, and no reply came after N working days: 4 when the
          thread is linked to a deal (confirmed/proposed link) or the counterpart is on an open deal, else 7. Stops after two
          unanswered nudges in a row (then tab other). Never older than --follow-days.
  other   recent mail that needs no reply: triage "5 Read"/"4 Sorted"/"2 Waiting", FYI, receipts,
          real-company notifications, cold pitches, "thanks" endings, or chases that ran out.

Priority: overdue (an "I'll ... by <day>" promise in the owner's last sent message is past due),
urgent (deadline words or a decision due within 24 hours), high (buyer, deal-linked, or a supplier
waiting over 48 hours), medium (other live business), low (other tab).

New threads, and threads whose newest message changed (relay_item.last_seen_message_id), get a
headline, context and earlier-message summaries from one batched model call per 8 threads, through
the same Hermes command Gmail triage uses. A failed call falls back to subject + opening lines and the
thread is retried next run.

User state is respected: note is never written; review/done items are reopened only when a new
message arrived after they were closed; snoozed items only get their content refreshed. Open items
whose thread no longer needs anything become done (done_reason 'replied' or 'expired').
"""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import json
import os
import re
import subprocess
import sys
import tempfile
from email.utils import parseaddr
from pathlib import Path
from typing import Any

import psycopg2
import psycopg2.extras

DEFAULT_DSN = "host=/var/run/postgresql dbname=denchclaw"
TRIAGE_DIR = Path("/root/.hermes/workspace/gmail-unified-triage")
TRIAGE_APP_SRC = Path("/root/.hermes/apps/gmail-email-management/src")
SYNC_SCRIPT = Path("/root/denchclaw/scripts-live/scripts/rebattery/rebattery-mail.py")
KEYRING_FILE = Path("/root/.hermes/workspace/.secrets/gog-keyring-password")
LLM_BATCH = 8
LLM_THREAD_LIMIT = 48  # threads summarised per run; the rest keep fallback content and are retried next run

OWN_DOMAIN = "rebattery.io"
KEEP_STATES = {"received", "accepted"}
SKIP_LABELS = {"SPAM", "TRASH", "DRAFT", "CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL"}
FYI_LABELS = {"CATEGORY_UPDATES", "CATEGORY_FORUMS"}
FREEMAIL = {"gmail.com", "googlemail.com", "hotmail.com", "outlook.com", "live.com", "yahoo.com", "icloud.com",
            "me.com", "aol.com", "gmx.de", "gmx.net", "web.de", "proton.me", "protonmail.com", "seznam.cz", "wp.pl",
            "mail.ru", "yandex.ru", "msn.com", "hotmail.co.uk", "yahoo.co.uk", "btinternet.com", "orange.fr", "free.fr"}

AUTOMATED_LOCAL = re.compile(
    r"^(no-?reply|do-?not-?reply|donotreply|notifications?|notify|alerts?|mailer-daemon|postmaster|bounces?|"
    r"calendar-notification|automated|system|news|newsletter|marketing|updates|info-noreply|receipts?|billing-noreply)"
    r"([+._-].*)?$", re.I)
AUTOMATED_ANY = re.compile(r"(no-?reply|mailer-daemon|bounce[s]?[+.-]|notifications?@|calendar-notification)", re.I)
AUTOMATED_DOMAINS = re.compile(
    r"(^|\.)(calendly\.com|docusign\.net|linkedin\.com|google\.com|accounts\.google\.com|postmarkapp\.com|"
    r"typeform\.com|hubspot\.com|hubspotemail\.net|mailchimp\.com|mcsv\.net|substack\.com|facebookmail\.com|"
    r"slack\.com|github\.com|notion\.so|zoom\.us|intercom\.io|sendgrid\.net|amazonses\.com)$", re.I)
CALENDAR_SUBJECT = re.compile(
    r"^\s*(updated invitation|invitation|accepted|declined|tentatively accepted|tentative|canceled event|"
    r"cancelled event|new event|event reminder)\s*(:|with)", re.I)
AUTO_SUBJECT = re.compile(
    r"^\s*(automatic reply|auto(matic)?[- ]?reply|out of (the )?office|abwesenheitsnotiz|delivery status notification|"
    r"undeliverable|undelivered mail|mail delivery (failed|subsystem)|returned mail)\b", re.I)

ASK = re.compile(r"\?|\b(offer|price|pricing|quote|let me know|could you|would you|can you|please confirm|"
                 r"please send|are you able|interested\b)", re.I)
REQUEST = re.compile(r"\?|\b(please|could you|would you|can you|let me know|kindly|we need|i need|looking for|"
                     r"send (me|us)|confirm|interested in|quote|price|offer|available)\b", re.I)
NO_REPLY_NEEDED = re.compile(
    r"^\s*(many )?(thanks|thank you|thx|cheers|great|perfect|noted|received|ok|okay|sounds good|will do|got it)"
    r"[\s!.,]*(\w+[\s!.,]*){0,6}$", re.I)
RECEIPT = re.compile(r"\b(receipt|invoice #|your order|payment (received|confirmation)|order confirmation|"
                     r"unsubscribe|view (this|in) (email|browser)|manage (your )?preferences)\b", re.I)

WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}
PROMISE = re.compile(
    r"\b(i'?ll|i will|we'?ll|we will|i'?m (getting|confirming|checking|putting)|let me)\b[^.?!\n]{0,80}?"
    r"\b(come back|get back|revert|send|share|confirm|check|follow up|put together|arrange|update|quote|be in touch|look into)\b[^.?!\n]*[.?!]?",
    re.I)
EXPLICIT_DUE = re.compile(
    r"\b(today|tonight|tomorrow|end of (the )?day|eod|cob|by (mon|tues|wednes|thurs|fri|satur|sun)day|"
    r"(on|until|end of) (mon|tues|wednes|thurs|fri|satur|sun)day|within \d+ hours|this week|end of the week|next week|"
    r"\d{1,2}(st|nd|rd|th)? (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))", re.I)
DEADLINE = re.compile(
    r"\b(asap|urgent(ly)?|as soon as possible|today|tonight|tomorrow|end of (the )?day|eod|cob|"
    r"by (mon|tues|wednes|thurs|fri|satur|sun)day|deadline|board (decision|meeting)|decision (is )?due|"
    r"within 24 hours|time[- ]sensitive)\b", re.I)

TRIAGE_ACTION = "1 Action"
TRIAGE_OTHER = {"2 Waiting", "4 Sorted", "5 Read"}
STREAM_TYPE = {"Admin": "admin", "Investor": "partner"}
CONTACT_TYPES = {"buyer", "supplier", "logistics", "partner", "admin", "other"}
PRIORITIES = ["overdue", "urgent", "high", "medium", "low"]


# ---------- small helpers ----------

def now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def email_of(value: str | None) -> str:
    return (parseaddr(value or "")[1] or value or "").strip().lower()


def domain_of(email: str | None) -> str:
    email = email_of(email)
    return email.rsplit("@", 1)[1] if "@" in email else ""


def is_own(email: str | None) -> bool:
    return domain_of(email) == OWN_DOMAIN


def is_automated(email: str | None, subject: str | None = "") -> bool:
    """Obvious machine senders and calendar or bounce traffic: never a Relay item."""
    email = email_of(email)
    local = email.split("@", 1)[0]
    if not email or AUTOMATED_LOCAL.match(local) or AUTOMATED_ANY.search(email) or AUTOMATED_DOMAINS.search(domain_of(email)):
        return True
    subject = subject or ""
    return bool(CALENDAR_SUBJECT.match(subject) or AUTO_SUBJECT.match(subject))


def company_from_domain(email: str | None) -> str | None:
    domain = domain_of(email)
    if not domain or domain in FREEMAIL:
        return None
    parts = domain.split(".")
    core = parts[-3] if len(parts) >= 3 and parts[-2] in {"co", "com", "org", "net", "ac"} and len(parts[-1]) == 2 else parts[-2] if len(parts) >= 2 else parts[0]
    return core.replace("-", " ").title() if core else None


def name_from_email(email: str | None) -> str | None:
    local = email_of(email).split("@", 1)[0]
    if not local or re.fullmatch(r"(info|sales|office|contact|admin|mail|hello|parts|support|magazijn|team|kontakt|invoices?|billing|accounts?|receipts?|orders?|service|enquiries|inquiries)", local, re.I):
        return None
    words = [w for w in re.split(r"[._-]+", local) if w and not w.isdigit()]
    return " ".join(w.capitalize() for w in words[:3]) or None


_reply_text = None


def _load_reply_text():
    global _reply_text
    if _reply_text is None:
        try:
            if str(TRIAGE_APP_SRC) not in sys.path:
                sys.path.insert(0, str(TRIAGE_APP_SRC))
            from gmail_email_management.outcomes import reply_text  # type: ignore
            _reply_text = reply_text
        except Exception:
            _reply_text = False
    return _reply_text


QUOTE_LINE = re.compile(
    r"^\s*(>|On .{5,200}wrote:?\s*$|Am .{5,200}schrieb.*$|Le .{5,200}a écrit.*$|-{2,}\s*Original Message|"
    r"_{5,}\s*$|From:\s.+|Von:\s.+|Van:\s.+|Fra:\s.+|Från:\s.+|De:\s.+@.+|Sent from my )", re.I)
SIGNATURE_LINE = re.compile(r"^\s*(Alex Polglase\s*$|founder\b|rebattery\.io\s*[●|]|--\s*$)", re.I)


def strip_quotes(text: str | None) -> str:
    """Plain-text fallback: keep only what was newly written above the quoted history or signature."""
    lines: list[str] = []
    for line in (text or "").replace("\xa0", " ").replace("\r\n", "\n").split("\n"):
        if QUOTE_LINE.match(line) or SIGNATURE_LINE.match(line):
            break
        lines.append(line)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def clean_text(html: str | None, plain: str | None) -> str:
    fn = _load_reply_text()
    text = ""
    if fn:
        try:
            text = fn(html=html, plain=plain)
        except Exception:
            text = ""
    if not text:
        text = strip_quotes(plain)
    text = strip_quotes(text)  # the triage stripper does not know German/Dutch headers
    return re.sub(r"\n{3,}", "\n\n", re.sub(r"[ \t]+\n", "\n", text)).strip()


def working_days_between(start: dt.datetime, end: dt.datetime) -> int:
    """Whole weekdays after start's date up to and including end's date."""
    a, b = start.date(), end.date()
    days, d = 0, a
    while d < b:
        d += dt.timedelta(days=1)
        if d.weekday() < 5:
            days += 1
    return days


def follow_threshold(contact_type: str | None, deal_linked: bool) -> int:
    """Alex, 27 Oct: chase deal threads after 4 working days, everyone else after 7."""
    return 4 if deal_linked else 7


def asks_something(text: str | None) -> bool:
    return bool(ASK.search(text or ""))


def needs_no_reply(text: str | None, subject: str | None, labels: list[str] | None) -> bool:
    text = (text or "").strip()
    if not text:
        return True
    if NO_REPLY_NEEDED.match(text) and "?" not in text:
        return True
    if RECEIPT.search(text) or RECEIPT.search(subject or ""):
        return True
    if FYI_LABELS & set(labels or []) and not REQUEST.search(text):
        return True
    return False


def _resolve_date(text: str, base: dt.date) -> dt.date | None:
    """An explicit due date in text relative to base, or None (no default)."""
    t = text.lower()
    if re.search(r"\b(today|tonight|end of (the )?day|eod|cob)\b", t):
        return base
    if "tomorrow" in t:
        return base + dt.timedelta(days=1)
    m = re.search(r"within (\d+) hours", t)
    if m:
        return base + dt.timedelta(days=max(1, int(m.group(1)) // 24))
    m = re.search(r"\b(\d{1,2})(?:st|nd|rd|th)? (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)", t)
    if m:
        try:
            d = dt.date(base.year, MONTHS[m.group(2)], int(m.group(1)))
            return d if d >= base else dt.date(base.year + 1, d.month, d.day)
        except ValueError:
            pass
    for i, day in enumerate(WEEKDAYS):
        if re.search(rf"\b(by|on|until|end of) {day}\b", t):
            ahead = (i - base.weekday()) % 7 or 7
            return base + dt.timedelta(days=ahead)
    if "next week" in t:
        return base + dt.timedelta(days=(4 - base.weekday()) % 7 + 7)
    if "this week" in t or "end of the week" in t:
        return base + dt.timedelta(days=(4 - base.weekday()) % 7)
    return None


def promise_due(text: str | None, sent: dt.datetime) -> tuple[str, dt.date] | None:
    """The first "I'll ... by <day>" promise with an explicit due date, as (sentence, due date)."""
    for m in PROMISE.finditer(text or ""):
        sentence = m.group(0)
        if EXPLICIT_DUE.search(sentence):
            due = _resolve_date(sentence, sent.date())
            if due:
                return sentence.strip(), due
    return None


def deadline_due(text: str | None, sent: dt.datetime) -> dt.date | None:
    """The date a deadline in their message falls due, or None when no deadline words are present."""
    text = text or ""
    m = DEADLINE.search(text)
    if not m:
        return None
    word = m.group(0).lower()
    if word.startswith(("asap", "urgent", "as soon", "time", "board", "decision", "deadline")):
        due = _resolve_date(text, sent.date())
        return due or sent.date()
    return _resolve_date(word, sent.date()) or sent.date()


# ---------- classification ----------

def real_messages(messages: list[dict]) -> list[dict]:
    """Messages that count: sent or received, not campaigns, drafts, spam, internal or machine mail."""
    keep = []
    for m in messages:
        labels = set(m.get("labels") or [])
        if m.get("state") not in KEEP_STATES or m.get("campaign_id") or m.get("purpose") == "marketing" or labels & SKIP_LABELS:
            continue
        if m["direction"] == "inbound":
            if is_own(m.get("from_email")) or is_automated(m.get("from_email"), m.get("subject")):
                continue
        else:
            external = [e for e in (m.get("to_emails") or []) + (m.get("cc_emails") or []) if not is_own(e)]
            if not external or CALENDAR_SUBJECT.match(m.get("subject") or ""):
                continue
        keep.append(m)
    return sorted(keep, key=lambda m: m["at"])


def counterpart_of(m: dict) -> str:
    if m["direction"] == "inbound":
        return email_of(m.get("from_email"))
    for e in (m.get("to_emails") or []) + (m.get("cc_emails") or []):
        if not is_own(e) and not is_automated(e):
            return email_of(e)
    return ""


def classify_thread(msgs: list[dict], ctx: dict, now: dt.datetime, days: int = 14, follow_days: int = 30) -> dict:
    """Decide tab (or None: nothing to show), reason, waiting_since and counterpart for one thread.

    msgs: real_messages() for the thread, oldest first, each with 'text' already cleaned.
    ctx: triage (state entry or {}), contact_type, deal_linked, last_to {email: at}, last_from {email: at}.
    """
    if not msgs:
        return {"tab": None, "reason": "no real messages", "done_reason": "gone"}
    last = msgs[-1]
    age_days = (now - last["at"]).total_seconds() / 86400
    counterpart = counterpart_of(last)
    triage = ctx.get("triage") or {}
    triage_state = triage.get("automated_state")
    triage_fresh = triage.get("last_classified_message_id") == last.get("gmail_message_id")
    out = {"counterpart_email": counterpart, "last": last}

    if last["direction"] == "inbound":
        if (ctx.get("last_to") or {}).get(counterpart) and ctx["last_to"][counterpart] > last["at"]:
            return {**out, "tab": None, "reason": "owner wrote to them since", "done_reason": "replied"}
        run = [m for m in msgs if m["at"] > max([x["at"] for x in msgs if x["direction"] == "outbound"], default=dt.datetime.min.replace(tzinfo=dt.timezone.utc))]
        waiting_since = run[0]["at"] if run else last["at"]
        if triage_state == TRIAGE_ACTION:
            tab, reason = "action", "triage: 1 Action"
        elif triage_state in TRIAGE_OTHER and triage_fresh:
            tab, reason = "other", f"triage: {triage_state}"
        elif needs_no_reply(last.get("text"), last.get("subject"), last.get("labels")):
            tab, reason = "other", "needs no reply"
        elif REQUEST.search(last.get("text") or "") and (ctx.get("known") or len(msgs) > 1 or any(m["direction"] == "outbound" for m in msgs)):
            tab, reason = "action", "inbound question or request"
        elif ctx.get("known") and len((last.get("text") or "")) > 40:
            tab, reason = "action", "inbound from a known contact"
        else:
            tab, reason = "other", "unsolicited or FYI"
        limit = follow_days if tab == "action" and triage_state == TRIAGE_ACTION else days
        if age_days > limit and not ctx.get("existing_open"):
            return {**out, "tab": None, "reason": "older than window", "done_reason": "expired"}
        if tab == "other" and age_days > days:
            return {**out, "tab": None, "reason": "older than window", "done_reason": "expired"}
        return {**out, "tab": tab, "reason": reason, "waiting_since": waiting_since}

    # The owner wrote last.
    if not any(m["direction"] == "inbound" for m in msgs):
        return {**out, "tab": None, "reason": "one-way outreach", "done_reason": "replied"}
    if (ctx.get("last_from") or {}).get(counterpart) and ctx["last_from"][counterpart] > last["at"]:
        return {**out, "tab": None, "reason": "they replied in another thread", "done_reason": "replied"}
    last_in = max(m["at"] for m in msgs if m["direction"] == "inbound")
    trailing = [m for m in msgs if m["direction"] == "outbound" and m["at"] > last_in]
    first_out = trailing[0]
    if age_days > follow_days:
        return {**out, "tab": None, "reason": "chase older than follow window", "done_reason": "expired"}
    nudges = len(trailing) - 1
    if nudges >= 2:
        return {**out, "tab": "other", "reason": f"{nudges} unanswered nudges, stopped chasing", "waiting_since": first_out["at"]}
    if not any(asks_something(m.get("text")) for m in trailing):
        return {**out, "tab": None, "reason": "owner replied, nothing asked", "done_reason": "replied"}
    need = follow_threshold(ctx.get("contact_type"), bool(ctx.get("deal_linked")))
    waited = working_days_between(last["at"], now)
    if waited < need:
        return {**out, "tab": None, "reason": f"owner replied, chase due after {need} working days ({waited} so far)", "done_reason": "replied"}
    return {**out, "tab": "follow", "reason": f"no reply for {waited} working days (threshold {need})", "waiting_since": first_out["at"]}


def compute_priority(result: dict, msgs: list[dict], ctx: dict, now: dt.datetime) -> tuple[str, str]:
    tab = result.get("tab")
    if tab == "other" or tab is None:
        return "low", "other tab"
    outbound = [m for m in msgs if m["direction"] == "outbound"]
    if outbound:
        p = promise_due(outbound[-1].get("text"), outbound[-1]["at"])
        if p and p[1] < now.date():
            return "overdue", f"promise past due {p[1].isoformat()}: {p[0][:80]}"
    if tab == "action":
        last = msgs[-1]
        due = deadline_due(last.get("text"), last["at"])
        if due is not None and now.date() <= due <= (now + dt.timedelta(hours=24)).date():
            return "urgent", f"deadline due {due.isoformat()}"
    contact_type = ctx.get("contact_type")
    if contact_type == "buyer":
        return "high", "buyer"
    if ctx.get("deal_linked"):
        return "high", "deal-linked"
    waiting = result.get("waiting_since")
    if contact_type == "supplier" and waiting and (now - waiting).total_seconds() > 48 * 3600:
        return "high", "supplier waiting over 48h"
    if contact_type == "admin":
        return "low", "admin"
    return "medium", "live business"


# ---------- data loading ----------

def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def table_exists(cur, name: str) -> bool:
    cur.execute("select to_regclass(%s) is not null as ok", (name,))
    return bool(cur.fetchone()["ok"])


def load_owner(cur, owner_email: str) -> str:
    cur.execute("select id from crm_users where lower(email) = lower(%s)", (owner_email,))
    row = cur.fetchone()
    if not row:
        raise SystemExit(f"no crm_users row for {owner_email}")
    return str(row["id"])


def load_existing(cur, owner_id: str) -> dict[str, dict]:
    if not table_exists(cur, "relay_item"):
        return {}
    cur.execute("select * from relay_item where owner_id = %s", (owner_id,))
    return {r["gmail_thread_id"]: dict(r) for r in cur.fetchall()}


def load_threads(cur, owner_id: str, since: dt.datetime, extra_thread_ids: list[str]) -> dict[str, dict]:
    cur.execute(
        """select id, gmail_thread_id, subject, last_message_at from mail_thread
           where mailbox_owner_id = %s and gmail_thread_id is not null
             and (last_message_at >= %s or id = any(%s))""",
        (owner_id, since, extra_thread_ids or []))
    threads = {r["id"]: {**dict(r), "messages": []} for r in cur.fetchall()}
    if not threads:
        return threads
    cur.execute(
        """select m.id, m.thread_id, m.direction, m.state, m.purpose, m.campaign_id, m.identity_key, m.gmail_message_id,
                  m.from_email, m.to_emails, m.cc_emails, m.subject, m.body_text, m.body_html, m.body_preview, m.labels,
                  coalesce(m.sent_at, m.accepted_at, m.created_at) as at, p.full_name as from_name
             from mail_message m left join crm_people p on p.id = m.from_person_id
            where m.mailbox_owner_id = %s and m.thread_id = any(%s)""",
        (owner_id, list(threads)))
    for r in cur.fetchall():
        threads[r["thread_id"]]["messages"].append(dict(r))
    return threads


def load_contact_maps(cur, owner_id: str, since: dt.datetime) -> tuple[dict, dict]:
    """last_to: when the owner last wrote to each address; last_from: when each address last wrote in."""
    cur.execute(
        """select direction, from_email, to_emails, cc_emails, coalesce(sent_at, accepted_at, created_at) as at
             from mail_message where mailbox_owner_id = %s and coalesce(sent_at, accepted_at, created_at) >= %s
              and state in ('accepted', 'received') and campaign_id is null""",
        (owner_id, since))
    last_to: dict[str, dt.datetime] = {}
    last_from: dict[str, dt.datetime] = {}
    for r in cur.fetchall():
        if r["direction"] == "outbound":
            for e in (r["to_emails"] or []) + (r["cc_emails"] or []):
                e = email_of(e)
                if e and (e not in last_to or r["at"] > last_to[e]):
                    last_to[e] = r["at"]
        else:
            e = email_of(r["from_email"])
            if e and (e not in last_from or r["at"] > last_from[e]):
                last_from[e] = r["at"]
    return last_to, last_from


def load_people(cur, emails: list[str]) -> dict[str, dict]:
    if not emails:
        return {}
    cur.execute(
        """select lower(p.email) as email, p.full_name, c.name as company, c.purpose
             from crm_people p left join crm_companies c on c.id = p.company_id
            where lower(p.email) = any(%s)""",
        (emails,))
    return {r["email"]: dict(r) for r in cur.fetchall()}


def load_companies_by_domain(cur, domains: list[str]) -> dict[str, dict]:
    if not domains:
        return {}
    cur.execute(
        """select distinct on (lower(domain)) lower(domain) as domain, name, purpose from crm_companies
            where lower(domain) = any(%s) order by lower(domain), updated_at desc""",
        (domains,))
    return {r["domain"]: dict(r) for r in cur.fetchall()}


def load_deals(cur, thread_ids: list[str]) -> dict[str, set[str]]:
    """Listings each mail thread is tagged with in Bulk Trades (confirmed or proposed links)."""
    if not thread_ids or not table_exists(cur, "crm_bulk_thread_links"):
        return {}
    cur.execute(
        """select thread_id, bulk_listing_id from crm_bulk_thread_links
            where channel = 'mail' and thread_id = any(%s) and state in ('confirmed', 'proposed')""",
        (thread_ids,))
    out: dict[str, set[str]] = {}
    for r in cur.fetchall():
        out.setdefault(r["thread_id"], set()).add(r["bulk_listing_id"])
    return out


def load_owned_listings(cur) -> dict[str, list[dict]]:
    """Bulk Trades listings keyed by the owner's email and by their company domain ("@domain")."""
    if not table_exists(cur, "crm_bulk_listings"):
        return {}
    cur.execute(
        """select b.id, b.kind, b.status, b.summary, b.quantity, b.updated_at, lower(coalesce(b.email, p.email)) as email
             from crm_bulk_listings b left join crm_people p on p.id = b.person_id
            where coalesce(b.email, p.email) is not null""")
    out: dict[str, list[dict]] = {}
    for r in cur.fetchall():
        email = email_of(r["email"])
        if not email:
            continue
        row = dict(r)
        out.setdefault(email, []).append(row)
        domain = domain_of(email)
        if domain and domain not in FREEMAIL:
            out.setdefault("@" + domain, []).append(row)
    return out


WORD = re.compile(r"[a-z0-9]{3,}")
STOP = {"the", "and", "for", "with", "from", "packs", "pack", "battery", "batteries", "kwh", "your", "you", "this", "that", "are", "have"}


def choose_deal(counterpart: str | None, contact_type: str | None, linked: set[str], text: str, owned: dict[str, list[dict]]) -> dict | None:
    """The counterpart's own listing for this thread: a buyer's demand request or a supplier's supply opportunity.

    Alex, 27 Oct: a buyer emailing about someone else's stock is linked to their demand, never to that supply.
    Prefers the listing the thread is tagged with, then the best word match with the email, then open, then newest.
    None when the counterpart owns no listing.
    """
    if not counterpart:
        return None
    seen, candidates = set(), []
    for key in (counterpart, "@" + (domain_of(counterpart) or "")):
        for row in owned.get(key, []):
            if row["id"] not in seen:
                seen.add(row["id"])
                candidates.append(row)
    want = {"buyer": "demand", "supplier": "supply"}.get(contact_type or "")
    if want and any(c["kind"] == want for c in candidates):
        candidates = [c for c in candidates if c["kind"] == want]
    if not candidates:
        return None
    words = set(WORD.findall(text.lower())) - STOP

    def score(c: dict) -> tuple:
        overlap = len(words & (set(WORD.findall((c["summary"] or "").lower())) - STOP))
        is_open = c["status"] in ("open", "qualifying")
        return (c["id"] in linked, overlap if (is_open or overlap >= 2) else -1, is_open, c["updated_at"] or dt.datetime.min.replace(tzinfo=dt.timezone.utc))

    best = max(candidates, key=score)
    if best["id"] not in linked and best["status"] not in ("open", "qualifying") and score(best)[1] < 2:
        return None
    return {"bulk_listing_id": best["id"], "summary": best["summary"], "quantity": best["quantity"]}


def load_open_deal_emails(cur) -> set[str]:
    """Counterpart emails on open or qualifying bulk deals (the listing's email or its person's email)."""
    if not table_exists(cur, "crm_bulk_listings"):
        return set()
    cur.execute(
        """select lower(coalesce(b.email, p.email)) as email from crm_bulk_listings b
             left join crm_people p on p.id = b.person_id
            where b.status in ('open', 'qualifying') and coalesce(b.email, p.email) is not null""")
    return {email_of(r["email"]) for r in cur.fetchall()}


def deal_label(summary: str | None, quantity: str | None) -> str | None:
    if not summary:
        return None
    head = re.split(r"[;:]|,\s|\.\s|\s[–—-]\s", summary.strip(), maxsplit=1)[0].strip()
    if len(head) > 48:
        head = head[:48].rsplit(" ", 1)[0] + "…"
    q = (quantity or "").strip()
    if q and len(q) <= 30 and q.lower() not in summary.lower():
        return f"{head} · {q}"
    return head


def purpose_type(purpose) -> str | None:
    p = set(purpose or [])
    if "Buyer" in p:
        return "buyer"
    if p & {"Supplier", "Dismantler"}:
        return "supplier"
    if p & {"Recycler", "Investor"}:
        return "partner"
    return None


# ---------- LLM summaries ----------

SUMMARY_INSTRUCTIONS = """You summarise email threads for Alex Polglase (ReBattery, a marketplace for used EV batteries) in his reply workbench.
For each thread return one JSON object. Reply with ONLY a JSON array, no prose, one object per thread, in any order:
{"key": "<the thread key>",
 "headline": "<at most 8 words: what they want from Alex, or what Alex is waiting on>",
 "context": "<2-3 plain sentences: what they are asking, the key facts (prices, quantities, models, dates) and what is still open>",
 "earlier": [{"who": "<first name or company>", "when": "<e.g. 21 Oct>", "summary": "<one line>"}],
 "contact_type": "buyer|supplier|logistics|partner|admin|other",
 "priority": "urgent|high|medium|low"}
Rules: British English. No em dashes. No greetings or filler. Never invent facts that are not in the thread.
"earlier" covers the messages before the last one, newest first, at most 5 (empty list when there are none).
tab "action" means Alex owes a reply; "follow" means Alex is waiting on them; "other" means no reply is needed."""


def build_summary_prompt(records: list[dict]) -> str:
    return SUMMARY_INSTRUCTIONS + "\n\n## Threads\n" + json.dumps(records, ensure_ascii=False, default=str)


def summary_record(key: str, subject: str, tab: str, msgs: list[dict], brief: dict | None) -> dict:
    shown = msgs[-6:]
    rows = []
    for i, m in enumerate(shown):
        text = m.get("text") or ""
        rows.append({
            "who": "Alex" if m["direction"] == "outbound" else (m.get("from_name") or m.get("from_email")),
            "when": m["at"].strftime("%d %b %Y %H:%M"),
            "text": text[:2500] if i == len(shown) - 1 else text[:500],
        })
    rec = {"key": key, "subject": subject, "tab": tab, "messages": rows}
    if brief:
        rec["triage_brief"] = {k: brief.get(k) for k in ("who", "aim", "facts", "their_questions", "next_step", "contact_type") if brief.get(k)}
    return rec


def run_hermes(prompt: str) -> str:
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as handle:
        handle.write(prompt)
        path = handle.name
    try:
        result = subprocess.run(
            ["hermes", "-p", "default", "chat", "-Q", "--oneshot", "--ignore-rules", "-t", "none", "--reasoning", "medium",
             "--source", "relay-scan", "--query-file", path],
            text=True, capture_output=True, timeout=600, check=False)
    finally:
        Path(path).unlink(missing_ok=True)
    if result.returncode:
        raise RuntimeError(f"model call failed: {(result.stderr or result.stdout).strip()[-300:]}")
    return result.stdout


def parse_summaries(text: str) -> dict[str, dict]:
    start, end = text.find("["), text.rfind("]")
    if start == -1 or end < start:
        raise ValueError("model reply contains no JSON array")
    items = json.loads(text[start:end + 1])
    out = {}
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict) or not item.get("key"):
            continue
        earlier = [e for e in (item.get("earlier") or []) if isinstance(e, dict)][:5]
        out[str(item["key"])] = {
            "headline": str(item.get("headline") or "").replace("—", ",").strip()[:120],
            "context": str(item.get("context") or "").replace("—", ",").strip()[:1200],
            "earlier": [{"who": str(e.get("who") or ""), "when": str(e.get("when") or ""), "summary": str(e.get("summary") or "")[:300]} for e in earlier],
            "contact_type": item.get("contact_type") if item.get("contact_type") in CONTACT_TYPES else None,
            "priority": item.get("priority") if item.get("priority") in PRIORITIES else None,
        }
    return out


def fallback_summary(subject: str, msgs: list[dict]) -> dict:
    last = msgs[-1]
    earlier = []
    for m in reversed(msgs[:-1][-5:]):
        who = "Alex" if m["direction"] == "outbound" else (m.get("from_name") or name_from_email(m.get("from_email")) or m.get("from_email"))
        earlier.append({"who": who, "when": m["at"].strftime("%d %b"), "summary": re.sub(r"\s+", " ", m.get("text") or "")[:140]})
    return {"headline": re.sub(r"^\s*((re|fwd?|aw|sv|wg|tr)\s*:\s*)+", "", subject or "", flags=re.I)[:60] or "(no subject)",
            "context": re.sub(r"\s+", " ", last.get("text") or last.get("body_preview") or "")[:300],
            "earlier": earlier, "contact_type": None, "priority": None}


def summarise(batches: list[list[dict]], model=run_hermes) -> tuple[dict[str, dict], int, list[str]]:
    """One model call per batch. Returns ({key: summary}, calls, errors); failed batches are simply absent."""
    found, calls, errors = {}, 0, []
    for batch in batches:
        calls += 1
        try:
            found.update(parse_summaries(model(build_summary_prompt(batch))))
        except Exception as exc:
            errors.append(f"llm batch of {len(batch)}: {str(exc)[:200]}")
    return found, calls, errors


# ---------- planning and writing ----------

CONTENT_FIELDS = ("headline", "context", "earlier", "contact_type", "last_message", "last_seen_message_id")
STATE_FIELDS = ("tab", "priority", "counterpart_name", "counterpart_email", "company", "mail_thread_id",
                "bulk_listing_id", "deal_label", "waiting_since")


def plan_writes(rows: list[dict], existing: dict[str, dict], now: dt.datetime, seen_threads: set[str]) -> list[dict]:
    """Turn classified rows into insert/update/done operations, respecting user state.

    rows: {gmail_thread_id, tab (or None), done_reason, newest_message_id, newest_at, summarised, fields...}
    seen_threads: gmail thread ids that were loaded this run (open items outside it are left alone).
    """
    ops = []
    by_thread = {r["gmail_thread_id"]: r for r in rows}
    for gid, row in by_thread.items():
        item = existing.get(gid)
        fields = {k: row.get(k) for k in STATE_FIELDS}
        content = {k: row.get(k) for k in CONTENT_FIELDS if k in row}
        if not row.get("summarised") and item:
            for k in ("headline", "context", "earlier"):
                content.pop(k, None)
            content["contact_type"] = row.get("contact_type") or item.get("contact_type")
            content["last_seen_message_id"] = item.get("last_seen_message_id")
        if not item:
            if row.get("tab"):
                ops.append({"op": "insert", "gmail_thread_id": gid, "values": {**fields, **content, "status": "open"}})
            continue
        new_message = row.get("newest_message_id") and row["newest_message_id"] != item.get("last_seen_message_id") \
            and (row.get("newest_at") is None or item.get("updated_at") is None or row["newest_at"] > item["updated_at"])
        snoozed = item.get("snooze_until") and item["snooze_until"] > now
        if item["status"] in ("review", "done"):
            reopen_follow = item["status"] == "done" and item.get("done_reason") == "replied" and row.get("tab") == "follow"
            if (new_message and row.get("tab")) or reopen_follow:
                ops.append({"op": "update", "gmail_thread_id": gid, "id": item["id"], "kind": "reopen",
                            "values": {**fields, **content, "status": "open", "done_reason": None}})
            continue
        if snoozed:
            if row.get("summarised") or new_message:
                ops.append({"op": "update", "gmail_thread_id": gid, "id": item["id"], "kind": "content", "values": content})
            continue
        if not row.get("tab"):
            ops.append({"op": "update", "gmail_thread_id": gid, "id": item["id"], "kind": "done",
                        "values": {"status": "done", "done_reason": row.get("done_reason") or "replied", **content}})
            continue
        values = {**fields, **content}
        changed = {k: v for k, v in values.items() if _differs(item.get(k), v)}
        if changed:
            ops.append({"op": "update", "gmail_thread_id": gid, "id": item["id"], "kind": "update", "values": changed})
    for gid, item in existing.items():
        if gid not in by_thread and gid in seen_threads and item["status"] == "open" and not (item.get("snooze_until") and item["snooze_until"] > now):
            ops.append({"op": "update", "gmail_thread_id": gid, "id": item["id"], "kind": "done",
                        "values": {"status": "done", "done_reason": "gone"}})
    return ops


def _differs(old, new) -> bool:
    if isinstance(new, (dict, list)):
        return json.dumps(old, sort_keys=True, default=str) != json.dumps(new, sort_keys=True, default=str)
    return old != new


def _db_value(key: str, value):
    if key in ("last_message", "earlier"):
        return psycopg2.extras.Json(value if value is not None else ([] if key == "earlier" else None), dumps=lambda v: json.dumps(v, default=str))
    return value


def apply_ops(conn, owner_id: str, ops: list[dict]) -> None:
    with conn.cursor() as cur:
        for op in ops:
            values = {k: v for k, v in op["values"].items() if k != "note"}
            if op["op"] == "insert":
                values.setdefault("headline", "")
                values.setdefault("context", "")
                values.setdefault("earlier", [])
                cols = ["owner_id", "gmail_thread_id", *values]
                cur.execute(
                    f"""insert into relay_item ({', '.join(cols)}) values ({', '.join(['%s'] * len(cols))})
                        on conflict (owner_id, gmail_thread_id) do nothing""",
                    [owner_id, op["gmail_thread_id"], *[_db_value(k, v) for k, v in values.items()]])
            else:
                if not values:
                    continue
                if values.get("headline") is None:
                    values.pop("headline", None)
                if values.get("context") is None:
                    values.pop("context", None)
                sets = ", ".join(f"{k} = %s" for k in values) + ", updated_at = now()"
                cur.execute(f"update relay_item set {sets} where id = %s and owner_id = %s",
                            [*[_db_value(k, v) for k, v in values.items()], op["id"], owner_id])
    conn.commit()


# ---------- run ----------

def build_rows(threads: dict[str, dict], existing: dict[str, dict], ctx_global: dict, now: dt.datetime, args) -> tuple[list[dict], list[dict], set[str]]:
    """Classify every loaded thread. Returns (rows, summary_jobs, seen gmail thread ids)."""
    rows, jobs, seen = [], [], set()
    triage = ctx_global["triage"]
    briefs = ctx_global["briefs"]
    for tid, th in threads.items():
        gid = th["gmail_thread_id"]
        seen.add(gid)
        for m in th["messages"]:
            m["text"] = clean_text(m.get("body_html"), m.get("body_text") or m.get("body_preview"))
        msgs = real_messages(th["messages"])
        item = existing.get(gid)
        if not msgs:
            if item:
                rows.append({"gmail_thread_id": gid, "tab": None, "done_reason": "gone"})
            continue
        last = msgs[-1]
        counterpart = counterpart_of(last)
        person = ctx_global["people"].get(counterpart) or {}
        company_row = ctx_global["companies"].get(domain_of(counterpart)) or {}
        brief = briefs.get(gid) if isinstance(briefs.get(gid), dict) else None
        tri = triage.get(gid) or {}
        thread_text = " ".join([th.get("subject") or ""] + [m.get("text") or "" for m in msgs[-3:]])
        contact_type = ((brief or {}).get("contact_type") if (brief or {}).get("contact_type") in CONTACT_TYPES else None) \
            or purpose_type(person.get("purpose")) or purpose_type(company_row.get("purpose")) \
            or STREAM_TYPE.get(tri.get("automated_stream") or "") or (item or {}).get("contact_type")
        deal = choose_deal(counterpart, contact_type, ctx_global["deals"].get(tid, set()), thread_text, ctx_global.get("owned", {}))
        deal_linked = bool(deal) or counterpart in ctx_global.get("open_deal_emails", set())
        ctx = {"triage": tri, "contact_type": contact_type, "deal_linked": deal_linked,
               "last_to": ctx_global["last_to"], "last_from": ctx_global["last_from"],
               "known": bool(person) or bool(company_row) or counterpart in ctx_global["last_to"],
               "existing_open": bool(item and item["status"] == "open")}
        result = classify_thread(msgs, ctx, now, args.days, args.follow_days)
        priority, why = compute_priority(result, msgs, ctx, now)
        sender_name = None
        if counterpart:
            for m in reversed(msgs):
                if m["direction"] == "inbound" and email_of(m.get("from_email")) == counterpart and m.get("from_name"):
                    sender_name = m["from_name"]
                    break
        name = sender_name or person.get("full_name") or name_from_email(counterpart)
        newest = max(th["messages"], key=lambda m: m["at"])
        row = {
            "gmail_thread_id": gid, "mail_thread_id": tid, "tab": result["tab"], "reason": result["reason"],
            "done_reason": result.get("done_reason"), "priority": priority, "priority_reason": why,
            "counterpart_email": counterpart or None, "counterpart_name": name,
            "company": person.get("company") or company_row.get("name") or company_from_domain(counterpart),
            "contact_type": contact_type,
            "bulk_listing_id": deal["bulk_listing_id"] if deal else None,
            "deal_label": deal_label(deal["summary"], deal["quantity"]) if deal else None,
            "waiting_since": result.get("waiting_since"),
            "last_message": {"from_name": "Alex" if last["direction"] == "outbound" else name,
                             "from_email": email_of(last.get("from_email")), "at": last["at"].isoformat(),
                             "direction": last["direction"], "text": last.get("text") or ""},
            "newest_message_id": newest["id"], "newest_at": newest["at"], "last_seen_message_id": newest["id"],
            "subject": th.get("subject") or last.get("subject") or "", "summarised": False,
        }
        fb = fallback_summary(row["subject"], msgs)
        row.update({k: fb[k] for k in ("headline", "context", "earlier")})
        rows.append(row)
        if result["tab"] and (not item or item.get("last_seen_message_id") != newest["id"]):
            if not item or item["status"] == "open" or (item.get("updated_at") and newest["at"] > item["updated_at"]):
                jobs.append({"row": row, "record": summary_record(gid, row["subject"], result["tab"], msgs, brief), "ctx": ctx, "msgs": msgs, "result": result})
    return rows, jobs, seen


def merge_summary(job: dict, summary: dict, now: dt.datetime) -> None:
    row = job["row"]
    for k in ("headline", "context", "earlier"):
        if summary.get(k) or k == "earlier":
            row[k] = summary.get(k) or []
    if not row.get("contact_type") and summary.get("contact_type"):
        row["contact_type"] = summary["contact_type"]
        ctx = {**job["ctx"], "contact_type": summary["contact_type"]}
        row["priority"], row["priority_reason"] = compute_priority(job["result"], job["msgs"], ctx, now)
    if row["priority"] == "medium" and summary.get("priority") in ("urgent", "high"):
        row["priority"], row["priority_reason"] = "high", "model suggestion"
    row["summarised"] = True


def run_sync(owner_email: str) -> str | None:
    env = dict(os.environ)
    if not env.get("GOG_KEYRING_PASSWORD") and KEYRING_FILE.exists():
        env["GOG_KEYRING_PASSWORD"] = KEYRING_FILE.read_text().strip()
    since = (dt.date.today() - dt.timedelta(days=1)).strftime("%Y/%m/%d")
    result = subprocess.run(["/usr/bin/python3", str(SYNC_SCRIPT), "sync", "gmail", "--account", owner_email, "--since", since, "--apply"],
                            env=env, text=True, capture_output=True, timeout=900, check=False)
    if result.returncode:
        return f"sync failed (exit {result.returncode}): {(result.stderr or result.stdout).strip()[-200:]}"
    return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--apply", action="store_true", help="write relay_item (default: dry run)")
    parser.add_argument("--owner-email", default="alex@rebattery.io")
    parser.add_argument("--days", type=int, default=14, help="window for action/other threads")
    parser.add_argument("--follow-days", type=int, default=30, help="maximum age of a chase")
    parser.add_argument("--no-llm", action="store_true", help="skip the model; use subject + opening lines")
    parser.add_argument("--llm-limit", type=int, default=LLM_THREAD_LIMIT, help="threads summarised per run")
    parser.add_argument("--sync", action="store_true", help="sync the owner's Gmail since yesterday first")
    parser.add_argument("--dsn", default=os.environ.get("RELAY_DSN", DEFAULT_DSN))
    parser.add_argument("--schema", help="search_path schema (tests)")
    parser.add_argument("--triage-dir", default=str(TRIAGE_DIR))
    parser.add_argument("--examples", type=int, default=0, help="include N classified example threads in the summary")
    args = parser.parse_args(argv)

    lock_handle = open(f"/tmp/relay-scan-{re.sub(r'[^a-z0-9]', '_', args.owner_email.lower())}.lock", "w")
    try:
        fcntl.flock(lock_handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print(json.dumps({"skipped": "another relay scan is running"}))
        return 0

    errors: list[str] = []
    if args.sync:
        err = run_sync(args.owner_email)
        if err:
            errors.append(err)

    now = now_utc()
    conn = psycopg2.connect(args.dsn)
    conn.set_session(readonly=not args.apply)
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        if args.schema:
            cur.execute("select set_config('search_path', %s, false)", (f"{args.schema}, public",))
        owner_id = load_owner(cur, args.owner_email)
        existing = load_existing(cur, owner_id)
        open_thread_ids = [i["mail_thread_id"] for i in existing.values() if i["status"] == "open" and i.get("mail_thread_id")]
        since = now - dt.timedelta(days=max(args.days, args.follow_days))
        threads = load_threads(cur, owner_id, since, open_thread_ids)
        last_to, last_from = load_contact_maps(cur, owner_id, now - dt.timedelta(days=max(args.days, args.follow_days) + 30))
        counterparts = set()
        for th in threads.values():
            for m in th["messages"]:
                counterparts.add(counterpart_of(m))
        counterparts.discard("")
        triage_dir = Path(args.triage_dir)
        ctx_global = {
            "triage": (load_json(triage_dir / "state.json", {}) or {}).get("threads", {}),
            "briefs": load_json(triage_dir / "briefs.json", {}) or {},
            "people": load_people(cur, sorted(counterparts)),
            "companies": load_companies_by_domain(cur, sorted({domain_of(e) for e in counterparts} - FREEMAIL - {""})),
            "deals": load_deals(cur, list(threads)),
            "open_deal_emails": load_open_deal_emails(cur),
            "owned": load_owned_listings(cur),
            "last_to": last_to, "last_from": last_from,
        }
        rows, jobs, seen = build_rows(threads, existing, ctx_global, now, args)

        llm_calls = 0
        if not args.no_llm and jobs:
            todo = jobs[: max(0, args.llm_limit)]
            batches = [[j["record"] for j in todo[i:i + LLM_BATCH]] for i in range(0, len(todo), LLM_BATCH)]
            found, llm_calls, llm_errors = summarise(batches, model=run_hermes)
            errors.extend(llm_errors)
            for job in todo:
                key = job["row"]["gmail_thread_id"]
                if key in found:
                    merge_summary(job, found[key], now)
            for job in jobs:
                if not job["row"]["summarised"]:
                    # Keep the old last_seen so the thread is summarised next run.
                    old = existing.get(job["row"]["gmail_thread_id"])
                    job["row"]["last_seen_message_id"] = old.get("last_seen_message_id") if old else None
        elif args.no_llm:
            for job in jobs:
                job["row"]["summarised"] = True  # fallback content stands in for a summary

        ops = plan_writes(rows, existing, now, seen)
        if args.apply and ops:
            apply_ops(conn, owner_id, ops)

        tabs: dict[str, int] = {"action": 0, "follow": 0, "other": 0}
        priorities: dict[str, int] = {}
        for r in rows:
            if r.get("tab"):
                tabs[r["tab"]] += 1
                priorities[r["priority"]] = priorities.get(r["priority"], 0) + 1
        reasons: dict[str, int] = {}
        for r in rows:
            if r.get("tab"):
                key = f'{r["tab"]}: {re.sub(r"[0-9]+", "N", r["reason"])}'
                reasons[key] = reasons.get(key, 0) + 1
        summary = {
            "mode": "apply" if args.apply else "dry-run",
            "owner": args.owner_email, "threads_loaded": len(threads), "tabs": tabs, "priorities": priorities,
            "new": sum(1 for o in ops if o["op"] == "insert"),
            "updated": sum(1 for o in ops if o["op"] == "update" and o["kind"] in ("update", "content", "reopen")),
            "reopened": sum(1 for o in ops if o.get("kind") == "reopen"),
            "done": sum(1 for o in ops if o.get("kind") == "done"),
            "llm_calls": llm_calls, "summaries_pending": sum(1 for j in jobs if not j["row"]["summarised"]),
            "reasons": dict(sorted(reasons.items(), key=lambda kv: -kv[1])),
            "relay_table": bool(existing) or table_exists(cur, "relay_item"),
            "errors": errors,
        }
        if args.examples:
            order = {"action": 0, "follow": 1, "other": 2}
            shown = sorted([r for r in rows if r.get("tab")], key=lambda r: (order[r["tab"]], PRIORITIES.index(r["priority"])))
            picks, per_tab = [], {}
            for r in shown:
                if per_tab.get(r["tab"], 0) < max(1, args.examples // 3 + 1) and len(picks) < args.examples:
                    per_tab[r["tab"]] = per_tab.get(r["tab"], 0) + 1
                    picks.append(r)
            summary["examples"] = [{"subject": r["subject"][:80], "tab": r["tab"], "priority": r["priority"],
                                    "reason": r["reason"], "priority_reason": r["priority_reason"],
                                    "counterpart": r.get("counterpart_name") or r.get("company"), "deal": r.get("deal_label")}
                                   for r in picks]
        print(json.dumps(summary, ensure_ascii=False, default=str))
    finally:
        conn.rollback() if not args.apply else None
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
