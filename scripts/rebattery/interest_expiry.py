#!/usr/bin/env python3
"""Report buyer_interest lines whose expires_on has passed since the last run (foundation step 1c-0, used by 1d).

Expiry is time-based, not a write: a line is expired when expires_on <= today (London), exactly as
apps/web/lib/crm-postgres/buyer-interest.ts reads it. This job only reports which lines crossed that date since the
previous run, so the 1d regeneration knows which companies' buy boxes to rebuild. It writes nothing to the database
(the session is read-only) and is not scheduled; scheduling needs approval.

The previous run date is kept in a small state file (--state). Without one, the window starts at --since or, for
a first run, at yesterday. A dry look that must not move the window uses --no-state-update.

  interest_expiry.py --dsn <dsn> [--since YYYY-MM-DD] [--state FILE] [--json] [--no-state-update]
"""
import argparse
import collections
import datetime as dt
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from backfill_buyer_interest import DEFAULT_DSN  # noqa: E402

DEFAULT_STATE = "/root/.hermes/workspace/buyer-dossiers-pilot/foundation/interest-expiry-state.json"

EXPIRED_SQL = """
select i.id, i.company_id, c.name as company, i.kind, i.product_key, i.first_seen, i.last_seen, i.expires_on
  from buyer_interest i left join crm_companies c on c.id = i.company_id
 where i.expires_on > %(since)s and i.expires_on <= %(today)s
 order by i.expires_on, i.company_id, i.id
"""


def read_state(path):
    try:
        return dt.date.fromisoformat(json.loads(Path(path).read_text())["last_run"])
    except (OSError, ValueError, KeyError):
        return None


def window(today, since_arg, state_date):
    """Lines with expires_on after `since` and up to today. A window never runs backwards."""
    since = since_arg or state_date or (today - dt.timedelta(days=1))
    return min(since, today)


def summarise(rows):
    return {"lines": len(rows),
            "by_kind": dict(collections.Counter(r["kind"] for r in rows)),
            "companies": sorted({r["company_id"] for r in rows})}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Report buyer_interest lines that expired since the last run.")
    parser.add_argument("--dsn", help="connection string (default: the local CRM, read-only)")
    parser.add_argument("--since", help="report expiries after this date instead of the last run")
    parser.add_argument("--today", help="treat this as today (default: today in London)")
    parser.add_argument("--state", default=DEFAULT_STATE)
    parser.add_argument("--no-state-update", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    import psycopg2
    import psycopg2.extras
    conn = psycopg2.connect(args.dsn or DEFAULT_DSN)
    conn.set_session(readonly=True, autocommit=False)
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("select (now() at time zone 'Europe/London')::date as today")
            today = dt.date.fromisoformat(args.today) if args.today else cur.fetchone()["today"]
            since = window(today, dt.date.fromisoformat(args.since) if args.since else None, read_state(args.state))
            cur.execute(EXPIRED_SQL, {"since": since, "today": today})
            rows = cur.fetchall()
    finally:
        conn.rollback()
        conn.close()

    summary = summarise(rows)
    if args.json:
        print(json.dumps({"since": str(since), "today": str(today), **summary,
                          "expired": [{k: str(v) for k, v in r.items()} for r in rows]}, indent=2))
    else:
        print(f"expired after {since} up to {today}: {summary['lines']} lines {summary['by_kind']} "
              f"at {len(summary['companies'])} companies")
        for r in rows[:50]:
            print(f"  {r['expires_on']} {r['kind']:<9} {r['product_key']} ({r['company'] or r['company_id']}), last seen {r['last_seen']}")
        if len(rows) > 50:
            print(f"  ... and {len(rows) - 50} more (use --json)")
    if not args.no_state_update:
        Path(args.state).parent.mkdir(parents=True, exist_ok=True)
        Path(args.state).write_text(json.dumps({"last_run": str(today)}), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
