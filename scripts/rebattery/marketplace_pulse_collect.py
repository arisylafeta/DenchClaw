#!/usr/bin/env python3
"""Marketplace Pulse collector: one number per metric per week for the CRM's Marketplace Pulse page.

  marketplace_pulse_collect.py                    # refresh last week and this week
  marketplace_pulse_collect.py --since 2026-08-10 # backfill every week from that Monday
  marketplace_pulse_collect.py --dry-run          # print the numbers, write nothing

Weeks start on Monday, UTC. Sources, both read-only:

- PostHog (credentials in /root/.posthog/credentials.json): distinct people per week on
  rebattery.io, with PostHog's test-account filter. Uses the same events as the daily buyer funnel
  journal (PHQ-BF-01), counted over the whole week, because daily people cannot be added up.
- The ReBattery platform (REST, key in dench-platform-admin.env): deals, payments, offers, buyer
  chats, auction bids, listings and Joules sell requests. Test and staff buyers, and test sellers,
  are left out using apps/web/lib/marketplace-pulse-exclusions.json. ReBattery's own listings count.
  Paid value is the deal amount (what the goods sold for), not the payer total with fees.

Writes crm_metric_snapshots (aggregates only, no people). listings_live is a count at collection
time, so it is written for the current week only. When PostHog cannot be read, the platform numbers
are still written and the script exits 1.
"""

import argparse
import datetime as dt
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

import psycopg2

HERE = Path(__file__).resolve().parent
EXCLUSIONS = HERE.parent.parent / "apps/web/lib/marketplace-pulse-exclusions.json"
PLATFORM_ENV = Path("/root/.hermes/workspace/secrets/dench-platform-admin.env")
POSTHOG_CREDENTIALS = Path("/root/.posthog/credentials.json")
POSTHOG_PROJECT = "375247"

# Rough rates for one "paid value" number across currencies. Good enough for a weekly trend.
GBP_PER = {"GBP": 1.0, "EUR": 0.86, "USD": 0.75}
CONTACT_TYPES = ("purchase", "buy_now")

POSTHOG_QUERY = """SELECT toString(toStartOfWeek(timestamp, 1)) AS week,
  uniqIf(person_id, event IN ('marketplace_page_viewed', 'listing_detail_viewed')) AS visitors,
  uniqIf(person_id, event = 'marketplace_page_viewed') AS browsed,
  uniqIf(person_id, event = 'marketplace_listing_clicked') AS clicked_listing,
  uniqIf(person_id, event = 'listing_detail_viewed') AS viewed_listing,
  uniqIf(person_id, event IN ('listing_message_started', 'listing_offer_submitted', 'listing_buy_now_submitted')) AS started_contact,
  uniqIf(person_id, event IN ('listing_message_succeeded', 'listing_offer_succeeded', 'listing_buy_now_succeeded')) AS sent_contact,
  uniqIf(person_id, event = 'jules_started') AS joules_started
FROM events
WHERE timestamp >= toDateTime('{start}') AND timestamp < toDateTime('{end}')
  AND toString(properties.$host) IN ('rebattery.io', 'www.rebattery.io')
  AND event IN ('marketplace_page_viewed', 'listing_detail_viewed', 'marketplace_listing_clicked',
    'listing_message_started', 'listing_offer_submitted', 'listing_buy_now_submitted',
    'listing_message_succeeded', 'listing_offer_succeeded', 'listing_buy_now_succeeded', 'jules_started')
  AND {{filters}}
GROUP BY week ORDER BY week"""
POSTHOG_METRICS = ("visitors", "browsed", "clicked_listing", "viewed_listing", "started_contact", "sent_contact", "joules_started")


def monday(day):
    return day - dt.timedelta(days=day.weekday())


def week_of(timestamp):
    """The Monday (UTC) of the week an ISO timestamp falls in, or None."""
    if not timestamp:
        return None
    moment = dt.datetime.fromisoformat(timestamp.replace("Z", "+00:00")).astimezone(dt.timezone.utc)
    return monday(moment.date())


def weeks_from(first, last):
    weeks, week = [], monday(first)
    while week <= last:
        weeks.append(week)
        week += dt.timedelta(days=7)
    return weeks


def load_exclusions(path=EXCLUSIONS):
    data = json.loads(path.read_text())
    return re.compile(data["staff_email_pattern"], re.I), set(data["test_account_ids"])


def read_env_value(path, name):
    for line in path.read_text().splitlines():
        key, sep, value = line.partition("=")
        if sep and key.strip() == name:
            return value.strip().strip("'\"")
    return None


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------

