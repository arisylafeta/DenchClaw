#!/usr/bin/env python3
"""Imports saved searches into stated company profiles and sourcing requests as qualifying demand.

A sourcing request has a model, a timeline, a price and a location; without all four it is an enquiry and is neither
imported nor chased. A complete one is imported only when it is worth at least MIN_KWH (units x kWh per unit). Each
decision (imported, skipped, review) is kept in crm_sourcing_request_imports, so a demand deleted from the CRM is never
imported again. A complete request whose size cannot be read from its text is marked review for a person. Every new
request is announced with its outcome.

Run without --apply to preview in a rolled-back transaction. --announce reports new requests only.
Unsubscribing from alerts is not evidence that a buyer stopped buying; unsubscribed searches are skipped.
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


# The marketplace's country picker; anything else falls back to pycountry, then the code.
COUNTRY_NAMES = {
    "GB": "United Kingdom", "IE": "Ireland", "DE": "Germany", "FR": "France", "NL": "Netherlands",
    "BE": "Belgium", "LU": "Luxembourg", "PL": "Poland", "LT": "Lithuania", "LV": "Latvia", "EE": "Estonia",
    "CZ": "Czechia", "SK": "Slovakia", "AT": "Austria", "CH": "Switzerland", "IT": "Italy", "ES": "Spain",
    "PT": "Portugal", "DK": "Denmark", "SE": "Sweden", "NO": "Norway", "FI": "Finland", "HU": "Hungary",
    "RO": "Romania", "BG": "Bulgaria", "HR": "Croatia", "SI": "Slovenia", "GR": "Greece", "TR": "Turkey",
    "US": "United States", "CA": "Canada",
}


def country_name(code):
    if code in COUNTRY_NAMES:
        return COUNTRY_NAMES[code]
    try:
        import pycountry  # optional; the ISO code reads fine without it
        country = pycountry.countries.get(alpha_2=code)
        return country.name if country else code
    except Exception:
        return code


def filter_spec(filters):
    """(spec, note lines) for marketplace catalogue filters: what maps onto the shared lists goes in the spec."""
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
    if filters.get("ppkwh_min") is not None or filters.get("ppkwh_max") is not None:
        low, high = filters.get("ppkwh_min"), filters.get("ppkwh_max")
        band = f"{low}-{high}" if low is not None and high is not None else (f"{low}+" if low is not None else f"up to {high}")
        notes.append(f"Price per kWh: {band} (in the listing's currency)")
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
    return spec, notes


def map_saved_search(search):
    """One platform saved search as a demand row, or None when it should not be imported."""
    email = (search.get("email") or "").strip().lower()
    if not email or survey.internal(email) or not search.get("confirmed_at"):
        return None
    spec, notes = filter_spec(search.get("filters") or {})
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


QUANTITIES = {"one": "1 unit", "few": "2 to 10 units", "many": "More than 10 units"}
TIMINGS = {"now": "Now", "three_months": "Within 3 months", "browsing": "Just looking"}
REQUEST_SOURCES = {
    "search_suggestion": "the search box", "no_results": "an empty search",
    "pack_page": "a battery pack page", "marketplace_nav": "the marketplace menu",
}
PRICE_UNITS = {"pack": "pack", "cell": "cell"}


def map_sourcing_request(request):
    """One platform sourcing request as a request buy-box, or None when it should not be imported."""
    email = (request.get("email") or "").strip().lower()
    if not email or survey.internal(email):
        return None
    filters = request.get("filters") or {}
    spec, notes = filter_spec(filters)
    notes = [line for line in notes if not line.startswith("Searched for: ")]
    if filters.get("q") and filters["q"].strip().lower() != (request.get("wants") or "").strip().lower():
        notes.insert(0, f"Searched for: {filters['q']}")
    if (request.get("details") or "").strip():
        notes.insert(0, f"In their words: {request['details'].strip()}")
    notes.append(f"When: {TIMINGS.get(request.get('timing'), request.get('timing'))}")

    # A per-unit price fits the buy-box when the unit is clear (one format: packs or cells); else it goes in the note.
    price, currency = request.get("target_price"), request.get("target_currency")
    formats = as_list(filters.get("format"))
    unit = PRICE_UNITS.get(formats[0]) if len(formats) == 1 else None
    structured = {}
    if price is not None and currency in survey.BUY_BOX["currencies"]:
        if unit:
            structured = {"max_price": float(price), "price_currency": currency, "price_unit": unit}
        else:
            notes.append(f"Target price: {currency} {float(price):,.2f} per unit")
    asked_from = REQUEST_SOURCES.get(request.get("source"), "the marketplace")
    notes.append(f"Asked us to source it from {asked_from} on rebattery.io.")

    return {
        "kind": "request", "basis": None, "status": "qualifying", "email": email, "contact": None,
        "wants": (request.get("wants") or "Battery").strip(),
        "quantity": QUANTITIES.get(request.get("quantity"), request.get("quantity")),
        "location": request.get("country"), "spec": spec, **structured,
        "note": "\n".join(notes), "observed_on": str(request["created_at"])[:10],
        "source_kind": "import", "source_id": f"sourcing_request:{request['id']}", "source_label": "Sourcing request",
        "source_url": f"{SITE}{request.get('catalog_path') or '/marketplace/listings'}",
    }


def missing_fields(request):
    """What the request lacks of model, timeline, price and location (empty when it is a sourcing request)."""
    import re
    wants = (request.get("wants") or "").strip()
    missing = []
    # A model is more than a bare make or a keyboard mash: a number (64 kWh, E101Ah, 2018) or at least two words.
    if not (re.search(r"\d", wants) or len(wants.split()) >= 2):
        missing.append("model")
    if request.get("timing") not in ("now", "three_months"):
        missing.append("timeline")
    if request.get("target_price") is None:
        missing.append("price")
    if not request.get("country"):
        missing.append("location")
    return missing


MIN_KWH = 200
BAND_FLOOR = {"one": 1, "few": 2, "many": 10}  # the form's quantity bands, as units at least
CELL_KWH = {"18650": 0.011, "21700": 0.016}    # conservative kWh per cylindrical cell
_NUM = r"(\d+(?:[.,]\d+)?)"


def _num(text):
    return float(text.replace(",", "."))


def estimate_kwh(request):
    """Total kWh the request asks for (units x kWh per unit), or None when its text does not say."""
    import re
    text = " ".join(str(request.get(k) or "") for k in ("wants", "details", "capacity_text")).lower()
    cells = False
    match = re.search(_NUM + r"\s*mwh", text)
    if match:
        per_unit = _num(match.group(1)) * 1000
    elif (match := re.search(_NUM + r"\s*kwh", text)):
        per_unit = _num(match.group(1))
    elif (match := re.search(_NUM + r"\s*v(?:olts?)?\s*[, x]*\s*" + _NUM + r"\s*ah", text)):
        per_unit = _num(match.group(1)) * _num(match.group(2)) / 1000
    else:
        found = [kwh for name, kwh in CELL_KWH.items() if name in text]
        if not found:
            return None
        per_unit, cells = max(found), True
    units = request.get("quantity_value") or BAND_FLOOR.get(request.get("quantity"), 1)
    if cells:  # "100000 sztuk" is a count of cells; a count beside a pack size ("8 modules") is not
        count = re.search(r"(\d{1,3}(?:[ ,]\d{3})+|\d+)\s*(?:pcs|pieces|units|cells|sztuk|szt)", text)
        if count:
            units = max(units, int(re.sub(r"[ ,]", "", count.group(1))))
    return per_unit * float(units)


def gate(request):
    """pass, below (known size under MIN_KWH) or unknown (size not readable from the text)."""
    kwh = estimate_kwh(request)
    if kwh is None:
        return "unknown", None
    return ("pass" if kwh >= MIN_KWH else "below"), kwh


ANNOUNCE_WITHIN = dt.timedelta(hours=24)  # older requests are imported quietly (backfills, re-imports)
ANNOUNCE_MAX = 5                          # per run; the rest are summed up in one line
DETAILS_MAX = 600


def quiet_mentions(text):
    """The buyer's own words, unable to ping anyone in Discord (@everyone, @here, <@id>)."""
    return (text or "").replace("@", "@\u200b")


