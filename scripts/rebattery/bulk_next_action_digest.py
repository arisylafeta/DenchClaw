#!/usr/bin/env python3
"""Morning email of each driver's Bulk Trades next actions: due today, overdue, and listings with no next action.

One email per driver, only on weekdays and only when something is due today or overdue. Unassigned listings
(no context.owner) go to the fallback driver (Alex). Each line links to its listing in the CRM.
Sends through rebattery-mail (identity hello, Postmark transactional). Dry run unless --apply: prints who would get what.
A state file stops a second send to the same person on the same day (cron retries). It is written under a lock, atomically, and
marked "pending" before each send: a send that may have gone out (timeout, crash) is never retried automatically.
--approved-by is required with --apply: the named person whose standing approval covers the schedule.

  bulk_next_action_digest.py [--apply] [--today YYYY-MM-DD] [--force] [--only Alex] [--to-override you@rebattery.io] [--at-hour 8]

Scheduled at 07:00 and 08:00 UTC on weekdays with --at-hour 8, so it sends at 08:00 London time in summer and winter.
"""
import argparse
import fcntl
import html
import json
import os
import subprocess
import sys
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

DSN = os.environ.get("DENCH_CRM_DSN", "host=/var/run/postgresql dbname=denchclaw")
CRM = "https://crm.rebattery.io/?path=%7Etrades-preview"
RECIPIENTS = {"Alex": "alex@rebattery.io", "Sean": "sean@rebattery.io"}
FALLBACK = "Alex"
STATE = Path(os.environ.get("BULK_DIGEST_STATE", "/root/.hermes/workspace/bulk-next-digest/sent.json"))
OVERDUE_SHOWN = 8
NEEDS_SHOWN = 5


def listing_url(listing_id):
    return f"{CRM}&listing={listing_id}"


def load_rows(conn):
    """Open demand and supply listings with their next action, due date and driver."""
    with conn.cursor() as cur:
        cur.execute("""
            select id, kind, coalesce(nullif(context->>'owner', ''), '') as owner, next_action,
                   to_char(next_due, 'YYYY-MM-DD') as next_due,
                   coalesce(nullif(spec->>'title', ''), left(summary, 80)) as title, party
              from crm_bulk_listings
             where status <> 'closed' and kind in ('demand', 'supply')""")
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def driver_of(row):
    return row["owner"] if row["owner"] in RECIPIENTS else FALLBACK


def day_label(day):
    d = date.fromisoformat(day)
    return f"{d.day} {d.strftime('%b')}"


def where(row):
    return f"{row['party']}: {row['title']}" if row.get("party") and row["party"] not in (row.get("title") or "") else (row.get("title") or row["id"])


def build_digests(rows, today):
    """{driver: {"today": [...], "overdue": [...], "needs": [...]}} for drivers with something due today or overdue."""
    out = {}
    for row in rows:
        group = out.setdefault(driver_of(row), {"today": [], "overdue": [], "needs": []})
        due = row.get("next_due")
        if not row.get("next_action"):
            group["needs"].append(row)
        elif due and due == today:
            group["today"].append(row)
        elif due and due < today:
            group["overdue"].append(row)
    for group in out.values():
        group["overdue"].sort(key=lambda r: (r["next_due"], r["id"]))
        group["today"].sort(key=lambda r: r["id"])
        group["needs"].sort(key=lambda r: r["id"])
    return {who: g for who, g in out.items() if g["today"] or g["overdue"]}


def subject(group):
    parts = []
    if group["today"]:
        parts.append(f"{len(group['today'])} due")
    if group["overdue"]:
        parts.append(f"{len(group['overdue'])} overdue")
    return "Today: " + ", ".join(parts)