class Platform:
    """Read-only access to the platform's REST API with the service key."""

    def __init__(self, env_path=PLATFORM_ENV):
        self.url = read_env_value(env_path, "NEXT_PUBLIC_SUPABASE_URL")
        self.key = read_env_value(env_path, "SUPABASE_SECRET_KEY")
        if not self.url or not self.key:
            raise SystemExit(f"platform URL or key missing in {env_path}")

    def get(self, table, params):
        """Every row, a thousand at a time."""
        rows, offset = [], 0
        while True:
            query = urllib.parse.urlencode({**params, "limit": 1000, "offset": offset}, safe="(),.*:!")
            request = urllib.request.Request(f"{self.url}/rest/v1/{table}?{query}", headers={
                "apikey": self.key, "Authorization": f"Bearer {self.key}", "Accept": "application/json"})
            with urllib.request.urlopen(request, timeout=60) as response:
                page = json.loads(response.read())
            rows += page
            if len(page) < 1000:
                return rows
            offset += 1000

    def get_in(self, table, select, column, values):
        values = sorted(set(values))
        rows = []
        for i in range(0, len(values), 100):
            rows += self.get(table, {"select": select, column: f"in.({','.join(values[i:i + 100])})"})
        return rows


def read_platform(platform):
    data = {
        "deals": platform.get("deals", {"select": "id,status,created_at,cancelled_at,agreed_amount,agreed_currency,"
                                                  "supplier_account_id,counterparty_account_id"}),
        "payments": platform.get("deal_payment_intents", {"select": "deal_id,status,payment_purpose,captured_at,"
                                                                    "deal_amount,currency"}),
        "offers": platform.get("purchase_offers", {"select": "created_at,buyer_account_id,listing_id"}),
        "chats": platform.get("conversations", {"select": "created_at,conversation_type,counterparty_account_id"}),
        "bids": platform.get("auction_submissions", {"select": "created_at,email"}),
        "listings": platform.get("listings", {"select": "id,listing_status,created_at,supplier_account_id"}),
        "requests": platform.get("battery_requests", {"select": "created_at,status,contact_email"}),
    }
    # Only buyers are checked against staff emails, so only their members are read.
    ids = {deal["counterparty_account_id"] for deal in data["deals"]}
    ids |= {row["buyer_account_id"] for row in data["offers"]}
    ids |= {row["counterparty_account_id"] for row in data["chats"]}
    ids.discard(None)
    memberships = platform.get_in("account_memberships", "account_id,user_id", "account_id", ids)
    users = platform.get_in("users", "id,email", "id", [m["user_id"] for m in memberships])
    email = {user["id"]: user["email"] for user in users}
    data["account_emails"] = defaultdict(list)
    for membership in memberships:
        if membership["user_id"] in email:
            data["account_emails"][membership["account_id"]].append(email[membership["user_id"]])
    return data


def posthog_credentials(path=POSTHOG_CREDENTIALS):
    value = json.loads(path.read_text())
    if value.get("env_id") != POSTHOG_PROJECT or not value.get("token"):
        raise RuntimeError("PostHog credentials are not for project 375247")
    return value["host"].rstrip("/"), value["token"]