def _kwh_text(kwh):
    return f"{kwh:,.1f}" if kwh < 10 else f"{kwh:,.0f}"


def announcement(request, row, outcome=None, kwh=None, missing=()):
    """A short Discord note for one new request, written for the team. outcome: None or imported (in Trades),
    incomplete (an enquiry), small (under MIN_KWH) or review (size unreadable)."""
    heading = " · ".join(x for x in (QUANTITIES.get(request.get("quantity")), TIMINGS.get(request.get("timing")),
                                     country_name(request["country"]) if request.get("country") else None) if x)
    title = {"incomplete": "**New enquiry, not a sourcing request**", "small": f"**New sourcing request, under {MIN_KWH} kWh**",
             "review": "**New sourcing request, size unclear**"}.get(outcome, "**New sourcing request**")
    lines = [f"{title} · {heading}", f"**{quiet_mentions(row['wants'])}**"]
    details = (request.get("details") or "").strip()
    if details:
        if len(details) > DETAILS_MAX:
            details = details[:DETAILS_MAX].rstrip() + "…"
        lines += [f"> {quiet_mentions(line)}" if line else ">" for line in details.splitlines()]
    if request.get("target_price") is not None and request.get("target_currency"):
        unit = row.get("price_unit") or "unit"
        lines.append(f"Target: {request['target_currency']} {float(request['target_price']):,.0f} per {unit}")
    company = row.get("buyer") if row.get("company_id") else None
    if outcome in (None, "imported"):
        lines.append(f"Buyer: {row['email']}" + (f" · {company} (in CRM)" if company else " · not in CRM yet"))
        if kwh:
            lines.append(f"About {_kwh_text(kwh)} kWh. In Trades.")
    else:
        lines.append(f"Buyer: {row['email']} · not in Trades")
        if outcome == "incomplete":
            lines.append(f"Missing: {', '.join(missing)}. Not chased.")
        elif outcome == "small":
            lines.append(f"About {_kwh_text(kwh)} kWh. Marketplace route, not in Trades.")
        else:
            lines.append("Complete, but the size cannot be read from the text. A person decides.")
    lines.append(f"<{row['source_url']}>")
    return "\n".join(lines)


