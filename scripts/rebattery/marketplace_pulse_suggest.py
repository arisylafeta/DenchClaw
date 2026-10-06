#!/usr/bin/env python3
"""Marketplace Pulse suggestions: the context a Hermes agent reads, and where it saves what it suggests.

  marketplace_pulse_suggest.py context        # print the last 8 weeks, targets and past suggestions as JSON
  marketplace_pulse_suggest.py save < s.json  # save a JSON list of suggestions as today's batch

Each suggestion: {"title", "evidence", "action", "metric" (a metric name or null), "owner" (Alex, Ari
or Product)}. Saving records the metric's value in the last full week, so the page can show what
changed once a suggestion is done. A batch replaces any earlier batch saved the same day.
"""

import argparse
import datetime as dt
import json
import sys
import uuid

import psycopg2
import psycopg2.extras

OWNERS = ("Alex", "Ari", "Product")
DEFINITIONS = {
    "visitors": "people who saw the marketplace or a listing (PostHog)",
    "browsed": "people on the marketplace page",
    "clicked_listing": "people who clicked a listing card",
    "viewed_listing": "people on a listing page",
    "started_contact": "people who started a message, offer or buy-now",
    "sent_contact": "people whose message, offer or buy-now went through",
    "deals_created": "deals created on the platform, test buyers left out",
    "deals_paid": "deals whose first payment was captured",
    "paid_value_gbp": "what paid deals sold for, about GBP",
    "deals_cancelled": "deals cancelled that week",
    "offers_made": "offers made on listings",
    "buyer_chats": "new purchase conversations",
    "auction_bids": "offers and buy-nows on auctions",
    "listings_live": "published listings, counted at collection time (current week only)",
    "listings_new": "listings added that week (eBay imports can add hundreds at once)",
    "sell_requests": "Joules sell requests, tests left out",
    "joules_started": "people who started a Joules chat",
    "drop_no_price": "people on a listing that shows no price (offer only)",
    "drop_search_no_exact": "people whose search found no exact match",
    "drop_signin_wall": "people shown the sign-in or sign-up box",
    "signup_submitted": "people who submitted the sign-up form",
    "buyer_signups": "buyer accounts created on the platform",
    "drop_signup_captcha": "sign-ups that failed the captcha",
    "drop_signup_registered": "sign-ups that failed because the email already had an account",
    "drop_signup_other": "sign-ups that failed for another reason",
    "drop_contact_error": "people who hit an error sending a message, offer or buy-now",
    "drop_offers_expired": "offers that expired before the seller replied",
    "drop_payment_failed": "deals whose first payment failed",
}
MAX_PER_BATCH = 5


def last_full_week(today):
    return today - dt.timedelta(days=today.weekday() + 7)


def context(conn, today):
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("""select to_char(week_start, 'YYYY-MM-DD') as week, metric, value::float as value
                         from crm_metric_snapshots where week_start >= %s order by week_start, metric""",
                    (today - dt.timedelta(days=63),))
        weeks = {}
        for row in cur.fetchall():
            weeks.setdefault(row["week"], {})[row["metric"]] = row["value"]
        cur.execute("select metric, weekly_target::float as target from crm_metric_targets order by metric")
        targets = {row["metric"]: row["target"] for row in cur.fetchall()}
        cur.execute("""select to_char(batch, 'YYYY-MM-DD') as batch, title, action, metric, owner, status,
                              to_char(before_week, 'YYYY-MM-DD') as before_week, before_value::float as before_value
                         from crm_pulse_suggestions where batch >= %s order by batch desc, created_at""",
                    (today - dt.timedelta(days=60),))
        past = cur.fetchall()
    for suggestion in past:
        latest = weeks.get(last_full_week(today).isoformat(), {})
        suggestion["value_now"] = latest.get(suggestion["metric"]) if suggestion["metric"] else None
    return {
        "today": today.isoformat(),
        "last_full_week": last_full_week(today).isoformat(),
        "note": "Weeks start Monday (UTC). The current week is partial. People are counted once per week.",
        "definitions": DEFINITIONS,
        "weeks": weeks,
        "targets": targets,
        "past_suggestions": past,
    }


def validate(items, metrics):
    if not isinstance(items, list) or not 1 <= len(items) <= MAX_PER_BATCH:
        raise SystemExit(f"Expected a JSON list of 1 to {MAX_PER_BATCH} suggestions.")
    clean = []
    for i, item in enumerate(items, 1):
        if not isinstance(item, dict):
            raise SystemExit(f"Suggestion {i} is not an object.")
        title, evidence, action = (str(item.get(k) or "").strip() for k in ("title", "evidence", "action"))
        if not title or not evidence or not action:
            raise SystemExit(f"Suggestion {i} needs a title, evidence and an action.")
        metric = item.get("metric") or None
        if metric is not None and metric not in metrics:
            raise SystemExit(f"Suggestion {i}: unknown metric {metric!r}. Known: {', '.join(sorted(metrics))}.")
        owner = item.get("owner")
        if owner not in OWNERS:
            raise SystemExit(f"Suggestion {i}: owner must be one of {', '.join(OWNERS)}.")
        clean.append({"title": title, "evidence": evidence, "action": action, "metric": metric, "owner": owner})
    return clean


def save(conn, items, today):
    week = last_full_week(today)
    with conn.cursor() as cur:
        cur.execute("select distinct metric from crm_metric_snapshots")
        metrics = {row[0] for row in cur.fetchall()}
        clean = validate(items, metrics)
        cur.execute("delete from crm_pulse_suggestions where batch = %s and status = 'New'", (today,))
        for item in clean:
            before = None
            if item["metric"]:
                cur.execute("select value from crm_metric_snapshots where week_start = %s and metric = %s", (week, item["metric"]))
                row = cur.fetchone()
                before = row[0] if row else None
            cur.execute(
                """insert into crm_pulse_suggestions (id, batch, title, evidence, action, metric, owner, before_week, before_value)
                   values (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (str(uuid.uuid4()), today, item["title"], item["evidence"], item["action"], item["metric"], item["owner"],
                 week if item["metric"] else None, before))
    conn.commit()
    return len(clean)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=("context", "save"))
    parser.add_argument("--dsn", default="host=/var/run/postgresql dbname=denchclaw")
    args = parser.parse_args()
    today = dt.datetime.now(dt.timezone.utc).date()
    conn = psycopg2.connect(args.dsn)
    try:
        if args.command == "context":
            json.dump(context(conn, today), sys.stdout, indent=1, default=str)
            print()
        else:
            try:
                items = json.load(sys.stdin)
            except json.JSONDecodeError as err:
                raise SystemExit(f"Input is not JSON: {err}")
            print(f"Saved {save(conn, items, today)} suggestions for {today}.")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
