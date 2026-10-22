#!/usr/bin/env python3
"""Keeps crm_stock_opportunities in step with the ReBattery marketplace.

1. Status: each stock opportunity linked to a marketplace listing (marketplace_listing_id) gets that listing's
   current status. `published` means status `listed`; anything else (draft, completed, withdrawn) means
   `opportunity`, with the marketplace status kept in marketplace_status. A listing gone from the marketplace
   is marked `missing`.
2. New listings: every published individual listing that no stock opportunity points at becomes a `listed`
   row for its supplier, so the table counts all marketplace stock once. The supplier contact comes from
   crm_platform_accounts; a seller the CRM does not know yet is added as a person (and company), and the
   platform account is linked to them. Our own and test accounts are skipped (SKIP_ACCOUNTS), as are bundle
   listings, which are Trades Preview deals.

3. Deals: a marketplace bundle listing that is a Trades Preview deal (crm_bulk_listings.marketplace_listing_id)
   lists the supplier's stock tags in metadata sourceUnits; the stock rows with those tags get bulk_listing_id
   set to the deal, so the deal and its items are not counted twice.

Read-only on the platform; writes crm_stock_opportunities, and crm_people/crm_companies/crm_platform_accounts
only to link a new seller.

    stock_opportunity_marketplace_sync.py            # dry run: prints what would change
    stock_opportunity_marketplace_sync.py --apply    # writes the changes
"""
import argparse
import json
import os
import re
import sys
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

import psycopg2
import psycopg2.extras

PLATFORM_ENV = Path("/root/.hermes/workspace/secrets/dench-platform-admin.env")
PAGE = 1000
# Our own selling accounts (their listings are Trades Preview deals) and test accounts (Power Solutions is
# owned by an internal test login, agjpolglase@gmail.com, with Ari and enterprise@ as members).
SKIP_ACCOUNTS = {"ReBattery", "ReBattery Sales", "Acme", "Electric EV", "Circular Energy Storage", "Power Solutions"}
FREEMAIL = re.compile(r"@(gmail|googlemail|hotmail|outlook|yahoo|icloud|live|msn|aol|proton|pm|gmx|mail)\.", re.I)
UNIT = {"pack": "pack", "module": "module", "cell": "cell", "system": "system"}
LISTING_SELECT = ("id,title,reference,listing_status,listing_kind,group_id,supplier_account_id,buy_now_price,currency,"
                  "seo_slug,published_at,ai_summary,accounts:supplier_account_id(name),"
                  "listing_specs(manufacturer,model,format,chemistry,pack_kwh,quantity,quantity_available,"
                  "year_manufacture,soh,location_address,metadata_json)")


