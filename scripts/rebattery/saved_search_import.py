#!/usr/bin/env python3
"""Imports saved searches into stated company profiles and sourcing requests as qualifying demand.

--resync re-derives every current search's Wants and merges duplicate lines (once-off, archives first).
Run without --apply to preview in a rolled-back transaction. --announce reports new requests only.
A sourcing request becomes a Bulk Trades request only when bulk_request_gate passes it (at least 300 kWh or a EUR 20k
budget, a purchase, a real buyer); every other request stays on the buyer's profile as interest. A request that gets
in is flagged for review (context.review), with its size, the reasons and the buyer's mail history in a Story row,
a driver and a first next action.
Unsubscribing from alerts is not evidence that a buyer stopped buying; unsubscribed searches are skipped.
For a company that has a buyer dossier the saved search is also recorded as a dated saved_search context note
(the Buyer tab lists it as an alert) and the dossier is flagged stale, never rewritten. A sourcing request
without both a quantity and a timing is standing interest and takes the profile path, not the demand queue.
"""
import argparse
import datetime as dt
import importlib.util
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("demand_survey_import", HERE / "demand_survey_import.py")
survey = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(survey)
_gate_spec = importlib.util.spec_from_file_location("bulk_request_gate", HERE / "bulk_request_gate.py")
gate = importlib.util.module_from_spec(_gate_spec)
_gate_spec.loader.exec_module(gate)

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


# Vehicle models a search or request may name, by the platform's own manufacturer name. Reviewed and short on purpose:
# a search for a model on this list is that model's line (`model:kia-ev3`); anything else stays a make or broad line.
KNOWN_MODELS = {
    "Kia": ["EV3", "EV4", "EV5", "EV6", "EV9", "Niro", "e-Niro", "Soul"],
    "Hyundai": ["Kona", "Ioniq", "Ioniq 5", "Ioniq 6", "Ioniq 9"],
    "Renault": ["Zoe", "Twingo", "Megane", "Kangoo", "Twizy", "Fluence"],
    "Toyota": ["Corolla", "Corolla Cross", "Prius", "RAV4", "Yaris", "C-HR", "Mirai", "Auris"],
    "Tesla": ["Model S", "Model X", "Model 3", "Model Y"],
    "Nissan": ["Leaf"],
    "Volkswagen": ["ID.3", "ID.4", "ID.5", "e-Golf", "e-Up"],
    "Skoda": ["Enyaq"],
    "Audi": ["e-tron", "Q4 e-tron", "Q8 e-tron"],
    "BMW": ["i3", "i4", "iX", "iX3"],
    "Peugeot": ["e-208", "e-2008"],
    "Vauxhall": ["Corsa-e", "Mokka-e"],
    "Volvo": ["XC40"],
    "MG": ["MG4", "ZS EV"],
    "Porsche": ["Taycan"],
    "Jaguar": ["I-Pace"],
    "Ford": ["Mustang Mach-E"],
    "Chevrolet": ["Bolt", "Bolt EV", "Volt"],
}
# Names that also mean something else: a search for them needs its maker (the manufacturer filter, or in the text).
AMBIGUOUS_MODELS = {"bolt", "volt", "soul", "2", "id"}
MANUFACTURER_NAMES = {"vw": "Volkswagen", "mercedes": "Mercedes-Benz", "citroën": "Citroen", "škoda": "Skoda"}


def _fold(text):
    return "".join(ch for ch in str(text or "").lower() if ch.isalnum())


PART_TOKEN = re.compile(r"[A-Za-z0-9][A-Za-z0-9./_#-]*[A-Za-z0-9]")
UNIT_TOKEN = re.compile(r"^\d+(\.\d+)?(kwh|kw|ah|wh|v|%)$", re.IGNORECASE)
GENERIC_WORDS = {"battery", "batteries", "pack", "packs", "module", "modules", "cell", "cells", "hv", "for"}
SEARCH_FORMATS = {"pack": "Packs", "packs": "Packs", "module": "Modules", "modules": "Modules", "cell": "Cells", "cells": "Cells"}


