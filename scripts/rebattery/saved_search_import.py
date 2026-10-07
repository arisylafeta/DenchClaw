#!/usr/bin/env python3
"""Imports marketplace saved searches into Bulk Trades demand as stated standing buy-boxes.

  saved_search_import.py                     # show what the platform's saved searches would add or close
  saved_search_import.py --apply             # write them
  saved_search_import.py --json FILE.json    # read saved searches from a file instead of the platform

A buyer who saves a catalogue search on rebattery.io ("Tesla · NMC · 80%+ health", emailed daily) has told
us what they want to buy. Each confirmed saved search becomes one buy-box keyed by
("import", "saved_search:<id>"), so a re-run adds nothing twice. Filters that map onto
apps/web/lib/buy-box-spec.json go into the spec; the rest (brands outside the lists, year, country,
search words) go into the note. When the buyer unsubscribes, the buy-box closes as no longer needed.
Unconfirmed guest saves and ReBattery staff or QA emails are skipped. Each row is linked to the CRM
person by email and to that person's company, exactly as the survey import does.
"""
import argparse
import datetime as dt
import importlib.util
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("demand_survey_import", HERE / "demand_survey_import.py")
survey = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(survey)

PLATFORM_ENV = Path("/root/.hermes/workspace/secrets/dench-platform-admin.env")
SITE = "https://www.rebattery.io"
LISTS = survey.BUY_BOX["lists"]

CHEMISTRIES = {value.lower().replace("-", "_"): value for value in LISTS["chemistries"]}
FORMATS = {"pack": "Packs", "module": "Modules", "cell": "Cells"}
CONDITIONS = {"new": "New or surplus", "end_of_life": "Damaged or end of life"}
GRADES = {"excellent": "Excellent", "great": "Great", "functional": "Functional"}
# Platform manufacturer names (lower-cased) onto the shared vehicle-make and cell-maker lists.
MAKES = {
    "tesla": "Tesla", "volkswagen": "VW Group", "vw": "VW Group", "audi": "VW Group", "skoda": "VW Group",
    "porsche": "VW Group", "seat": "VW Group", "cupra": "VW Group", "renault": "Renault", "dacia": "Renault",
    "nissan": "Nissan", "hyundai": "Hyundai or Kia", "kia": "Hyundai or Kia", "bmw": "BMW or Mini",
    "mini": "BMW or Mini", "mercedes-benz": "Mercedes-Benz", "mercedes": "Mercedes-Benz", "peugeot": "Stellantis",
    "citroen": "Stellantis", "citroën": "Stellantis", "fiat": "Stellantis", "opel": "Stellantis",
    "vauxhall": "Stellantis", "jeep": "Stellantis", "ds": "Stellantis", "ford": "Ford", "chevrolet": "GM",
    "cadillac": "GM", "gmc": "GM", "byd": "BYD", "mg": "MG or SAIC", "saic": "MG or SAIC", "volvo": "Volvo or Polestar",
    "polestar": "Volvo or Polestar", "jaguar": "JLR", "land rover": "JLR", "toyota": "Toyota or Lexus",
    "lexus": "Toyota or Lexus",
}
CELL_MAKERS = {
    "catl": "CATL", "lg": "LG", "lg chem": "LG", "lg energy solution": "LG", "samsung sdi": "Samsung SDI",
    "sk on": "SK On", "sk innovation": "SK On", "panasonic": "Panasonic", "eve": "EVE", "eve energy": "EVE",
    "calb": "CALB", "gotion": "Gotion", "northvolt": "Northvolt", "aesc": "AESC",
}


def as_list(value):
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def country_name(code):
    try:
        import pycountry  # optional; the ISO code reads fine without it
        country = pycountry.countries.get(alpha_2=code)
        return country.name if country else code
    except Exception:
        return code