def read_env_value(path, name):
    try:
        for line in path.read_text().splitlines():
            if line.startswith(name + "="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return None


def fetch_listings(env_path=PLATFORM_ENV):
    """Every marketplace listing (all statuses) with its specs and supplier account name."""
    url = read_env_value(env_path, "NEXT_PUBLIC_SUPABASE_URL")
    key = read_env_value(env_path, "SUPABASE_SECRET_KEY")
    if not url or not key:
        raise SystemExit(f"platform URL or key missing in {env_path}")
    rows, offset = [], 0
    while True:
        query = urllib.parse.urlencode({"select": LISTING_SELECT, "order": "id", "limit": PAGE, "offset": offset},
                                       safe="(),.:*")
        request = urllib.request.Request(f"{url}/rest/v1/listings?{query}", headers={
            "apikey": key, "Authorization": f"Bearer {key}", "Accept": "application/json"})
        with urllib.request.urlopen(request, timeout=60) as response:
            page = json.loads(response.read())
        rows += page
        if len(page) < PAGE:
            return rows
        offset += PAGE


def specs(listing):
    value = listing.get("listing_specs") or {}
    return (value[0] if isinstance(value, list) and value else value) or {}


def plan(rows, statuses):
    """Status changes as (id, new status, new marketplace_status, old status, old marketplace_status)."""
    changes = []
    for row in rows:
        market = statuses.get(row["marketplace_listing_id"], "missing")
        status = "listed" if market == "published" else "opportunity"
        if (status, market) != (row["status"], row["marketplace_status"]):
            changes.append((row["id"], status, market, row["status"], row["marketplace_status"]))
    return changes


def new_listings(listings, linked_ids):
    """Published individual listings no stock opportunity points at, from real supplier accounts."""
    out = []
    for listing in listings:
        account = (listing.get("accounts") or {}).get("name")
        meta = specs(listing).get("metadata_json") or {}
        if (listing["listing_status"] != "published" or listing["id"] in linked_ids or account in SKIP_ACCOUNTS
                or listing.get("listing_kind") not in (None, "individual") or meta.get("sourceUnits")
                or str(listing.get("reference") or "").startswith("bulk:")):
            continue
        out.append(listing)
    return out


def stock_row(listing):
    spec = specs(listing)
    location = (spec.get("location_address") or {}) if isinstance(spec.get("location_address"), dict) else {}
    place = ", ".join(x for x in (location.get("city"), location.get("country")) if x) or location.get("address")
    fmt = str(spec.get("format") or "").lower()
    return {
        "title": listing["title"], "description": listing.get("ai_summary"),
        "quantity": spec.get("quantity_available") or spec.get("quantity"), "quantity_unit": UNIT.get(fmt),
        "price": listing.get("buy_now_price"), "currency": listing.get("currency"),
        "price_unit": UNIT.get(fmt) if listing.get("buy_now_price") is not None else None, "location": place,
        "supplier_ref": f"marketplace:{listing.get('reference') or listing['id']}",
        "observed_on": (listing.get("published_at") or "")[:10] or None,
        "details": {"marketplace": {k: spec.get(k) for k in ("manufacturer", "model", "format", "chemistry", "pack_kwh",
                                                            "year_manufacture", "soh")},
                    "seo_slug": listing.get("seo_slug"), "vin": (spec.get("metadata_json") or {}).get("vin"),
                    "part_number": (spec.get("metadata_json") or {}).get("partNumber")},
    }


def seller(cur, account_id, account_name, apply):
    """(person_id, company_id) for a supplier account, adding the person/company when the CRM lacks them."""
    cur.execute("""select pa.person_id, pa.email, p.company_id from crm_platform_accounts pa
                   left join crm_people p on p.id = pa.person_id
                   where pa.account_id = %s order by pa.person_id is null, pa.linked_at limit 1""", (account_id,))
    row = cur.fetchone()
    if not row:
        return None, None
    if row["person_id"]:
        return row["person_id"], row["company_id"]
    email = (row["email"] or "").lower()
    cur.execute("select id, company_id from crm_people where lower(email) = %s order by id limit 1", (email,))
    person = cur.fetchone()
    if not apply:
        return (person["id"], person["company_id"]) if person else ("(new person)", None)
    if person:
        person_id, company_id = person["id"], person["company_id"]
    else:
        company_id = None
        domain = email.split("@", 1)[1] if "@" in email and not FREEMAIL.search(email) else None
        if domain:
            cur.execute("select id from crm_companies where lower(domain) = %s order by created_at limit 1", (domain,))
            found = cur.fetchone()
            company_id = found["id"] if found else None
        if not company_id:
            company_id = f"company_marketplace_{uuid.uuid4().hex[:16]}"
            cur.execute("""insert into crm_companies (id, name, domain, purpose, source, source_detail)
                           values (%s, %s, %s, '{Supplier}', 'Supabase import', 'Supplier account on the ReBattery marketplace')""",
                        (company_id, account_name or email, domain))
        person_id = f"person_marketplace_{uuid.uuid4().hex[:16]}"
        cur.execute("""insert into crm_people (id, full_name, email, company_id, notes)
                       values (%s, null, %s, %s, 'Supplier account on the ReBattery marketplace')""",
                    (person_id, email or None, company_id))
    cur.execute("update crm_platform_accounts set person_id = %s, updated_at = now() where account_id = %s and person_id is null",
                (person_id, account_id))
    return person_id, company_id


def bundle_links(listings, stock_refs, deals):
    """(stock row id, deal id) for stock rows named by a deal's bundle listing (sourceUnits.sourceReference).
    stock_refs maps a normalised supplier tag to stock row ids; deals maps a marketplace listing id to a deal id."""
    links = []
    for listing in listings:
        deal = deals.get(listing["id"])
        units = (specs(listing).get("metadata_json") or {}).get("sourceUnits") or []
        if not deal:
            continue
        for unit in units:
            ref = tag(unit.get("sourceReference"))
            if len(ref) < 5:  # too short to identify one supplier's item
                continue
            for row_id in stock_refs.get(ref, []):
                links.append((row_id, deal))
    return links


def tag(value):
    return re.sub(r"[^0-9A-Z]", "", str(value or "").split(":")[-1].upper()).lstrip("0")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--dsn", default=os.environ.get("DENCH_STOCK_DSN", "dbname=denchclaw"))
    args = parser.parse_args(argv)
    listings = fetch_listings()
    statuses = {listing["id"]: listing["listing_status"] for listing in listings}
    conn = psycopg2.connect(args.dsn)
    with conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("""select id, status, marketplace_status, marketplace_listing_id from crm_stock_opportunities
                       where marketplace_listing_id is not null""")
        rows = cur.fetchall()
        changes = plan(rows, statuses)
        for row_id, status, market, old_status, old_market in changes:
            print(f"{row_id}: {old_status}/{old_market} -> {status}/{market}")
            if args.apply:
                cur.execute(
                    """update crm_stock_opportunities set status = %s, marketplace_status = %s, updated_at = now(),
                         details = details || jsonb_build_object('marketplace_sync', jsonb_build_object(
                           'on', now()::date, 'from_status', %s::text, 'from_marketplace_status', %s::text))
                       where id = %s""", (status, market, old_status, old_market, row_id))
        added, unmapped = 0, {}
        for listing in new_listings(listings, {row["marketplace_listing_id"] for row in rows}):
            name = (listing.get("accounts") or {}).get("name")
            person_id, company_id = seller(cur, listing["supplier_account_id"], name, args.apply)
            if not person_id:
                unmapped[name] = unmapped.get(name, 0) + 1
                continue
            added += 1
            if args.apply:
                row = stock_row(listing)
                cur.execute(
                    """insert into crm_stock_opportunities (id, person_id, company_id, status, title, description, quantity,
                         quantity_unit, price, currency, price_unit, location, supplier_ref, marketplace_listing_id,
                         marketplace_status, source, observed_on, details)
                       values (%s, %s, %s, 'listed', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'published', 'marketplace', %s, %s)
                       on conflict do nothing""",
                    (f"sto_mp_{listing['id']}", person_id, company_id, row["title"], row["description"], row["quantity"],
                     row["quantity_unit"], row["price"], row["currency"], row["price_unit"], row["location"],
                     row["supplier_ref"], listing["id"], row["observed_on"], json.dumps(row["details"])))
        cur.execute("select id, supplier_ref, bulk_listing_id from crm_stock_opportunities where supplier_ref is not null")
        stock = cur.fetchall()
        stock_refs = {}
        for row in stock:
            stock_refs.setdefault(tag(row["supplier_ref"]), []).append(row["id"])
        current = {row["id"]: row["bulk_listing_id"] for row in stock}
        cur.execute("select marketplace_listing_id, id from crm_bulk_listings where marketplace_listing_id is not null")
        deals = {row["marketplace_listing_id"]: row["id"] for row in cur.fetchall()}
        linked = 0
        for row_id, deal in bundle_links(listings, stock_refs, deals):
            if current.get(row_id) == deal:
                continue
            linked += 1
            print(f"{row_id}: part of deal {deal}")
            if args.apply:
                cur.execute("update crm_stock_opportunities set bulk_listing_id = %s, updated_at = now() where id = %s",
                            (deal, row_id))
        for name, n in sorted(unmapped.items()):
            print(f"no CRM contact for marketplace account {name!r}: {n} listing(s) skipped")
        print(f"{len(rows)} linked rows, {len(changes)} changed, {added} new listed rows, {linked} items linked to deals"
              f"{'' if args.apply else ' (dry run)'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