CHEMISTRY_PREFIX = re.compile(r"^(nmc|nca|lfp|lmo|lto)", re.IGNORECASE)
INNER_UNIT = re.compile(r"\d(mah|kwh|ah|wh|v)(?![a-z])", re.IGNORECASE)
CELL_MODEL = re.compile(r"^[A-Za-z]{2,4}\d{4,5}[A-Za-z]{0,2}$")
OEM_HYPHENATED = re.compile(r"^(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{3,}(-[A-Za-z0-9]{2,})+$")
OEM_COMPACT = re.compile(r"^\d{5}[A-Za-z]{1,2}\d{2,4}$")


def part_number_like(token):
    """An OEM-style code in search text (`G9510-16021`, `37501-GI300`, `37501AO050`): letters and digits, a hyphenated
    segment or the compact five-digit OEM form. A chemistry (`NMC811`, `LFP280Ah`), a size with a unit (`18650-2500mAh`,
    `100kWh-pack`), a cell model (`NCR18650B`), a model (`225xe`, `ioniq5`) or a year range is not one."""
    if UNIT_TOKEN.match(token) or CHEMISTRY_PREFIX.match(token) or INNER_UNIT.search(token) or CELL_MODEL.match(token):
        return False
    folded = _fold(token)
    if not (len(folded) >= 6 and sum(ch.isdigit() for ch in folded) >= 3 and any(ch.isalpha() for ch in folded)
            and len(token) <= 20):
        return False
    return bool(OEM_HYPHENATED.match(token) or OEM_COMPACT.match(token))


def search_terms(filters):
    """What a search's text states beyond a model name: ({part numbers}, {cell makers}, {formats}, remaining words).

    The remaining words are the text without those parts, so \"Corolla Cross G9510-16021\" still names its model and
    \"Samsung sdi modules\" names no model at all. Order of the stated values is kept.
    """
    text = str(filters.get("q") or "")
    parts = [token for token in PART_TOKEN.findall(text) if part_number_like(token)]
    for token in parts:
        text = text.replace(token, " ")
    cell_makers = []
    for name in sorted(CELL_MAKERS, key=len, reverse=True):
        pattern = r"(?<![A-Za-z0-9])" + r"[\s-]+".join(re.escape(word) for word in name.split()) + r"(?![A-Za-z0-9])"
        if re.search(pattern, text, re.IGNORECASE):
            if CELL_MAKERS[name] not in cell_makers:
                cell_makers.append(CELL_MAKERS[name])
            text = re.sub(pattern, " ", text, flags=re.IGNORECASE)
    formats = []
    words = []
    for word in text.split():
        key = word.strip(",.;:").lower()
        if key in SEARCH_FORMATS and SEARCH_FORMATS[key] not in formats:
            formats.append(SEARCH_FORMATS[key])
        if key not in GENERIC_WORDS:
            words.append(word)
    return list(dict.fromkeys(parts)), cell_makers, formats, " ".join(words)


def search_model(filters):
    """{make, model} when the search text names a known vehicle model, else None. Never guesses a make or a kWh.

    The text may be the model alone with its maker in the manufacturer filter (\"EV3\" + Kia), the maker and model together
    (\"Hyundai kona\"), or a model only one listed maker owns (\"zoe\"). Extra words (\"polestar 2 78 kwh front wheel drive\")
    are not a model name, so they stay a note.
    """
    query = _fold(search_terms(filters)[3])
    if not query:
        return None
    named = {MANUFACTURER_NAMES.get(str(n).strip().lower(), str(n).strip()).lower() for n in as_list(filters.get("manufacturer"))}
    found = []
    for make, models in KNOWN_MODELS.items():
        for model in models:
            with_make = query == _fold(make) + _fold(model)
            hit = with_make or (query == _fold(model) and (bool(named) or _fold(model) not in AMBIGUOUS_MODELS))
            if hit and (not named or make.lower() in named):
                found.append({"make": make, "model": model})
    if len({(hit["make"], hit["model"]) for hit in found}) != 1:
        return None
    return found[0]


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

    # The search text can state what the filters do not: a cell maker ("Samsung sdi"), a format ("modules") and part
    # numbers ("G9510-16021"). They go in the spec beside the filters, so the buy box and the Said line keep them.
    parts, text_cell_makers, text_formats, _words = search_terms(filters)
    for name in text_cell_makers:
        survey.add(spec, "cell_makers", name)
    if not as_list(filters.get("format")):
        for name in text_formats:
            survey.add(spec, "formats", name)
    for part in parts:
        survey.add(spec, "part_numbers", part)
    codes = [str(code).strip().upper() for code in as_list(filters.get("location_country")) if str(code or "").strip()]
    for code in codes:
        survey.add(spec, "source_countries", code)  # where the goods are; never `origins`, which is the battery's use

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


