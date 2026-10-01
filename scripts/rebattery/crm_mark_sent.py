#!/usr/bin/env python3
"""Records an intro or supply update email that was sent outside the campaign tool (for example from Gmail), the
same way the campaign send trigger does (migration 026):

  crm_mark_sent.py SEND_LIST.csv --how "Intro email 2026-10-02 (Gmail)" [--commit]

SEND_LIST.csv needs a person_id column. Each person becomes Subscribed to the Supply update list unless they already
have a Supply update row (an Opted out is never overwritten), subscribed people get the "Supply Update" tag, and their
company moves from New to Contacted. Dry run unless --commit. Run it only after the email has actually gone out.
"""
import argparse
import csv
import os
import sys

import psycopg2


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("send_list")
    ap.add_argument("--how", required=True, help="what was sent, e.g. 'Intro email 2026-10-02 (Gmail)'")
    ap.add_argument("--commit", action="store_true")
    args = ap.parse_args()
    people = sorted({r["person_id"] for r in csv.DictReader(open(args.send_list)) if r.get("person_id")})
    if not people:
        sys.exit("no person_id values in the send list")
    conn = psycopg2.connect(os.environ.get("DENCH_CRM_DSN", "host=/var/run/postgresql dbname=denchclaw"))
    cur = conn.cursor()
    cur.execute("select count(*) from crm_people where id = any(%s)", (people,))
    found = cur.fetchone()[0]
    cur.execute("""insert into crm_subscriptions (person_id, list, status, since, how)
                   select id, 'Supply update', 'Subscribed', current_date, %s from crm_people where id = any(%s)
                   on conflict (person_id, list) do nothing""", (args.how, people))
    subscribed = cur.rowcount
    cur.execute("""update crm_people p set tags = array(select distinct unnest(coalesce(p.tags, '{}') || array['Supply Update'])),
                     updated_at = now()
                   from crm_subscriptions s
                   where s.person_id = p.id and s.list = 'Supply update' and s.status = 'Subscribed'
                     and p.id = any(%s) and not (coalesce(p.tags, '{}') @> array['Supply Update'])""", (people,))
    tagged = cur.rowcount
    cur.execute("""update crm_companies set relationship_stage = 'Contacted', updated_at = now()
                   where relationship_stage = 'New' and id in (select company_id from crm_people where id = any(%s))""", (people,))
    contacted = cur.rowcount
    print(f"{len(people)} in the list, {found} found in the CRM: {subscribed} newly subscribed, {tagged} tagged, "
          f"{contacted} companies moved New -> Contacted")
    if args.commit:
        conn.commit(); print("COMMITTED")
    else:
        conn.rollback(); print("dry run, rolled back")


if __name__ == "__main__":
    main()