def map_saved_search(search):
    """One platform saved search as a demand row, or None when it should not be imported."""
    email = (search.get("email") or "").strip().lower()
    if not email or survey.internal(email) or not search.get("confirmed_at"):
        return None
    filters = search.get("filters") or {}
    spec, notes, brands = {}, [], []

    for value in as_list(filters.get("chemistry")):
        if value.lower() in CHEMISTRIES:
            survey.add(spec, "chemistries", CHEMISTRIES[value.lower()])
    for value in as_list(filters.get("format")):
        if value in FORMATS:
            survey.add(spec, "formats", FORMATS[value])
    grades = []
    for value in as_list(filters.get("condition")):
        if value in CONDITIONS:
            survey.add(spec, "conditions", CONDITIONS[value])
        elif value in GRADES:
            grades.append(GRADES[value])
    for name in as_list(filters.get("manufacturer")):
        key = name.strip().lower()
        if key in MAKES:
            survey.add(spec, "makes", MAKES[key])
        elif key in CELL_MAKERS:
            survey.add(spec, "cell_makers", CELL_MAKERS[key])
        else:
            brands.append(name.strip())
    if filters.get("soh_min") is not None:
        spec["min_soh"] = filters["soh_min"]
    if filters.get("kwh_min") is not None:
        spec["kwh_min"] = filters["kwh_min"]
    if filters.get("kwh_max") is not None:
        spec["kwh_max"] = filters["kwh_max"]

    if filters.get("q"):
        notes.append(f"Searched for: {filters['q']}")
    if brands:
        notes.append(f"Brands: {', '.join(brands)}")
    if grades:
        notes.append(f"Condition grade: {', '.join(grades)}")
    if filters.get("year_from") or filters.get("year_to"):
        notes.append(f"Made: {filters.get('year_from') or 'any'} to {filters.get('year_to') or 'now'}")
    countries = as_list(filters.get("location_country"))
    if countries:
        notes.append(f"Located in: {', '.join(country_name(code) for code in countries)}")
    for key, label in (("application", "Application"), ("quantity_band", "Quantity")):
        if as_list(filters.get(key)):
            notes.append(f"{label}: {', '.join(as_list(filters[key]))}")
    if filters.get("buy_now_only"):
        notes.append("Buy-now price only")
    if filters.get("verified_data_only"):
        notes.append("Verified specs only")
    cadence = "daily" if search.get("frequency") == "daily" else "weekly"
    notes.append(f"Saved search on rebattery.io, alerts {cadence}.")

    confirmed = str(search["confirmed_at"])[:10]
    return {
        "kind": "standing", "basis": "stated", "email": email, "contact": None,
        "wants": search.get("label") or "Any battery listing", "quantity": None, "location": None,
        "spec": spec, "note": "\n".join(notes), "observed_on": confirmed,
        "source_kind": "import", "source_id": f"saved_search:{search['id']}", "source_label": "Saved search",
        "source_url": f"{SITE}{search.get('catalog_path') or '/marketplace/listings'}",
        "unsubscribed": search.get("status") == "unsubscribed",
    }


def read_env_value(path, name):
    for line in Path(path).read_text().splitlines():
        if line.startswith(f"{name}="):
            return line.split("=", 1)[1].strip().strip('"')
    return None


def fetch_saved_searches(env_path=PLATFORM_ENV):
    """Confirmed saved searches from the platform's REST API with the service key (read-only)."""
    url = read_env_value(env_path, "NEXT_PUBLIC_SUPABASE_URL")
    key = read_env_value(env_path, "SUPABASE_SECRET_KEY")
    if not url or not key:
        raise SystemExit(f"platform URL or key missing in {env_path}")
    query = urllib.parse.urlencode({
        "select": "id,email,filters,label,catalog_path,frequency,status,confirmed_at,unsubscribed_at,created_at",
        "confirmed_at": "not.is.null",
        "order": "created_at.asc",
    })
    request = urllib.request.Request(f"{url}/rest/v1/saved_searches?{query}", headers={
        "apikey": key, "Authorization": f"Bearer {key}", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        # Before the platform release that adds saved searches, the table isn't there yet.
        if error.code == 404:
            print("platform has no saved_searches table yet; nothing to import")
            return []
        raise


def close_unsubscribed(cur, row):
    """Closes the buy-box of an unsubscribed search once, unless someone already closed it."""
    cur.execute("""update crm_bulk_trade_demand set status = 'closed', closed_reason = 'no_longer_needed',
                     note = coalesce(note || E'\\n', '') || %s, updated_at = now()
                   where source_kind = 'import' and source_id = %s and status = 'open'
                   returning id""",
                (f"Unsubscribed from the alert on {dt.date.today().isoformat()}.", row["source_id"]))
    return cur.fetchone() is not None


def main():
    import psycopg2
    import psycopg2.extras
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dsn", default="host=/var/run/postgresql dbname=denchclaw")
    parser.add_argument("--json", help="read saved searches from a JSON file instead of the platform")
    parser.add_argument("--platform-env", default=str(PLATFORM_ENV), help="env file with the platform URL and key")
    parser.add_argument("--apply", action="store_true", help="write; without it nothing is saved")
    parser.add_argument("--quiet", action="store_true", help="print only the totals (for scheduled runs)")
    args = parser.parse_args()

    if args.json:
        with open(args.json) as handle:
            searches = json.load(handle)
    else:
        searches = fetch_saved_searches(args.platform_env)
    rows = [row for row in (map_saved_search(search) for search in searches) if row]
    skipped = len(searches) - len(rows)

    conn = psycopg2.connect(args.dsn)
    added = closed = 0
    with conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        for row in rows:
            unsubscribed = row.pop("unsubscribed")
            survey.link(cur, row)
            new = survey.insert(cur, row)
            added += new
            gone = close_unsubscribed(cur, row) if unsubscribed else False
            closed += gone
            if not args.quiet:
                state = "add" if new else "already in"
                print(f"{state}{' and close' if gone else ''}: {row['buyer']} | {row['wants'][:70]} | {row['source_id']}"
                      f" | company {'linked' if row.get('company_id') else 'not in CRM'}")
                if new and row.get("spec"):
                    print(f"    spec {json.dumps(row['spec'], ensure_ascii=False)}")
        if not args.apply:
            conn.rollback()
    conn.close()
    verb = "added" if args.apply else "would add"
    print(f"{verb} {added} and {'closed' if args.apply else 'would close'} {closed} of {len(rows)} saved searches"
          f" ({skipped} skipped: unconfirmed, internal or test)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
