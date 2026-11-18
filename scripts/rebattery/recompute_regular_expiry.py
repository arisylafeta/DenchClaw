#!/usr/bin/env python3
"""Recompute the expiry of every Regular Want (buyer_interest kind 'standing').

A Regular Want lasts 1 year from the LATEST of: the date it was last said (last_seen), the latest date the buyer
bought the same product from us (a 'bought' line of the same company and product_key), and the dossier's
frontmatter last_verified. This sets expires_on = that date + 365 days for every standing line.

Dry run by default: a read-only session, prints counts (changed lines, how many become live again, per company
top 20) and writes nothing. --apply needs --dsn, refuses a connection to the database named denchclaw without
--i-have-approval, runs in one transaction with lock_timeout 3s, and first archives the old expires_on of every
changed line in buyer_interest_expiry_pre_20261118.

  recompute_regular_expiry.py --dsn <dsn>                          # dry run
  recompute_regular_expiry.py --dsn <dsn> --apply [--i-have-approval]
"""
import argparse
import collections
import datetime as dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import buyer_dossier  # noqa: E402

STANDING_DAYS = 365
ARCHIVE_TABLE = "buyer_interest_expiry_pre_20261118"
PRODUCTION_DATABASE = "denchclaw"
DEFAULT_DSN = "host=/var/run/postgresql dbname=denchclaw"


def refusal_for_apply(db_name, approved):
    if (db_name or "").strip().lower() == PRODUCTION_DATABASE and not approved:
        return (f"the connection is to the database '{db_name}', the live CRM name; refusing to apply without "
                "--i-have-approval")
    return None


def _date(value):
    try:
        return dt.date.fromisoformat(str(value)[:10]) if value else None
    except ValueError:
        return None


def verified_dates(cur, company_ids):
    """company id -> the dossier's frontmatter last_verified, for companies that have a dossier."""
    cur.execute("select id, buyer_dossier from crm_companies where id = any(%s) and coalesce(buyer_dossier, '') <> ''",
                (list(company_ids),))
    out = {}
    for row in cur.fetchall():
        frontmatter, _body = buyer_dossier.parse(row["buyer_dossier"])
        verified = _date((frontmatter or {}).get("last_verified"))
        if verified:
            out[row["id"]] = verified
    return out


def new_expiry(last_seen, last_bought, last_verified):
    anchor = max(d for d in (last_seen, last_bought, last_verified) if d)
    return anchor + dt.timedelta(days=STANDING_DAYS)


def plan(cur):
    """Every standing line with its recomputed expiry: a list of dicts."""
    cur.execute("select current_date as today")
    today = cur.fetchone()["today"]
    cur.execute("""select w.id, w.company_id, w.product_key, w.last_seen, w.expires_on,
                          (select max(b.last_seen) from buyer_interest b
                            where b.company_id = w.company_id and b.product_key = w.product_key
                              and b.kind = 'bought') as last_bought,
                          c.name as company
                     from buyer_interest w left join crm_companies c on c.id = w.company_id
                    where w.kind = 'standing' order by w.company_id, w.product_key""")
    lines = cur.fetchall()
    verified = verified_dates(cur, {line["company_id"] for line in lines})
    for line in lines:
        line["last_verified"] = verified.get(line["company_id"])
        line["new_expires_on"] = new_expiry(line["last_seen"], line["last_bought"], line["last_verified"])
        line["changed"] = line["new_expires_on"] != line["expires_on"]
        line["live_before"] = bool(line["expires_on"] and line["expires_on"] >= today)
        line["live_after"] = line["new_expires_on"] >= today
    return today, lines


def summarise(today, lines):
    changed = [line for line in lines if line["changed"]]
    revived = [line for line in lines if line["live_after"] and not line["live_before"]]
    per_company = collections.Counter((line["company_id"], line["company"]) for line in revived)
    return {
        "today": today, "standing": len(lines), "changed": len(changed),
        "live_before": sum(line["live_before"] for line in lines),
        "live_after": sum(line["live_after"] for line in lines),
        "live_again": len(revived),
        "shortened": sum(1 for line in changed if line["expires_on"] and line["new_expires_on"] < line["expires_on"]),
        "no_expiry_before": sum(1 for line in lines if line["expires_on"] is None),
        "top_companies": per_company.most_common(20),
    }


def print_summary(s):
    print(f"standing lines {s['standing']}; expiry would change on {s['changed']}"
          f" ({s['shortened']} shortened, {s['no_expiry_before']} had no expiry)")
    print(f"live today (expires on or after {s['today']}): before {s['live_before']} -> after {s['live_after']};"
          f" {s['live_again']} become live again")
    print("per company, lines that become live again (top 20):")
    for (company_id, name), n in s["top_companies"]:
        print(f"  {n:>4}  {name or '(no name)'} [{company_id}]")


def apply(cur, lines):
    cur.execute("set local lock_timeout = '3s'")
    cur.execute(f"""create table if not exists {ARCHIVE_TABLE} (
                      id text primary key, company_id text, product_key text,
                      old_expires_on date, new_expires_on date, archived_at timestamptz not null default now())""")
    changed = [line for line in lines if line["changed"]]
    for line in changed:
        cur.execute(f"""insert into {ARCHIVE_TABLE} (id, company_id, product_key, old_expires_on, new_expires_on)
                        values (%s, %s, %s, %s, %s) on conflict (id) do nothing""",
                    (line["id"], line["company_id"], line["product_key"], line["expires_on"], line["new_expires_on"]))
    for line in changed:
        cur.execute("update buyer_interest set expires_on = %s, updated_at = now() where id = %s and kind = 'standing'",
                    (line["new_expires_on"], line["id"]))
    return len(changed)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--dsn", help="connection string (required with --apply)")
    parser.add_argument("--apply", action="store_true", help="write; without it the session is read-only")
    parser.add_argument("--i-have-approval", action="store_true", help="allow --apply on the database named denchclaw")
    args = parser.parse_args(argv)
    if args.apply and not args.dsn:
        parser.error("--apply needs an explicit --dsn")

    import psycopg2
    import psycopg2.extras
    conn = psycopg2.connect(args.dsn or DEFAULT_DSN)
    conn.set_session(readonly=not args.apply, autocommit=False)  # a dry run cannot write
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("select current_database() as db")
            db = cur.fetchone()["db"]
            print(f"database {db}: {'apply' if args.apply else 'dry run (read-only session)'}")
            if args.apply:
                why = refusal_for_apply(db, args.i_have_approval)
                if why:
                    parser.error(why)
            today, lines = plan(cur)
            print_summary(summarise(today, lines))
            if args.apply:
                print(f"updated {apply(cur, lines)} lines; old expiry archived in {ARCHIVE_TABLE}")
                conn.commit()
    finally:
        conn.rollback()
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