def stated_detail(spec):
    """What a Said line holds beyond its product key: the cell maker and the country the listings must be in."""
    detail = []
    if spec.get("cell_makers"):
        detail.append(f"Cell maker: {', '.join(spec['cell_makers'])}")
    if spec.get("source_countries"):
        detail.append(f"Located in: {', '.join(country_name(code) for code in spec['source_countries'])}")
    return "; ".join(detail) or None


def map_saved_search(search):
    """One platform saved search as a demand row, or None when it should not be imported."""
    email = (search.get("email") or "").strip().lower()
    if not email or survey.internal(email) or not search.get("confirmed_at"):
        return None
    filters = search.get("filters") or {}
    spec, notes = filter_spec(filters)
    cadence = "daily" if search.get("frequency") == "daily" else "weekly"
    notes.append(f"Saved search on rebattery.io, alerts {cadence}.")

    confirmed = str(search["confirmed_at"])[:10]
    return {
        "interest_model": search_model(search.get("filters") or {}),
        "kind": "standing", "basis": "stated", "email": email, "contact": None,
        "wants": search.get("label") or "Any battery listing", "quantity": None,
        "location": ", ".join(country_name(code) for code in spec.get("source_countries", [])) or None,
        "raw_product": stated_detail(spec),
        "spec": spec, "note": "\n".join(notes), "observed_on": confirmed,
        "source_kind": "import", "source_id": f"saved_search:{search['id']}", "source_label": "Saved search",
        "unsubscribed_on": str(search.get("unsubscribed_at") or "")[:10] or None,
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


def request_quantity(request):
    if request.get("quantity_text"):
        return request["quantity_text"]
    if request.get("quantity_value") is not None and request.get("quantity_unit"):
        return f"{request['quantity_value']} {request['quantity_unit']}"
    return QUANTITIES.get(request.get("quantity"), request.get("quantity"))


def request_timing(request):
    return (request.get("timing_text") or request.get("needed_by")
            or TIMINGS.get(request.get("timing"), request.get("timing")))


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
    timing = request_timing(request)
    if timing:
        notes.append(f"When: {timing}")
    if request.get("needed_by"):
        notes.append(f"Needed by: {request['needed_by']}")
    for key, label, choices, spec_key in (
            ("chemistry", "Chemistry", CHEMISTRIES, "chemistries"),
            ("format", "Format", {**FORMATS, "system": "Systems"}, "formats")):
        value = request.get(key)
        if value:
            mapped = choices.get(value.lower().replace("-", "_"))
            if mapped and mapped in LISTS[spec_key]:
                survey.add(spec, spec_key, mapped)
            else:
                notes.append(f"{label}: {value}")
    if request.get("capacity_text"):
        notes.append(f"Capacity: {request['capacity_text']}")

    # Explicit units take precedence: a module/total price must never become a pack price.
    price, currency = request.get("target_price"), request.get("target_currency")
    formats = as_list(request.get("format") or filters.get("format"))
    unit = request.get("price_unit") or (PRICE_UNITS.get(formats[0].lower()) if len(formats) == 1 else None)
    structured = {}
    if request.get("needed_by"):
        structured["needed_by"] = request["needed_by"]
    if price is not None:
        if float(price) > 0 and currency in ("EUR", "USD", "GBP") and unit in ("kWh", "pack", "cell"):
            structured.update(max_price=float(price), price_currency=currency, price_unit=unit)
        else:
            notes.append(f"Target price: {currency or 'unspecified currency'} {float(price):,.2f} per {unit or 'unit'}")
    jules = request.get("source") == "jules"
    # A commercial buyer's request (REB-577) normally reaches the CRM at once with stock attached per supplier; this
    # import is the fallback when that hand-off failed, so keep the chosen stock groups visible on the demand.
    buy_request = jules and request.get("request_kind") == "buy_request"
    if buy_request:
        spec["commercial_buyer"] = True
        for line in request.get("stock_lines") or []:
            target = f" at EUR {line['targetPriceEur']:,.0f} each" if line.get("targetPriceEur") else ""
            notes.append(f"Stock line: {line.get('quantity')}x {line.get('label')}{target} ({line.get('groupKey')})")
    asked_from = REQUEST_SOURCES.get(request.get("source"), "the marketplace")
    notes.append("Asked us to source it through Jules on rebattery.io." if jules else
                 f"Asked us to source it from {asked_from} on rebattery.io.")

    return {
        "interest_model": search_model(filters),
        "kind": "request", "basis": None, "status": "qualifying", "email": email, "contact": None,
        "wants": (request.get("wants") or "Battery").strip(),
        "quantity": request_quantity(request), "timing": timing or None,
        "location": request.get("country"), "spec": spec, **structured,
        "note": "\n".join(notes), "observed_on": str(request["created_at"])[:10],
        "source_kind": "jules" if jules else "import", "source_id": f"sourcing_request:{request['id']}",
        "source_label": "Jules commercial buyer" if buy_request else "Jules" if jules else "Sourcing request",
        "source_url": (f"{SITE}/operations/jules/{request['conversation_id']}"
                       if jules and request.get("conversation_id") else
                       f"{SITE}{request.get('catalog_path') or '/marketplace/listings'}"),
    }


ANNOUNCE_WITHIN = dt.timedelta(hours=24)  # older requests are imported quietly (backfills, re-imports)
ANNOUNCE_MAX = 5                          # per run; the rest are summed up in one line
DETAILS_MAX = 600


def quiet_mentions(text):
    """The buyer's own words, unable to ping anyone in Discord (@everyone, @here, <@id>)."""
    return (text or "").replace("@", "@\u200b")


def announcement(request, row):
    """A short Discord note for one new sourcing request, written for the team."""
    heading = " · ".join(x for x in (request_quantity(request), request_timing(request),
                                     country_name(request["country"]) if request.get("country") else None) if x)
    lines = [f"**New sourcing request** · {quiet_mentions(heading)}", f"**{quiet_mentions(row['wants'])}**"]
    details = (request.get("details") or "").strip()
    if details:
        if len(details) > DETAILS_MAX:
            details = details[:DETAILS_MAX].rstrip() + "…"
        lines += [f"> {quiet_mentions(line)}" if line else ">" for line in details.splitlines()]
    if request.get("target_price") is not None and request.get("target_currency"):
        unit = request.get("price_unit") or row.get("price_unit") or "unit"
        lines.append(f"Target: {request['target_currency']} {float(request['target_price']):,.0f} per {unit}")
    company = row.get("buyer") if row.get("company_id") else None
    lines.append(f"Buyer: {row['email']}" + (f" · {company} (in CRM)" if company else " · not in CRM yet"))
    lines.append(f"<{row['source_url']}>")
    return "\n".join(lines)


def is_recent(request, now=None):
    created = dt.datetime.fromisoformat(str(request["created_at"]).replace("Z", "+00:00"))
    return (now or dt.datetime.now(dt.timezone.utc)) - created <= ANNOUNCE_WITHIN


def existing_company_id(cur, email):
    """The company a saved search belongs to, without creating one: an unsubscribed search must not add a lead."""
    cur.execute("""select p.company_id from crm_people p
                   where p.email is not null and lower(p.email) = %s and p.company_id is not null
                   order by p.updated_at desc nulls last limit 1""", ((email or "").lower(),))
    row = cur.fetchone()
    return row.get("company_id") if isinstance(row, dict) else (row[0] if row else None)


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
        # '*' includes Jules fields after migration and works before those columns exist.
        "*",
        {}, env_path)





