#!/usr/bin/env python3
"""Load a reviewed dismantler outreach cohort into the CRM, then write the campaign's recipient variables.

Input is a JSON list, one entry per recipient:
  {"email", "company_name", "country", "city_or_region", "website", "first_name" (a real contact's name or null),
   "verification" ("valid" or the verifier's verdict), "notes", "vars": {"name": "reviewed text", ...},
   "packs": [{"make", "model", "year", "part_number", "quantity", "price", "currency", "description",
              "location", "url", "checked_at"}]}

Each recipient is matched to the CRM by email, then company domain or website, then exact company name. Only what
is missing is created: the company (tagged dismantler), the person, the Dismantlers row (Found, logged as
'imported') and one unverified crm_stock_items row per pack seen. Existing values are never overwritten; empty
country, website and source fields are filled. The person's email_verified follows the verification verdict.

Dry run by default. --apply writes everything in one transaction. Either way it writes recipient_variables.json
and cohort.json (named and unnamed person ids, verified addresses only) next to --out.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import urllib.parse
from pathlib import Path

import psycopg2
from psycopg2.extras import RealDictCursor

SOURCE = "Outreach Oct 2026"
REGIONS = {"United Kingdom": "UK", "UK": "UK", "Norway": "Nordics", "Sweden": "Nordics", "Denmark": "Nordics",
           "Finland": "Nordics", "Lithuania": "CEE", "Latvia": "CEE", "Estonia": "CEE", "Poland": "CEE",
           "Czech Republic": "CEE", "Czechia": "CEE", "Slovakia": "CEE", "Hungary": "CEE", "Romania": "CEE"}


def stable_id(prefix: str, value: str) -> str:
    return f"{prefix}_{hashlib.sha256(value.encode()).hexdigest()[:20]}"


def domain_of(entry: dict) -> str:
    return entry["email"].split("@", 1)[1].lower()


def site_host(website: str | None) -> str | None:
    if not website:
        return None
    host = urllib.parse.urlparse(website if "://" in website else f"https://{website}").hostname or ""
    return host.lower().removeprefix("www.") or None


def validate(entries: list[dict]) -> None:
    emails = [entry.get("email", "").strip().lower() for entry in entries]
    if len(set(emails)) != len(emails) or any("@" not in email for email in emails):
        raise ValueError("Every entry needs a distinct email address")
    names = {frozenset(entry.get("vars", {})) for entry in entries}
    if len(names) != 1 or not next(iter(names)):
        raise ValueError("Every entry needs the same nonempty set of vars")
    for entry in entries:
        if not (entry.get("company_name") or "").strip():
            raise ValueError(f"Missing company_name: {entry['email']}")
        if any(not isinstance(value, str) or not value.strip() for value in entry["vars"].values()):
            raise ValueError(f"Empty campaign text: {entry['email']}")
        for pack in entry.get("packs", []):
            if not pack.get("url") or not (pack.get("make") or pack.get("part_number")):
                raise ValueError(f"Each pack needs a source url and a make or part number: {entry['email']}")


def match(cur, entry: dict) -> dict:
    email = entry["email"].strip().lower()
    cur.execute("select id, company_id from crm_people where lower(btrim(email)) = %s", (email,))
    people = cur.fetchall()
    if len(people) > 1:
        raise ValueError(f"Several CRM people have {email}")
    person = people[0] if people else None
    company_ids = set()
    if person and person["company_id"]:
        company_ids.add(person["company_id"])
    else:
        hosts = {domain_of(entry), site_host(entry.get("website"))} - {None}
        for host in hosts:
            cur.execute("""select id from crm_companies
                            where lower(domain) = %s or lower(regexp_replace(website, '^(https?://)?(www\\.)?', '')) like %s""",
                        (host, host + "%"))
            company_ids.update(row["id"] for row in cur.fetchall())
        if not company_ids:
            cur.execute("select id from crm_companies where lower(btrim(name)) = lower(btrim(%s))", (entry["company_name"],))
            company_ids.update(row["id"] for row in cur.fetchall())
    if len(company_ids) > 1:
        raise ValueError(f"Several CRM companies match {email}: {sorted(company_ids)}")
    company_id = next(iter(company_ids), None)
    dismantler = None
    if company_id:
        cur.execute("select id, stage, country, source from crm_dismantlers where company_id = %s", (company_id,))
        dismantler = cur.fetchone()
    return {"person": person, "company_id": company_id, "dismantler": dismantler}


def stock_rows(entry: dict, supplier: str) -> list[dict]:
    rows = []
    for pack in entry.get("packs", []):
        key = "|".join(str(pack.get(field) or "") for field in ("url", "part_number", "make", "model", "year"))
        rows.append({
            "supplier": supplier,
            "stock_id": stable_id("web", key),
            "make": pack.get("make"), "model": pack.get("model"), "year": str(pack["year"]) if pack.get("year") else None,
            "part_number": pack.get("part_number"), "description": pack.get("description"),
            "quantity": pack.get("quantity") or 1, "price": pack.get("price"), "location": pack.get("location"),
            "evidence": {"url": pack["url"], "currency": pack.get("currency"), "checked_at": pack.get("checked_at"),
                         "source": f"Web research for {SOURCE}"},
        })
    return rows


def plan_and_apply(entries: list[dict], apply: bool) -> list[dict]:
    db = psycopg2.connect(os.environ.get("DENCH_CAMPAIGN_DSN", "dbname=denchclaw"))
    db.set_session(readonly=not apply)
    results = []
    try:
        with db, db.cursor(cursor_factory=RealDictCursor) as cur:
            # email_verified exists in production but not in the repository schema.
            cur.execute("""select 1 from information_schema.columns
                            where table_name = 'crm_people' and column_name = 'email_verified'""")
            has_verified = bool(cur.fetchone())
            for entry in entries:
                found = match(cur, entry)
                email = entry["email"].strip().lower()
                company_id = found["company_id"] or stable_id("company_outreach", domain_of(entry))
                person_id = found["person"]["id"] if found["person"] else stable_id("person_outreach", email)
                if found["company_id"]:
                    cur.execute("select name from crm_companies where id = %s", (company_id,))
                    supplier = cur.fetchone()["name"]
                else:
                    supplier = entry["company_name"].strip()
                verified = entry.get("verification") == "valid"
                result = {
                    "email": email, "company": supplier, "company_id": company_id, "person_id": person_id,
                    "first_name": entry.get("first_name") or None, "verified": verified,
                    "actions": [], "vars": entry["vars"],
                }
                if not found["company_id"]:
                    result["actions"].append("new company")
                if not found["person"]:
                    result["actions"].append("new person")
                if not found["dismantler"]:
                    result["actions"].append("new dismantler")
                stock = stock_rows(entry, supplier)
                if stock:
                    result["actions"].append(f"{len(stock)} stock rows")
                results.append(result)
                if not apply:
                    continue

                if not found["company_id"]:
                    cur.execute("""insert into crm_companies (id, name, domain, website, country, city, region, tags,
                                       purpose, segment, source, source_detail, relationship_stage, notes)
                                   values (%s,%s,%s,%s,%s,%s,%s,array['dismantler'],array['Dismantler'],
                                           'Salvage / dismantler','Web research',%s,'New',%s)""",
                                (company_id, supplier, domain_of(entry), entry.get("website"), entry.get("country"),
                                 entry.get("city_or_region"), REGIONS.get(entry.get("country") or "", "EU-West"),
                                 f"{SOURCE}: cold draft 25 Aug 2026, researched 15 Oct", entry.get("notes")))
                else:
                    cur.execute("""update crm_companies
                                      set tags = array(select distinct unnest(coalesce(tags, '{}') || array['dismantler'])),
                                          website = coalesce(nullif(website, ''), %s), country = coalesce(nullif(country, ''), %s),
                                          segment = coalesce(segment, 'Salvage / dismantler'), updated_at = now()
                                    where id = %s""", (entry.get("website"), entry.get("country"), company_id))
                if not found["person"]:
                    first = entry.get("first_name") or None
                    cur.execute("""insert into crm_people (id, company_id, first_name, full_name, email, notes)
                                   values (%s,%s,%s,%s,%s,%s)""",
                                (person_id, company_id, first, first, email, f"{SOURCE}: address from the 25 Aug cold draft"))
                    if has_verified:
                        cur.execute("update crm_people set email_verified = %s where id = %s", (verified, person_id))
                else:
                    # Only a definite verdict changes an existing person's flag.
                    verdict = {"valid": True, "invalid": False}.get(entry.get("verification"))
                    cur.execute("""update crm_people set company_id = coalesce(company_id, %s), updated_at = now()
                                    where id = %s""", (company_id, person_id))
                    if has_verified and verdict is not None:
                        cur.execute("update crm_people set email_verified = %s where id = %s", (verdict, person_id))
                if not found["dismantler"]:
                    cur.execute("""insert into crm_dismantlers (company_id, country, source, notes)
                                   values (%s,%s,%s,%s) returning id""",
                                (company_id, entry.get("country"), SOURCE, entry.get("notes")))
                    dismantler_id = cur.fetchone()["id"]
                    cur.execute("""insert into crm_dismantler_events (dismantler_id, kind, changes)
                                   values (%s,'imported',%s)""",
                                (dismantler_id, json.dumps({"stage": "Found", "source": SOURCE, "country": entry.get("country"),
                                                            "notes": entry.get("notes")})))
                else:
                    cur.execute("""update crm_dismantlers set country = coalesce(country, %s), source = coalesce(source, %s),
                                          updated_at = now() where id = %s""",
                                (entry.get("country"), SOURCE, found["dismantler"]["id"]))
                for row in stock:
                    cur.execute("""insert into crm_stock_items (id, supplier, stock_id, make, model, year, part_number,
                                       description, quantity, price, location, evidence, stock_status)
                                   values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,'unverified')
                                   on conflict (supplier, stock_id) do nothing""",
                                (stable_id("stock", row["supplier"] + row["stock_id"]), row["supplier"], row["stock_id"],
                                 row["make"], row["model"], row["year"], row["part_number"], row["description"],
                                 row["quantity"], row["price"], row["location"], json.dumps(row["evidence"])))
    finally:
        db.close()
    return results


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--input", required=True, help="Reviewed recipients JSON")
    parser.add_argument("--out", required=True, help="Directory for recipient_variables.json and cohort.json")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    try:
        entries = json.loads(Path(args.input).read_text())
        validate(entries)
        results = plan_and_apply(entries, args.apply)
    except (ValueError, psycopg2.Error) as exc:
        print(f"Load stopped: {exc}", file=sys.stderr)
        return 1
    out = Path(args.out)
    sendable = [result for result in results if result["verified"]]
    (out / "recipient_variables.json").write_text(json.dumps(
        {result["person_id"]: result["vars"] for result in sendable}, indent=2, ensure_ascii=False))
    (out / "cohort.json").write_text(json.dumps({
        "named": sorted(result["person_id"] for result in sendable if result["first_name"]),
        "unnamed": sorted(result["person_id"] for result in sendable if not result["first_name"]),
        "held_unverified": sorted(result["email"] for result in results if not result["verified"]),
    }, indent=2))
    print(json.dumps({"dry_run": not args.apply, "recipients": [
        {key: result[key] for key in ("email", "company", "person_id", "verified", "actions")} for result in results]},
        indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