def render(driver, group):
    """(plain text, html) of one driver's email."""
    def section(title, items, shown, line, colour):
        if not items:
            return "", ""
        more = len(items) - shown
        text = [f"{title} ({len(items)})"] + [f"- {line(r)}\n  {listing_url(r['id'])}" for r in items[:shown]]
        if more > 0:
            text.append(f"  and {more} more in Today")
        lis = "".join(
            f'<li style="padding:9px 0;border-top:1px solid #f0f0f0"><a href="{html.escape(listing_url(r["id"]))}" '
            f'style="color:#1a1a1a;font-weight:600;text-decoration:none">{html.escape(r.get("next_action") or "Add a next action")}</a>'
            f'<span style="display:block;font-size:12px;color:#5c5c5c">{html.escape(where(r))}'
            f'{" · due " + day_label(r["next_due"]) if title == "Overdue" else ""}</span></li>'
            for r in items[:shown])
        if more > 0:
            lis += f'<li style="padding:9px 0;border-top:1px solid #f0f0f0;font-size:12px;color:#5c5c5c">and {more} more in Today</li>'
        block = (f'<h4 style="margin:16px 0 6px;font-size:12px;color:{colour}">{title} ({len(items)})</h4>'
                 f'<ul style="list-style:none;margin:0;padding:0">{lis}</ul>')
        return "\n".join(text), block

    act = lambda r: f"{r['next_action']} ({where(r)})"
    overdue_line = lambda r: f"{r['next_action']} ({where(r)}, due {day_label(r['next_due'])})"
    needs_line = lambda r: f"Add a next action: {where(r)}"
    t1, h1 = section("Due today", group["today"], len(group["today"]), act, "#1e40af")
    t2, h2 = section("Needs a next action", group["needs"], NEEDS_SHOWN, needs_line, "#c2410c")
    t3, h3 = section("Overdue", group["overdue"], OVERDUE_SHOWN, overdue_line, "#b91c1c")
    today_url = f"{CRM}&owner={driver}"
    text = "\n\n".join(x for x in (f"Good morning, {driver}.", t1, t2, t3, f"Open Today: {today_url}") if x)
    page = (f'<div style="font-family:-apple-system,Segoe UI,system-ui,sans-serif;font-size:14px;line-height:1.45;color:#1a1a1a;max-width:560px">'
            f'<p style="margin:0 0 12px;font-size:16px;font-weight:600">Good morning, {html.escape(driver)}</p>'
            f'{h1}{h2}{h3}'
            f'<p style="margin:20px 0 0"><a href="{html.escape(today_url)}" style="display:inline-block;background:#e7f346;color:#0a0a0a;'
            f'font-weight:600;padding:10px 16px;border-radius:8px;text-decoration:none">Open Today</a></p>'
            f'<p style="margin:18px 0 0;font-size:11px;color:#5c5c5c">Your listings in Bulk Trades{", plus listings with no driver or driven by Ari" if driver == FALLBACK else ""}.</p></div>')
    return text, page


def mail_cli(*args, timeout=300):
    p = subprocess.run(["rebattery-mail", *args], capture_output=True, text=True, timeout=timeout)
    if p.returncode != 0:
        raise RuntimeError(f"rebattery-mail {args[0]} failed: {(p.stderr or p.stdout).strip()[:500]}")
    return json.loads(p.stdout) if p.stdout.strip().startswith("{") else {}


def send(to, subj, text, page, approved_by):
    draft = mail_cli("draft", "--identity", "hello", "--purpose", "transactional", "--transport", "postmark-transactional",
                     "--to", to, "--subject", subj, "--body", text, "--html", page, "--apply")["message"]["id"]
    mail_cli("send", draft, "--approved-by", approved_by, timeout=600)
    return draft


def save_state(state):
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=1))
    os.replace(tmp, STATE)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="send for real")
    ap.add_argument("--today", help="YYYY-MM-DD (default: today in London)")
    ap.add_argument("--force", action="store_true", help="send at the weekend too, and again on a day already sent")
    ap.add_argument("--only", help="one driver, e.g. Alex")
    ap.add_argument("--to-override", help="send every email to this address instead (tests)")
    ap.add_argument("--at-hour", type=int, help="only run when the London hour is this (cron runs at both UTC hours)")
    ap.add_argument("--approved-by", help="named human whose standing approval covers these sends (required with --apply)")
    args = ap.parse_args()
    if args.apply and not args.approved_by:
        ap.error("--apply needs --approved-by <name>")

    now = datetime.now(ZoneInfo("Europe/London"))
    if args.at_hour is not None and now.hour != args.at_hour and not args.force:
        return 0  # the other UTC slot: silent, nothing to do
    today = args.today or now.date().isoformat()
    if date.fromisoformat(today).weekday() >= 5 and not args.force:
        print(json.dumps({"today": today, "skipped": "weekend"}))
        return 0

    import psycopg2
    with psycopg2.connect(DSN) as conn:
        digests = build_digests(load_rows(conn), today)
    if args.only:
        digests = {k: v for k, v in digests.items() if k == args.only}

    STATE.parent.mkdir(parents=True, exist_ok=True)
    lock = open(f"{STATE}.lock", "w")
    fcntl.flock(lock, fcntl.LOCK_EX)  # two overlapping runs must not both send
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    report, failed = [], False
    for driver, group in sorted(digests.items()):
        to = args.to_override or RECIPIENTS[driver]
        subj = subject(group)
        text, page = render(driver, group)
        entry = {"driver": driver, "to": to, "subject": subj, "today": len(group["today"]),
                 "overdue": len(group["overdue"]), "needs": len(group["needs"])}
        key = f"{today}:{to}"
        if not args.apply:
            entry["preview"] = text
        elif key in state and not args.force:
            entry["skipped"] = "already sent today" if state[key] != "pending" else "an earlier send may have gone out; not retried"
        else:
            state[key] = "pending"
            save_state(state)
            try:
                entry["mail_id"] = state[key] = send(to, subj, text, page, args.approved_by)
                save_state(state)
            except Exception as err:  # keep going for the other drivers, exit 1 at the end; the key stays pending
                entry["error"] = str(err)
                failed = True
        report.append(entry)
    print(json.dumps({"today": today, "apply": args.apply, "emails": report}, indent=1))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