def next_working_day(today):
    day = today + dt.timedelta(days=1)
    while day.weekday() >= 5:
        day += dt.timedelta(days=1)
    return day


def flag_for_review(cur, row, request, reasons, measured, today):
    """A request the gate let in: mark it for review, give it a driver and a first action, and write what we know.
    Returns the listing id, or None when the row went to the profile instead (no quantity or date)."""
    cur.execute("select id, party from crm_bulk_listings where source_id = %s and kind = 'demand' order by created_at desc limit 1",
                (row["source_id"],))
    found = cur.fetchone()
    if not found:
        # The gate let it in but no listing exists: fail the whole run (rolled back, retried next run, cron alerts)
        # rather than leave an unreviewed import that looks like a qualified deal.
        raise RuntimeError(f"{row['source_id']} passed the bulk gate but no demand listing was found to flag for review")
    listing_id, party = found["id"], found["party"]
    email = row.get("email")
    cur.execute("""select count(*) as n, max(coalesce(sent_at, created_at))::date as last from mail_message
                   where lower(from_email) = %s or %s = any(to_emails)""", (email, email))
    mail = cur.fetchone()
    cur.execute("""select count(*) as n from crm_bulk_listings where id <> %s and status <> 'closed'
                   and ((company_id is not null and company_id = %s) or (person_id is not null and person_id = %s))""",
                (listing_id, row.get("company_id"), row.get("person_id")))
    others = cur.fetchone()["n"]
    owner = gate.owner_for(measured)
    size_line = ", ".join(x for x in (
        f"{measured['units']:g} items" if measured.get("units") else None,
        f"{measured['kwh_each']:g} kWh each" if measured.get("kwh_each") else None,
        f"about {measured['total_kwh']:,} kWh" if measured.get("total_kwh") else None,
        f"budget about EUR {measured['value_eur']:,}" if measured.get("value_eur") else None,
        f"about EUR {measured['est_value_eur']:,} at EUR {gate.EUR_PER_KWH_ESTIMATE}/kWh" if measured.get("est_value_eur") else None) if x)
    history = (f"{mail['n']} emails with us, last {mail['last']}" if mail["n"] else "no emails with us yet")
    review = {"state": "needs_review", "added_by": "marketplace import", "added_on": today.isoformat(),
              "reasons": reasons, "size": measured}
    cur.execute(
        """update crm_bulk_listings
              set context = context || jsonb_build_object('review', %s::jsonb, 'owner', %s),
                  next_action = %s, next_due = %s, waiting_on = 'us', waiting_since = %s, updated_at = now()
            where id = %s""",
        (json.dumps(review), owner,
         f"Review: confirm {party} is a genuine bulk buyer and the size"
         + (f" (about {measured['total_kwh']:,} kWh)" if measured.get("total_kwh") else "") + ", then qualify or close",
         next_working_day(today), today, listing_id))
    cur.execute(
        """insert into crm_bulk_listing_activity (bulk_listing_id, kind, title, body, data)
           values (%s, 'research', %s, %s, %s::jsonb)""",
        (listing_id, "Added from a marketplace request: needs review",
         "\n".join([f"Size: {size_line}.", f"Why it was added: {'; '.join(reasons)}.", f"Buyer: {email}, {history}"
                    + (f", {others} other open Bulk Trades listings." if others else "."),
                    f"Their words: {(request.get('details') or request.get('wants') or '').strip()[:600]}",
                    f"Request: {row.get('source_url')}"]),
         json.dumps({"review": review, "mail_count": mail["n"], "mail_last": str(mail["last"]) if mail["last"] else None,
                     "other_open_listings": others, "source_url": row.get("source_url")})))
    return listing_id


