#!/usr/bin/env python3
"""Loads a reviewed list of buyer demand into Bulk Trades (crm_bulk_trade_demand).

  load_demand_seed.py FILE.json            # show what would be added
  load_demand_seed.py FILE.json --apply    # add it

FILE holds {"rows": [{buyer, contact, email, wants, quantity, where, confirmed, source}]}. Each row is
linked to a CRM person by email and a CRM company by name where one exists. A row whose buyer
already has an open demand row with the same wants is skipped, so a re-run adds nothing twice.
"""
import argparse
import json
import sys
import uuid

import psycopg2
import psycopg2.extras


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("file")
    parser.add_argument("--dsn", default="host=/var/run/postgresql dbname=denchclaw")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    rows = json.load(open(args.file))["rows"]
    conn = psycopg2.connect(args.dsn)
    added = 0
    with conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        for row in rows:
            buyer = row["buyer"].strip("[]")
            email = (row.get("email") or "").strip().lower() or None
            cur.execute("select 1 from crm_bulk_trade_demand where status = 'open' and lower(buyer) = lower(%s) and lower(wants) = lower(%s)",
                        (buyer, row["wants"]))
            if cur.fetchone():
                print("skip (already there):", buyer)
                continue
            cur.execute("select id, company_id from crm_people where lower(email) = %s order by updated_at desc nulls last limit 1", (email,))
            person = cur.fetchone() if email else None
            cur.execute("select id from crm_companies where lower(name) = lower(%s) limit 1", (buyer,))
            company = cur.fetchone()
            company_id = (company and company["id"]) or (person and person["company_id"])
            print(f"add: {buyer} | {row['wants'][:70]} | person {'yes' if person else 'no'} | company {'yes' if company_id else 'no'}")
            if args.apply:
                cur.execute(
                    """insert into crm_bulk_trade_demand (id, buyer, company_id, person_id, contact, email, wants, quantity, location,
                         source_label, confirmed_on) values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                    (f"btd_{uuid.uuid4()}", buyer, company_id, person and person["id"], row.get("contact"), email, row["wants"],
                     row.get("quantity"), row.get("where"), row.get("source"), row.get("confirmed")))
            added += 1
        if not args.apply:
            conn.rollback()
    print(f"{'added' if args.apply else 'would add'} {added} of {len(rows)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