def read_posthog(start, end, credentials=None, attempts=3):
    """{week: {metric: people}} for [start, end), Mondays only."""
    host, token = credentials or posthog_credentials()
    query = POSTHOG_QUERY.format(start=f"{start} 00:00:00", end=f"{end} 00:00:00").replace("{{filters}}", "{filters}")
    body = json.dumps({"query": {"kind": "HogQLQuery", "filters": {"filterTestAccounts": True}, "query": query}}).encode()
    for attempt in range(attempts):
        request = urllib.request.Request(f"{host}/api/projects/{POSTHOG_PROJECT}/query/", data=body, method="POST",
                                         headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                payload = json.load(response)
            break
        except urllib.error.HTTPError as err:
            # PostHog answers 503 now and then under load; try again a little later.
            if err.code < 500 or attempt == attempts - 1:
                raise
            time.sleep(10 * (attempt + 1))
    columns = payload["columns"]
    weeks = {}
    for row in payload["results"]:
        values = dict(zip(columns, row))
        weeks[dt.date.fromisoformat(values["week"][:10])] = {metric: int(values[metric]) for metric in POSTHOG_METRICS}
    return weeks


# ---------------------------------------------------------------------------
# Counting
# ---------------------------------------------------------------------------

def platform_metrics(data, weeks, today, exclusions):
    """{week: {metric: value}} for the given Mondays from platform rows."""
    pattern, test_ids = exclusions

    def internal_email(address):
        return bool(address) and bool(pattern.search(address))

    def internal_buyer(account_id):
        return account_id in test_ids or any(internal_email(e) for e in data["account_emails"].get(account_id, ()))

    wanted = set(weeks)
    out = {week: defaultdict(float) for week in weeks}

    def add(metric, timestamp, amount=1):
        week = week_of(timestamp)
        if week in wanted:
            out[week][metric] += amount

    real_deals = {d["id"]: d for d in data["deals"]
                  if d["supplier_account_id"] not in test_ids and not internal_buyer(d["counterparty_account_id"])}
    for deal in real_deals.values():
        add("deals_created", deal["created_at"])
        if deal["status"] == "cancelled":
            add("deals_cancelled", deal["cancelled_at"] or deal["created_at"])
    paid = {}
    for payment in data["payments"]:
        if payment["deal_id"] in real_deals and payment["status"] == "captured" and payment["payment_purpose"] == "initial":
            paid.setdefault(payment["deal_id"], payment)
    for payment in paid.values():
        add("deals_paid", payment["captured_at"])
        add("paid_value_gbp", payment["captured_at"],
            float(payment["deal_amount"] or 0) * GBP_PER.get((payment["currency"] or "GBP").upper(), 1.0))

    listing_supplier = {row["id"]: row["supplier_account_id"] for row in data["listings"]}
    for offer in data["offers"]:
        if not internal_buyer(offer["buyer_account_id"]) and listing_supplier.get(offer["listing_id"]) not in test_ids:
            add("offers_made", offer["created_at"])
    for chat in data["chats"]:
        if chat["conversation_type"] in CONTACT_TYPES and not internal_buyer(chat["counterparty_account_id"]):
            add("buyer_chats", chat["created_at"])
    for bid in data["bids"]:
        if not internal_email(bid["email"]):
            add("auction_bids", bid["created_at"])
    real_listings = [row for row in data["listings"] if row["supplier_account_id"] not in test_ids]
    for listing in real_listings:
        if listing["listing_status"] != "draft":
            add("listings_new", listing["created_at"])
    current = monday(today)
    if current in wanted:
        out[current]["listings_live"] = sum(1 for row in real_listings if row["listing_status"] == "published")
    for request in data["requests"]:
        if request["status"] != "test" and not internal_email(request["contact_email"]):
            add("sell_requests", request["created_at"])

    zero = ("deals_created", "deals_paid", "paid_value_gbp", "deals_cancelled", "offers_made", "buyer_chats",
            "auction_bids", "listings_new", "sell_requests")
    return {week: {**{metric: 0 for metric in zero}, **{k: round(v, 2) for k, v in values.items()}}
            for week, values in out.items()}


# ---------------------------------------------------------------------------
# Writing
# ---------------------------------------------------------------------------

def write(conn, numbers):
    with conn.cursor() as cur:
        for week, metrics in numbers.items():
            for metric, value in metrics.items():
                cur.execute(
                    """insert into crm_metric_snapshots (week_start, metric, value, collected_at)
                       values (%s, %s, %s, now())
                       on conflict (week_start, metric) do update set value = excluded.value, collected_at = now()""",
                    (week, metric, value))
    conn.commit()


def collect(args, today):
    first = dt.date.fromisoformat(args.since) if args.since else monday(today) - dt.timedelta(days=7)
    weeks = weeks_from(first, today)
    numbers = platform_metrics(read_platform(Platform()), weeks, today, load_exclusions())
    posthog_error = None
    try:
        people = read_posthog(weeks[0], monday(today) + dt.timedelta(days=7))
        for week in weeks:
            numbers[week].update(people.get(week, {metric: 0 for metric in POSTHOG_METRICS}))
    except Exception as err:  # noqa: BLE001 - the platform numbers are still worth writing
        posthog_error = f"PostHog read failed: {err}"
    return numbers, posthog_error


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dsn", default="host=/var/run/postgresql dbname=denchclaw")
    parser.add_argument("--since", help="backfill from the week of this date (YYYY-MM-DD)")
    parser.add_argument("--dry-run", action="store_true", help="print the numbers and write nothing")
    args = parser.parse_args()
    today = dt.datetime.now(dt.timezone.utc).date()
    numbers, posthog_error = collect(args, today)
    if args.dry_run:
        for week, metrics in numbers.items():
            print(week, json.dumps(metrics, sort_keys=True))
    else:
        conn = psycopg2.connect(args.dsn)
        try:
            write(conn, numbers)
        finally:
            conn.close()
        print(f"Wrote {sum(len(m) for m in numbers.values())} numbers for {len(numbers)} weeks.")
    if posthog_error:
        print(posthog_error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