ARCHIVE_TABLE = "buyer_interest_alert_resync_20261118"


def resync(cur, search_rows, today, apply):
    """Re-derive the Wants of every current saved search through the current code, then merge duplicates.

    A search's old lines whose key is no longer produced are deleted; the produced lines are upserted. Two saved_search
    lines of one company with the same product_key become one (earliest first_seen, latest last_seen, union of
    source_refs, the line of a real search, else the earliest, keeps its saved_search_id). Returns (report lines, lost searches). With apply, every touched row
    is archived first. The caller owns the transaction.
    """
    cur.execute("set local lock_timeout = '3s'")
    if apply:
        cur.execute(f"create table if not exists {ARCHIVE_TABLE} (like buyer_interest)")
        cur.execute(f"alter table {ARCHIVE_TABLE} add column if not exists archived_at timestamptz not null default now()")

    def archive(ids):
        if apply and ids:
            cur.execute(f"insert into {ARCHIVE_TABLE} select b.*, now() from buyer_interest b where b.id = any(%s::text[]) "
                        f"and not exists (select 1 from {ARCHIVE_TABLE} a where a.id = b.id)", (list(ids),))  # first state wins

    changes, lost, current = {}, [], []
    for row in search_rows:
        if row.get("unsubscribed"):
            continue
        sid = row["source_id"].removeprefix("saved_search:")
        cur.execute("select id, company_id, product_key from buyer_interest where kind = 'saved_search' and saved_search_id = %s "
                    "order by product_key", (sid,))
        old = cur.fetchall()
        company = old[0]["company_id"] if old else existing_company_id(cur, row.get("email"))
        if not company:
            continue
        current.append(sid)
        row["company_id"] = company
        # Any saved_search line of the company can be shared by this search, so all of them are archived first.
        cur.execute("select id from buyer_interest where kind = 'saved_search' and company_id = %s", (company,))
        archive([line["id"] for line in cur.fetchall()])
        cur.execute("select min(first_seen) as first from buyer_interest where kind = 'saved_search' and saved_search_id = %s", (sid,))
        first_seen = cur.fetchone()["first"]
        survey.upsert_saved_search_interest(cur, row, today=today)
        if first_seen:  # a replaced key keeps when the search was first seen, not the confirmation date
            cur.execute("update buyer_interest set first_seen = least(first_seen, %s) "
                        "where kind = 'saved_search' and (saved_search_id = %s or %s = any(source_refs)) and updated_at = now()",
                        (first_seen, sid, f"saved_search:{sid}"))
        # now() is the transaction start: only lines written here match. A line shared with another search or request
        # sits under that one's saved_search_id and carries this search's ref.
        cur.execute("select id, product_key, saved_search_id = %s as own, updated_at = now() as fresh from buyer_interest "
                    "where kind = 'saved_search' and (saved_search_id = %s or %s = any(source_refs))", (sid, sid, f"saved_search:{sid}"))
        after = cur.fetchall()
        stale = [line["id"] for line in after if line["own"] and not line["fresh"]]
        if stale:
            cur.execute("delete from buyer_interest where id = any(%s::text[])", (stale,))
        new = sorted(line["product_key"] for line in after if line["fresh"])
        if old and not new:
            lost.append(f"{row['email']} | search {sid[:8]} | old keys {[l['product_key'] for l in old]} produce no Want")
        changes.setdefault(company, []).append(
            f"search {sid[:8]}: {[line['product_key'] for line in old] or 'no lines'} -> {new or 'no lines'}")

    merged = {}
    # Lines of current searches and of sourcing requests (the import also writes those as saved_search lines).
    scope = "kind = 'saved_search' and (saved_search_id = any(%s::text[]) or saved_search_id like 'sourcing\\_request:%%')"
    cur.execute(f"select company_id, product_key from buyer_interest where {scope} group by 1, 2 having count(*) > 1", (current,))
    for dup in cur.fetchall():
        cur.execute("""select id, saved_search_id, first_seen, last_seen, expires_on, source_refs from buyer_interest
                       where {scope} and company_id = %s and product_key = %s
                       order by saved_search_id like 'sourcing\\_request:%%', first_seen, created_at, saved_search_id""".replace("{scope}", scope),
                    (current, dup["company_id"], dup["product_key"]))
        lines = cur.fetchall()
        keep, others = lines[0], lines[1:]
        archive([line["id"] for line in lines])
        refs = sorted({ref for line in lines for ref in line["source_refs"]})
        expires = None if any(line["expires_on"] is None for line in lines) else max(line["expires_on"] for line in lines)
        cur.execute("delete from buyer_interest where id = any(%s::text[])", ([line["id"] for line in others],))
        cur.execute("update buyer_interest set first_seen = %s, last_seen = %s, source_refs = %s::text[], expires_on = %s, "
                    "updated_at = now() where id = %s",
                    (min(line["first_seen"] for line in lines), max(line["last_seen"] for line in lines), refs, expires, keep["id"]))
        merged.setdefault(dup["company_id"], []).append(
            f"merged {len(lines)} lines of {dup['product_key']} into search {str(keep['saved_search_id'])[:8]}")

    report = []
    ids = list(set(changes) | set(merged))
    cur.execute("select id, name from crm_companies where id = any(%s::text[])", (ids,))
    names = {c["id"]: c["name"] for c in cur.fetchall()}
    for company in sorted(ids, key=lambda c: (names.get(c) or "", c)):
        report.append(f"{names.get(company) or '(no name)'} [{company}]")
        report += [f"    {line}" for line in changes.get(company, []) + merged.get(company, [])]
    return report, lost


