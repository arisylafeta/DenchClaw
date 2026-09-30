#!/usr/bin/env python3
"""Loads a reviewed list of dismantlers into the Dismantlers tab (crm_dismantlers).

  load_dismantler_seed.py FILE.json            # show what would happen, change nothing
  load_dismantler_seed.py FILE.json --apply    # add them, in one transaction

FILE holds {"rows": [...]}. Each row has a name and optionally: company (an exact CRM company
name to link), rename_to (a clearer name for that company), country, ebay_username,
ebay_listings, route, stage, goal, next_step, next_step_due, waiting_on, waiting_since,
person_email (who the next step is for), source and notes.

Every dismantler is a CRM company: the named company, else the one company with the row's exact
name, else a new company. A name several companies share stops the run. A company that is
already a dismantler is skipped, so a re-run adds nothing twice. Each row is logged in
crm_dismantler_events as 'imported'.
"""
import argparse
import datetime
import json
import sys
import uuid
from zoneinfo import ZoneInfo

import psycopg2
import psycopg2.extras

STAGES = {"Found", "Contacted", "Onboarding", "Live", "Syncing", "Parked"}
ROUTES = {"eBay", "API", "Other", None}
FIELDS = ["country", "ebay_username", "ebay_listings", "route", "stage", "goal", "next_step",
          "next_step_due", "waiting_on", "waiting_since", "source", "notes"]


def company_for(cur, row):
    wanted = row.get("company") or row["name"]
    cur.execute("select id, name, country from crm_companies where lower(btrim(name)) = lower(btrim(%s))", (wanted,))
    found = cur.fetchall()
    if len(found) > 1:
        raise SystemExit(f"Several CRM companies are called {wanted!r}. Name one exactly in 'company'.")
    if row.get("company") and not found:
        raise SystemExit(f"No CRM company called {row['company']!r}.")
    return found[0] if found else None


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("file")
    parser.add_argument("--dsn", default="host=/var/run/postgresql dbname=denchclaw")
    parser.add_argument("--actor", default="alex@rebattery.io", help="CRM user the history is logged as")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    rows = json.load(open(args.file))["rows"]
    today = datetime.datetime.now(ZoneInfo("Europe/London")).date().isoformat()

    conn = psycopg2.connect(args.dsn)
    counts = {"new company": 0, "existing company": 0, "skipped": 0}
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("select id from crm_users where email = %s", (args.actor,))
        actor = (cur.fetchone() or {}).get("id")
        if not actor:
            raise SystemExit(f"No CRM user {args.actor}.")
        for row in rows:
            stage = row.get("stage", "Found")
            if stage not in STAGES or row.get("route") not in ROUTES:
                raise SystemExit(f"{row['name']}: bad stage or route.")
            company = company_for(cur, row)
            if company:
                cur.execute("select 1 from crm_dismantlers where company_id = %s", (company["id"],))
                if cur.fetchone():
                    counts["skipped"] += 1
                    print(f"skip   {row['name']}: already a dismantler")
                    continue
                company_id, action = company["id"], "existing company"
            else:
                company_id, action = str(uuid.uuid4()), "new company"
                cur.execute("insert into crm_companies (id, name, country) values (%s, %s, %s)",
                            (company_id, row["name"], row.get("country")))
            if row.get("rename_to"):
                cur.execute("update crm_companies set name = %s, updated_at = now() where id = %s", (row["rename_to"], company_id))
            cur.execute("""update crm_companies set tags = array_append(coalesce(tags, '{}'), 'dismantler'), updated_at = now()
                            where id = %s and not ('dismantler' = any(coalesce(tags, '{}')))""", (company_id,))

            person_id = None
            if row.get("person_email"):
                cur.execute("select id from crm_people where lower(email) = lower(%s) and company_id = %s", (row["person_email"], company_id))
                person_id = (cur.fetchone() or {}).get("id")
            values = {key: row[key] for key in FIELDS if row.get(key) is not None}
            values.setdefault("stage", "Found")
            values.setdefault("country", (company or {}).get("country"))
            if values.get("waiting_on") == "them":
                values.setdefault("waiting_since", today)
            values["next_step_person_id"] = person_id
            values = {key: value for key, value in values.items() if value is not None}
            dismantler_id = f"dm_{uuid.uuid4()}"
            columns = ["id", "company_id", "stage_since", *values]
            cur.execute(
                f"insert into crm_dismantlers ({', '.join(columns)}) values ({', '.join(['%s'] * len(columns))})",
                [dismantler_id, company_id, today, *values.values()],
            )
            cur.execute("insert into crm_dismantler_events (dismantler_id, kind, changes, actor_user_id) values (%s, 'imported', %s, %s)",
                        (dismantler_id, json.dumps({**values, "source_file": args.file.rsplit('/', 1)[-1]}, default=str), actor))
            counts[action] += 1
            shown = row.get("rename_to") or (company or {}).get("name") or row["name"]
            rename = f" (renamed from {company['name']})" if row.get("rename_to") and company else ""
            who = f" · for {row['person_email']}" + ("" if person_id else " (NOT FOUND at company)") if row.get("person_email") else ""
            print(f"{'link ' if company else 'new  '} {stage:<10} {shown}{rename} · {values.get('country') or '?'}"
                  f"{' · goal' if row.get('goal') else ''}{' · ' + row['next_step'] if row.get('next_step') else ''}"
                  f"{' · due ' + row['next_step_due'] if row.get('next_step_due') else ''}{who}")

    print(f"\n{counts['new company']} new companies, {counts['existing company']} linked to existing companies, {counts['skipped']} skipped.")
    if args.apply:
        conn.commit()
        print("Applied.")
    else:
        conn.rollback()
        print("Dry run: nothing changed. Re-run with --apply to add them.")


if __name__ == "__main__":
    sys.exit(main())