def is_recent(request, now=None):
    created = dt.datetime.fromisoformat(str(request["created_at"]).replace("Z", "+00:00"))
    return (now or dt.datetime.now(dt.timezone.utc)) - created <= ANNOUNCE_WITHIN


def read_env_value(path, name):
    for line in Path(path).read_text().splitlines():
        if line.startswith(f"{name}="):
            return line.split("=", 1)[1].strip().strip('"')
    return None


PAGE = 1000  # PostgREST returns at most this many rows per request


def fetch_platform(table, select, extra, env_path=PLATFORM_ENV):
    """Every row of a platform table from its REST API with the service key (read-only), page by page;
    [] before the table exists."""
    url = read_env_value(env_path, "NEXT_PUBLIC_SUPABASE_URL")
    key = read_env_value(env_path, "SUPABASE_SECRET_KEY")
    if not url or not key:
        raise SystemExit(f"platform URL or key missing in {env_path}")
    rows = []
    while True:
        query = urllib.parse.urlencode({"select": select, **extra, "order": "created_at.asc,id.asc",
                                        "limit": PAGE, "offset": len(rows)})
        request = urllib.request.Request(f"{url}/rest/v1/{table}?{query}", headers={
            "apikey": key, "Authorization": f"Bearer {key}", "Accept": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                page = json.loads(response.read())
        except urllib.error.HTTPError as error:
            # Before the platform release that adds the table, it isn't there yet.
            if error.code == 404 and not rows:
                print(f"platform has no {table} table yet; nothing to import", file=sys.stderr)
                return []
            raise
        rows.extend(page)
        if len(page) < PAGE:
            return rows


def fetch_saved_searches(env_path=PLATFORM_ENV):
    """Confirmed saved searches from the platform."""
    return fetch_platform(
        "saved_searches",
        "id,email,filters,label,catalog_path,frequency,status,confirmed_at,unsubscribed_at,created_at",
        {"confirmed_at": "not.is.null"}, env_path)


def fetch_sourcing_requests(env_path=PLATFORM_ENV):
    """Every sourcing request from the platform."""
    return fetch_platform(
        "sourcing_requests",
        "id,email,wants,details,filters,catalog_path,quantity,quantity_value,capacity_text,timing,target_price,target_currency,country,source,status,created_at",
        {}, env_path)





def main():
    import psycopg2
    import psycopg2.extras
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dsn", default="host=/var/run/postgresql dbname=denchclaw")
    parser.add_argument("--json", help="read saved searches from a JSON file instead of the platform")
    parser.add_argument("--requests-json", help="read sourcing requests from a JSON file instead of the platform")
    parser.add_argument("--platform-env", default=str(PLATFORM_ENV), help="env file with the platform URL and key")
    parser.add_argument("--apply", action="store_true", help="write; without it nothing is saved")
    parser.add_argument("--quiet", action="store_true", help="print only the totals (for scheduled runs)")
    parser.add_argument("--announce", action="store_true",
                        help="print nothing but a Discord note per newly added request from the last day (Hermes posts it)")
    args = parser.parse_args()

    if args.json:
        with open(args.json) as handle:
            searches = json.load(handle)
    else:
        searches = fetch_saved_searches(args.platform_env)
    if args.requests_json:
        with open(args.requests_json) as handle:
            requests = json.load(handle)
    elif args.json:
        requests = []
    else:
        requests = fetch_sourcing_requests(args.platform_env)
    search_rows = [row for row in (map_saved_search(search) for search in searches) if row]
    requests_by_source = {f"sourcing_request:{request['id']}": request for request in requests}
    notes = []
    skipped = len(searches) - len(search_rows)

    conn = psycopg2.connect(args.dsn)
    added = closed = 0
    with conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("""create table if not exists crm_sourcing_request_imports (
            source_id text primary key, outcome text not null check (outcome in ('imported', 'skipped', 'review')),
            kwh numeric, decided_on timestamptz not null default now())""")
        cur.execute("select source_id from crm_sourcing_request_imports")
        decided = {r["source_id"] for r in cur.fetchall()}
        request_rows, below, review, incomplete = [], [], [], []
        skipped_requests = 0

        def decide(request, source_id, row, outcome, kwh, note_outcome, missing=()):
            cur.execute("insert into crm_sourcing_request_imports (source_id, outcome, kwh) values (%s, %s, %s)"
                        " on conflict do nothing", (source_id, outcome, kwh))
            if is_recent(request):
                notes.append(announcement(request, row, note_outcome, kwh, missing))

        for request in requests:
            source_id = f"sourcing_request:{request['id']}"
            row = map_sourcing_request(request)
            if source_id in decided or not row:
                skipped_requests += 1
                continue
            missing = missing_fields(request)
            if missing:
                incomplete.append(source_id)
                decide(request, source_id, row, "skipped", None, "incomplete", missing)
                continue
            verdict, kwh = gate(request)
            if verdict == "pass":
                request_rows.append(row)
                row["_kwh"] = kwh
            elif verdict == "below":
                below.append(source_id)
                decide(request, source_id, row, "skipped", kwh, "small")
            else:
                review.append(f"{request['wants'][:40]} ({request['email']})")
                decide(request, source_id, row, "review", None, "review")
        rows = search_rows + request_rows
        for row in rows:
            kwh = row.pop("_kwh", None)
            unsubscribed = row.pop("unsubscribed", False)
            if unsubscribed:
                continue
            survey.link(cur, row)
            new = survey.insert(cur, row)
            added += new
            if row["source_id"].startswith("sourcing_request:"):
                cur.execute("insert into crm_sourcing_request_imports (source_id, outcome, kwh) values (%s, 'imported', %s)"
                            " on conflict do nothing", (row["source_id"], kwh))
            request = requests_by_source.get(row["source_id"])
            if new and request and is_recent(request):
                notes.append(announcement(request, row, "imported", kwh))
            gone = False
            if not args.quiet and not args.announce:
                state = "add" if new else "already in"
                print(f"{state}{' and close' if gone else ''}: {row['buyer']} | {row['wants'][:70]} | {row['source_id']}"
                      f" | company {'linked' if row.get('company_id') else 'not in CRM'}")
                if new and row.get("spec"):
                    print(f"    spec {json.dumps(row['spec'], ensure_ascii=False)}")
        if not args.apply:
            conn.rollback()
    conn.close()
    verb = "added" if args.apply else "would add"
    summary = (f"{verb} {added} and {'closed' if args.apply else 'would close'} {closed} of {len(search_rows)} saved"
               f" searches and {len(request_rows)} sourcing requests ({skipped} searches and {skipped_requests}"
               f" requests passed over: unconfirmed, internal, test or already decided); {len(incomplete)} incomplete,"
               f" {len(below)} under {MIN_KWH} kWh, {len(review)} need a person to read the size"
               + (": " + "; ".join(review) if review else ""))
    if args.announce:
        # stdout is the Discord message: only new requests, and nothing at all on a quiet run.
        print(summary, file=sys.stderr)
        if notes:
            shown = notes[:ANNOUNCE_MAX]
            more = len(notes) - len(shown)
            print("\n\n".join(shown + ([f"…and {more} more new requests in Bulk Trades."] if more else [])))
    else:
        print(summary)
    return 0


if __name__ == "__main__":
    sys.exit(main())