def main():
    import psycopg2
    import psycopg2.extras
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dsn", default="host=/var/run/postgresql dbname=denchclaw")
    parser.add_argument("--json", help="read saved searches from a JSON file instead of the platform")
    parser.add_argument("--requests-json", help="read sourcing requests from a JSON file instead of the platform")
    parser.add_argument("--platform-env", default=str(PLATFORM_ENV), help="env file with the platform URL and key")
    parser.add_argument("--apply", action="store_true", help="write; without it nothing is saved")
    parser.add_argument("--resync", action="store_true",
                        help="re-derive the Wants of every current saved search and merge duplicate lines (dry run unless --apply)")
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
    if args.resync:
        conn = psycopg2.connect(args.dsn)
        with conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            report, lost = resync(cur, search_rows, dt.date.today(), args.apply)
            if not args.apply:
                conn.rollback()
        conn.close()
        print("\n".join(report))
        print(f"LOST (old Wants with no replacement): {len(lost)}")
        for line in lost:
            print(f"    {line}")
        print(f"{'applied' if args.apply else 'dry run, nothing saved'}: {len(report)} lines for {len(search_rows)} mapped saved searches")
        return 0
    request_rows = [row for row in (map_sourcing_request(request) for request in requests) if row]
    requests_by_source = {f"sourcing_request:{request['id']}": request for request in requests}
    notes = []
    rows = search_rows + request_rows
    skipped = len(searches) - len(search_rows)
    skipped_requests = len(requests) - len(request_rows)

    # The gate's mail-domain lookups shell out to dig: do them all before any database lock, once per domain.
    mx_seen = {}

    def has_mx(domain):
        if domain not in mx_seen:
            mx_seen[domain] = gate.domain_has_mx(domain)
        return mx_seen[domain]
    checks = {source: gate.check(request, has_mx) for source, request in requests_by_source.items()}

    conn = psycopg2.connect(args.dsn)
    added = closed = 0
    gated_out = []
    today = dt.date.today()
    with conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        for row in rows:
            unsubscribed = row.pop("unsubscribed", False)
            # Every confirmed search is a saved_search want: open while alerts are on, expired when unsubscribed.
            # An unsubscribed one keeps its history but never creates a company, and never becomes a demand row.
            if unsubscribed:
                row["company_id"] = existing_company_id(cur, row.get("email"))
                row["unsubscribed_on"] = row.get("unsubscribed_on") or today.isoformat()
                survey.upsert_saved_search_interest(cur, row, unsubscribed=True, today=today)
                continue
            survey.link(cur, row)
            survey.upsert_saved_search_interest(cur, row, today=today)
            request = requests_by_source.get(row["source_id"])
            reasons = measured = None
            if request is not None:
                # Only a genuine bulk purchase becomes a Bulk Trades request; the rest stay as interest on the profile.
                passes, reasons, measured = checks[row["source_id"]]
                cur.execute("select 1 from crm_bulk_listings where source_id = %s", (row["source_id"],))
                if not passes and not cur.fetchone():
                    gated_out.append(f"{row['email']} | {row['wants'][:50]} | {'; '.join(reasons)}")
                    continue
            new = survey.insert(cur, row)
            added += new
            if new and request is not None:
                flag_for_review(cur, row, request, reasons, measured, today)
            if new and request and is_recent(request):
                notes.append(announcement(request, row))
            gone = False
            if not args.quiet and not args.announce:
                state = "add" if new else "already in"
                print(f"{state}{' and close' if gone else ''}: {row['buyer']} | {row['wants'][:70]} | {row['source_id']}"
                      f" | company {'linked' if row.get('company_id') else 'not in CRM'}")
                if new and row.get("spec"):
                    print(f"    spec {json.dumps(row['spec'], ensure_ascii=False)}")
        if not args.apply:
            conn.rollback()
    if gated_out and not args.quiet and not args.announce:
        print(f"kept off Bulk Trades (profile interest only): {len(gated_out)}")
        for line in gated_out:
            print(f"    {line}")
    conn.close()
    verb = "added" if args.apply else "would add"
    summary = (f"{verb} {added} and {'closed' if args.apply else 'would close'} {closed} of {len(search_rows)} saved"
               f" searches and {len(request_rows)} sourcing requests ({skipped} searches and {skipped_requests}"
               f" requests skipped: unconfirmed, internal or test; {len(gated_out)} requests kept off Bulk Trades by the bulk gate)")
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
