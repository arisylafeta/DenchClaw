#!/usr/bin/env python3
"""Imports buyer survey answers into Bulk Trades demand as stated standing buy-boxes.

  demand_survey_import.py --formbricks                 # show what the Formbricks buyer survey would add
  demand_survey_import.py --csv FILE.csv               # the same for a Typeform demand survey CSV export
  demand_survey_import.py --opportunities              # old crm_commercial_opportunities demand rows, as requests
  demand_survey_import.py --rows FILE.json             # reviewed rows, e.g. estimated buy-boxes from a buyer review
  ... --apply                                          # write them

Each answer becomes one row keyed by (source_kind, source_id), so a re-run or a scheduled run adds nothing
twice. Answers map onto the lists in apps/web/lib/buy-box-spec.json; anything that does not map (use,
timing, capabilities, voltage, risk answers, regions) goes into the row's note in the buyer's words.
ReBattery staff and QA submissions are skipped. Unfinished Formbricks responses are kept when they
hold at least one answer. Each row is linked to the CRM person by email and to that person's company.
"""
import argparse
import csv
import datetime as dt
import json
import re
import subprocess
import sys
import uuid
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
BUY_BOX = json.loads((REPO / "apps/web/lib/buy-box-spec.json").read_text())
FORMBRICKS_CONTAINER = "formbricks-postgres-1"
FORMBRICKS_SURVEY = "Buyer Sourcing Criteria"

INTERNAL_EMAILS = {"ari.sylafeta@gmail.com", "alexgpolglase@gmail.com", "agjpolglase@gmail.com"}


def internal(email):
    email = (email or "").strip().lower()
    return email.endswith("@rebattery.io") or email in INTERNAL_EMAILS or email.startswith("qa-")


# ---------------------------------------------------------------------------
# Typeform demand survey (CSV export: one column per question, one per multi-select option)
# ---------------------------------------------------------------------------

CAR_MAKES = {
    "Tesla": "Tesla", "Volkswagen Group (VW, Audi, Skoda, Porsche, MEB)": "VW Group", "Renault or Dacia": "Renault",
    "Nissan": "Nissan", "Hyundai or Kia": "Hyundai or Kia", "BMW or Mini": "BMW or Mini", "Mercedes-Benz": "Mercedes-Benz",
    "Stellantis (Peugeot, Citroën, Fiat, Vauxhall, Jeep)": "Stellantis", "Ford": "Ford", "General Motors": "GM",
    "BYD": "BYD", "MG or SAIC": "MG or SAIC", "Volvo or Polestar": "Volvo or Polestar", "Jaguar Land Rover": "JLR",
    "Toyota or Lexus": "Toyota or Lexus",
}
TYPEFORM_OPTIONS = {
    **{label: ("makes", value) for label, value in CAR_MAKES.items()},
    "Complete pack": ("formats", "Packs"), "Module": ("formats", "Modules"), "Cell": ("formats", "Cells"),
    "Cylindrical": ("cell_formats", "Cylindrical"), "Prismatic": ("cell_formats", "Prismatic"), "Pouch": ("cell_formats", "Pouch"),
    "LFP": ("chemistries", "LFP"), "NMC": ("chemistries", "NMC"), "NCA or NCMA": ("chemistries", "NCA"),
    "LMO": ("chemistries", "LMO"), "LMFP": ("chemistries", "LMFP"), "LTO": ("chemistries", "LTO"),
    "Lead-acid": ("chemistries", "Lead-acid"), "Sodium-ion": ("chemistries", "Sodium-ion"),
    "Mixed chemistries in one batch": ("chemistries", "Mixed"),
    "Surplus or new old stock — never used": ("conditions", "New or surplus"),
    "Second-life — removed from a vehicle or storage system": ("conditions", "Second-life, tested"),
    "Recall stock — unused, subject to an OEM recall": ("conditions", "Recall stock"),
    "Production scrap or B-grade cells": ("conditions", "B-grade or production scrap"),
    "Bus, truck or commercial vehicle (Iveco, Scania, Daimler Truck)": ("origins", "Bus or truck"),
    "Grid or containerised storage systems (Sungrow, BYD, Tesla Megapack)": ("origins", "Stationary storage"),
    "CATL": ("cell_makers", "CATL"), "LG Energy Solution": ("cell_makers", "LG"), "Samsung SDI": ("cell_makers", "Samsung SDI"),
    "SK On": ("cell_makers", "SK On"), "Panasonic": ("cell_makers", "Panasonic"), "BYD or FinDreams": ("cell_makers", "BYD"),
    "EVE": ("cell_makers", "EVE"), "CALB": ("cell_makers", "CALB"), "Gotion": ("cell_makers", "Gotion"),
    "Northvolt": ("cell_makers", "Northvolt"), "AESC": ("cell_makers", "AESC"),
    "BMS or CAN readout — SOH estimate, cell voltages, fault codes": ("evidence", "BMS readout"),
    "Capacity test — full charge and discharge cycle": ("evidence", "Capacity test"),
    "Internal resistance or DCIR": ("evidence", "Internal resistance"),
    "Usage history — cycle count, SOC window, charge behaviour": ("evidence", "Usage history"),
    "Any documented method, as long as the method is stated": ("evidence", "Any stated method"),
    "None — we'd test it ourselves": ("evidence", "None, they test"),
}
KWH_BANDS = {"Under 2 kWh": (0, 2), "2 to 10 kWh": (2, 10), "10 to 30 kWh": (10, 30), "30 to 60 kWh": (30, 60),
             "60 to 100 kWh": (60, 100), "Over 100 kWh": (100, None)}
# Options kept in the note in the buyer's terms: the question behind them is not a spec field, or is ambiguous.
NOTE_OPTIONS = {
    "Voltage": ["12V", "24V", "48V", "96 to 200V", "200 to 450V", "Above 450V"],
    "Can do": ["Dismantle packs down to modules", "Test and grade modules or cells", "Repair or replace a BMS",
               "Rebuild or re-weld cells", "Recycle unusable material", "None of these — we need it ready to install"],
    "Risk question": ["Fire or thermal-event history", "Water or impact damage", "No test data at all",
                      "Unknown or incomplete provenance", "None of these"],
}
NOTE_STEMS = [
    ("Use", "What will you use these batteries for?"), ("Stage", "Where are you in the process?"),
    ("Bought in the last 12 months", "How much battery capacity have you bought in the last 12 months?"),
    ("Holding them back", "What's holding you back from buying more than you do today?"),
    ("Chasing", "Anything specific you're chasing?"), ("Constraints", "Any hard physical or interface constraints?"),
    ("Last batch", "What was the last batch you bought?"), ("Painful about it", "What was painful about that purchase?"),
    ("Also", "Anything else we should know?"),
]
UNITS = {"packs": "packs", "modules": "modules", "cells": "cells", "kwh": "kWh", "mwh": "MWh", "systems": "systems"}


def number(value):
    """The first number in a text: "1,000" is a thousand, "2.5" two and a half, "20 to 30" is 20."""
    text = re.sub(r"(?<=\d),(?=\d{3}\b)", "", str(value or ""))
    match = re.search(r"\d+(?:[.,]\d+)?", text)
    return float(match.group().replace(",", ".")) if match else None


def whole(value):
    return int(value) if value is not None and float(value).is_integer() else value


def add(spec, key, value):
    if value not in spec.setdefault(key, []):
        spec[key].append(value)


def wants_line(use, spec):
    parts = [" / ".join(spec.get("formats", [])), " / ".join(spec.get("chemistries", []))]
    if "kwh_min" in spec or "kwh_max" in spec:
        low, high = spec.get("kwh_min"), spec.get("kwh_max")
        parts.append(f"{whole(low)}+ kWh" if high is None else f"{whole(low or 0)}-{whole(high)} kWh")
    if "min_soh" in spec:
        parts.append(f"{whole(spec['min_soh'])}%+ SOH")
    line = ", ".join(p for p in parts if p) or "Batteries"
    return f"{line}, for {use[0].lower() + use[1:]}" if use else line


def map_typeform_row(header, row):
    """One Typeform demand survey response (CSV header and row) as a demand row, or None to skip."""
    first = {}  # the first column wins for repeated headers ("Other", "No preference")
    for i, name in enumerate(header):
        first.setdefault(name, i)

    def stem(name):
        i = first.get(name)
        return row[i].strip() if i is not None and i < len(row) else ""

    email = (stem("What's your email?") or stem("email")).lower()
    if not email or internal(email) or stem("Response Type") not in ("", "completed"):
        return None
    if re.search(r"recycl", stem("What will you use these batteries for?"), re.I):
        return None  # demand is reuse and second life only
    spec, notes, kwh = {}, [], []
    note_hits = {label: [] for label in NOTE_OPTIONS}
    for i, name in enumerate(header):
        value = row[i].strip() if i < len(row) else ""
        if not value:
            continue
        if name in TYPEFORM_OPTIONS and value == name:
            key, mapped = TYPEFORM_OPTIONS[name]
            add(spec, key, mapped)
            if key == "makes":
                add(spec, "origins", "Passenger EV")
        elif name in KWH_BANDS and value == name:
            kwh.append(KWH_BANDS[name])
        for label, options in NOTE_OPTIONS.items():
            if name in options and value == name:
                note_hits[label].append(value)
    preferred = TYPEFORM_OPTIONS.get(stem("Preferred chemistry"))
    if preferred:
        add(spec, *preferred)
    if kwh:
        spec["kwh_min"] = min(low for low, _ in kwh)
        if all(high is not None for _, high in kwh):
            spec["kwh_max"] = max(high for _, high in kwh)
    lowest = stem("What's the lowest condition you'd accept?")
    soh = re.search(r"(\d+)\s*(?:to\s*\d+\s*)?%\s*SOH", lowest)
    if soh:
        spec["min_soh"] = int(soh.group(1))
    mixed = stem("Can you take mixed makes and models in one batch?").lower()
    if mixed.startswith(("yes", "no")):
        spec["mixed_ok"] = mixed.startswith("yes")

    use = stem("What will you use these batteries for?")
    if use == "Other":
        use = stem("Other") or use  # the first "Other" column is the use question's
    for label, question in NOTE_STEMS:
        if stem(question):
            notes.append(f"{label}: {stem(question)}")
    if lowest:
        notes.append(f"Lowest condition: {lowest}")
    for label, hits in note_hits.items():
        if hits:
            notes.append(f"{label}: {', '.join(hits)}")
    unit = UNITS.get(stem("In what unit?").lower())
    first_order = number(stem("Realistic first order"))
    if first_order:
        notes.append(f"First order: {whole(first_order)} {unit or stem('In what unit?')}".strip())
    monthly = number(stem("Monthly volume once it's working"))
    price = number(stem("What's the most you'd pay per kWh?"))
    currency = stem("Currency").upper()
    submitted = stem("Submit Date (UTC)")[:10] or None
    return {
        "kind": "standing", "basis": "stated", "email": email,
        "contact": stem("What's your name?") or None, "company": stem("company") or None,
        "wants": wants_line(use, spec), "location": stem("Which country will they be delivered to?") or None,
        "volume": whole(monthly) if monthly and unit else None, "volume_unit": unit if monthly and unit else None,
        "max_price": whole(price) if price and currency in BUY_BOX["currencies"] else None,
        "price_currency": currency if price and currency in BUY_BOX["currencies"] else None,
        "price_unit": "kWh" if price and currency in BUY_BOX["currencies"] else None,
        "spec": spec, "note": "\n".join(notes) or None, "observed_on": submitted,
        "source_kind": "survey", "source_id": f"typeform:{stem('#')}", "source_label": "Typeform demand survey",
    }


# ---------------------------------------------------------------------------
# Formbricks buyer survey ("Buyer Sourcing Criteria", the platform sidebar form)
# ---------------------------------------------------------------------------

FB_MAP = {
    "formats": {"Cells": ("formats", "Cells"), "Modules": ("formats", "Modules"), "Packs": ("formats", "Packs"),
                "Complete systems": ("formats", "Systems")},
    "chemistries": {c: ("chemistries", c) for c in ("LFP", "NMC", "NCA", "LMO", "Lead-acid")},
    "condition": {"New surplus": ("conditions", "New or surplus"), "Used and tested": ("conditions", "Second-life, tested"),
                  "Tested / working": ("conditions", "Second-life, tested"),
                  "Used and untested": ("conditions", "Second-life, untested"),
                  "Damaged / scrap": ("conditions", "Damaged or end of life")},
    "sources": {"EV packs": ("origins", "Passenger EV"), "Truck / eBus batteries": ("origins", "Bus or truck"),
                "Industrial batteries": ("origins", "Industrial"), "Modules": ("formats", "Modules")},
    "requirements": {"Photos": ("evidence", "Photos"), "UN / shipping documents": ("evidence", "UN 38.3 and shipping documents"),
                     "None / flexible": ("evidence", "None, they test")},
}
FB_NOTE_LABEL = {"formats": "Formats", "chemistries": "Chemistries", "condition": "Condition", "sources": "Sources",
                 "requirements": "Needs"}


def as_list(value):
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    return [str(value).strip()] if str(value or "").strip() else []


def still_open(response, now):
    """An unfinished response touched in the last day may still be in progress."""
    raw = str(response.get("updated_at") or response.get("created_at") or "")
    try:
        touched = dt.datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return False
    if touched.tzinfo is None:
        touched = touched.replace(tzinfo=dt.timezone.utc)
    return now - touched < dt.timedelta(days=1)


def map_formbricks(response, now=None):
    """One Formbricks response ({id, created_at, finished, data, variables, contactAttributes}) as a demand row, or None."""
    now = now or dt.datetime.now(dt.timezone.utc)
    data = response.get("data") or {}
    hidden = {**(response.get("contactAttributes") or {}), **(response.get("variables") or {})}
    email = str(data.get("email") or hidden.get("email") or "").strip().lower()
    if not email or internal(email):
        return None
    spec, notes, unmapped = {}, [], {}
    for field, mapping in FB_MAP.items():
        for value in as_list(data.get(field)):
            if value in mapping:
                add(spec, *mapping[value])
            else:
                unmapped.setdefault(field, []).append(value)
    soh = number(data.get("min_soh"))
    if soh is not None and 0 <= soh <= 100:
        spec["min_soh"] = whole(soh)
    if not spec and not any(as_list(data.get(k)) for k in ("use_case", "lot_size", "regions", "notes")):
        return None  # an unfinished response with nothing in it
    if re.search(r"recycl", str(data.get("use_case") or ""), re.I):
        return None  # demand is reuse and second life only
    if not response.get("finished") and still_open(response, now):
        return None  # the buyer may still be filling it in
    if not response.get("finished"):
        notes.append("Unfinished survey.")
    use = str(data.get("use_case") or "").strip()
    if use:
        notes.append(f"Use: {use}")
    for field, values in unmapped.items():
        notes.append(f"{FB_NOTE_LABEL[field]}: {', '.join(values)}")
    if as_list(data.get("regions")):
        notes.append(f"Sources from: {', '.join(as_list(data['regions']))}")
    if str(data.get("notes") or "").strip():
        notes.append(f"Also: {str(data['notes']).strip()}")
    lot = str(data.get("lot_size") or "").strip()
    created = str(response.get("created_at") or "")[:10] or None
    return {
        "kind": "standing", "basis": "stated", "email": email, "contact": None,
        "company": str(hidden.get("company") or data.get("company") or "").strip() or None,
        "wants": wants_line(use, spec), "quantity": f"Lots of {lot}" if lot else None, "location": None,
        "spec": spec, "note": "\n".join(notes) or None, "observed_on": created,
        "source_kind": "survey", "source_id": f"formbricks:{response['id']}", "source_label": "Formbricks buyer survey",
    }


def fetch_formbricks():
    """Every response to the buyer survey, read from the Formbricks database container. A plain select, not COPY:
    COPY's text format would escape the backslashes inside the JSON."""
    sql = f"""select coalesce(json_agg(json_build_object('id', r.id, 'created_at', r.created_at, 'updated_at', r.updated_at,
      'finished', r.finished, 'data', r.data, 'variables', r.variables, 'contactAttributes', r."contactAttributes")
      order by r.created_at), '[]') from "Response" r join "Survey" s on s.id = r."surveyId" where s.name = '{FORMBRICKS_SURVEY}'"""
    out = subprocess.run(["docker", "exec", "-i", FORMBRICKS_CONTAINER, "sh", "-c",
                          'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -At -v ON_ERROR_STOP=1'],
                         input=sql, capture_output=True, text=True, check=True)
    return json.loads(out.stdout or "[]")


# ---------------------------------------------------------------------------
# Old commercial opportunities (the first attempt at demand)
# ---------------------------------------------------------------------------

def load_opportunities(cur):
    cur.execute("""select o.id, o.title, o.company_id, c.name as company, o.contact_person_id, p.email, p.full_name,
                          o.chemistry, o.format, o.quantity::text as quantity, o.location_country, o.notes, o.created_at::date as created,
                          o.deadline_at::date as deadline
                   from crm_commercial_opportunities o left join crm_companies c on c.id = o.company_id
                   left join crm_people p on p.id = o.contact_person_id
                   where o.opportunity_type = 'demand' and o.status in ('draft', 'open', 'matched')""")
    rows = []
    for o in cur.fetchall():
        note = "\n".join(x for x in (o["notes"], o["chemistry"] and f"Chemistry: {o['chemistry']}",
                                      o["format"] and f"Format: {o['format']}") if x) or None
        wants = re.sub(rf"^{re.escape(o['company'] or '')}\s*[-:]\s*", "", o["title"]) if o["company"] else o["title"]
        rows.append({
            "kind": "request", "basis": None, "email": (o["email"] or "").lower() or None, "contact": o["full_name"],
            "company": o["company"], "company_id": o["company_id"], "person_id": o["contact_person_id"],
            "wants": wants[:1].upper() + wants[1:], "quantity": o["quantity"], "location": o["location_country"],
            "needed_by": str(o["deadline"]) if o["deadline"] else None,
            "spec": {}, "note": note, "observed_on": str(o["created"]),
            "source_kind": "import", "source_id": f"opportunity:{o['id']}", "source_label": "CRM opportunity",
        })
    return rows


# ---------------------------------------------------------------------------
# Reviewed rows (a buyer review's estimated or stated buy-boxes)
# ---------------------------------------------------------------------------

ROW_KEYS = {"kind", "basis", "buyer", "company_id", "person_id", "contact", "email", "wants", "quantity", "location", "note",
            "needed_by", "volume", "volume_unit", "max_price", "price_currency", "price_unit", "spec", "observed_on",
            "source_kind", "source_id", "source_label", "source_url", "source_quote"}


def load_rows(path):
    """{"rows": [...]} with the demand columns. Each row needs wants, a kind, a source_kind and a source_id; the
    spec keeps only values from the shared lists, and a basis or date that does not fit the kind is refused."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))  # the sibling module, from any working directory
    from bulk_trade_inbox_check import clean_structured
    rows = []
    with open(path) as handle:
        raw_rows = json.load(handle)["rows"]
    for i, raw in enumerate(raw_rows):
        unknown = set(raw) - ROW_KEYS
        if unknown:
            raise SystemExit(f"row {i}: unknown keys {sorted(unknown)}")
        if not raw.get("wants") or not raw.get("source_kind") or not raw.get("source_id"):
            raise SystemExit(f"row {i}: wants, source_kind and source_id are required")
        kind = raw.get("kind", "standing")
        basis = raw.get("basis", "estimated" if raw["source_kind"] == "research" else "stated") if kind == "standing" else None
        if kind == "request" and raw.get("basis") or kind == "standing" and raw.get("needed_by"):
            raise SystemExit(f"row {i}: a request has a date and no basis; a standing buy-box has a basis and no date")
        if basis not in (None, "estimated", "stated", "agreed"):
            raise SystemExit(f"row {i}: basis must be estimated, stated or agreed")
        structured = clean_structured({**raw, "kind": kind})
        rows.append({**{k: v for k, v in raw.items() if k not in ("spec", "volume", "volume_unit", "max_price",
                                                                 "price_currency", "price_unit", "needed_by")},
                     **structured, "kind": kind, "basis": basis,
                     "email": (raw.get("email") or "").lower() or None, "spec": structured.get("spec", {})})
    return rows


# ---------------------------------------------------------------------------
# Writing
# ---------------------------------------------------------------------------

def link(cur, row):
    """Fills person_id, company_id and the buyer name from the CRM: the person's company, else the survey's."""
    person = None
    if row.get("email"):
        cur.execute("""select p.id, p.full_name, p.company_id, c.name as company from crm_people p
                       left join crm_companies c on c.id = p.company_id
                       where lower(p.email) = %s order by p.updated_at desc nulls last limit 1""", (row["email"],))
        person = cur.fetchone()
    if not row.get("person_id"):
        row["person_id"] = person and person["id"]
    if not row.get("company_id"):
        row["company_id"] = person and person["company_id"]
    row["contact"] = row.get("contact") or (person and person["full_name"])
    company = None
    if row.get("company_id"):
        cur.execute("select name from crm_companies where id = %s", (row["company_id"],))
        company = cur.fetchone()
    row["buyer"] = (row.get("buyer") or (company and company["name"]) or (person and person["company"]) or row.get("company")
                    or row["contact"] or row["email"] or "Unknown buyer")
    return row


COLUMNS = ["kind", "basis", "buyer", "company_id", "person_id", "contact", "email", "wants", "quantity", "location", "note",
           "needed_by", "volume", "volume_unit", "max_price", "price_currency", "price_unit", "spec", "observed_on",
           "confirmed_on", "source_kind", "source_id", "source_label", "source_url", "source_quote"]


def insert(cur, row):
    """Adds the row unless its source is already in (then only a still-unfinished survey answer is refreshed).
    Returns True when a row was added or refreshed."""
    # A buyer's own answer confirms the buy-box on that date; our estimate confirms nothing.
    observed = row.get("observed_on") or dt.date.today().isoformat()
    confirmed = None if row.get("basis") == "estimated" else observed
    row = {**row, "observed_on": observed, "confirmed_on": confirmed, "spec": json.dumps(row.get("spec") or {})}
    values = [row.get(c) for c in COLUMNS]
    cur.execute(
        f"""insert into crm_bulk_trade_demand (id, {', '.join(COLUMNS)})
            values (%s, {', '.join(['%s'] * len(COLUMNS))})
            on conflict (source_kind, source_id) where source_id is not null do update set
              wants = excluded.wants, spec = excluded.spec, note = excluded.note, quantity = excluded.quantity,
              location = excluded.location, observed_on = excluded.observed_on, confirmed_on = excluded.confirmed_on,
              updated_at = now()
            -- Only an unfinished survey answer that nobody has touched since is replaced by the finished one.
            where crm_bulk_trade_demand.note like 'Unfinished survey.%%' and excluded.note is distinct from crm_bulk_trade_demand.note
              and crm_bulk_trade_demand.basis = 'stated' and crm_bulk_trade_demand.updated_at = crm_bulk_trade_demand.created_at
            returning id""",
        [f"btd_{uuid.uuid4()}", *values])
    return cur.fetchone() is not None


def main():
    import psycopg2
    import psycopg2.extras
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dsn", default="host=/var/run/postgresql dbname=denchclaw")
    parser.add_argument("--csv", action="append", default=[], help="a Typeform demand survey CSV export")
    parser.add_argument("--formbricks", action="store_true", help="read the Formbricks buyer survey")
    parser.add_argument("--formbricks-json", help="read Formbricks responses from a JSON file instead")
    parser.add_argument("--opportunities", action="store_true", help="old crm_commercial_opportunities demand rows")
    parser.add_argument("--rows", action="append", default=[], help="reviewed rows from a JSON file ({\"rows\": [...]})")
    parser.add_argument("--apply", action="store_true", help="write; without it nothing is saved")
    parser.add_argument("--quiet", action="store_true", help="print only the totals (for scheduled runs)")
    args = parser.parse_args()

    candidates, skipped = [], 0
    for path in args.csv:
        with open(path, encoding="utf-8-sig", newline="") as handle:
            header, *rows = list(csv.reader(handle))
        for row in rows:
            mapped = map_typeform_row(header, row)
            skipped += mapped is None
            candidates += [mapped] if mapped else []
    if args.formbricks or args.formbricks_json:
        if args.formbricks_json:
            with open(args.formbricks_json) as handle:
                responses = json.load(handle)
        else:
            responses = fetch_formbricks()
        for response in responses:
            mapped = map_formbricks(response)
            skipped += mapped is None
            candidates += [mapped] if mapped else []

    for path in args.rows:
        candidates += load_rows(path)

    conn = psycopg2.connect(args.dsn)
    added = 0
    with conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        if args.opportunities:
            candidates += load_opportunities(cur)
        for row in candidates:
            link(cur, row)
            new = insert(cur, row)
            added += new
            if not args.quiet:
                state = "add" if new else "already in"
                print(f"{state}: {row['buyer']} | {row['kind']} {row.get('basis') or ''} | {row['wants'][:80]}"
                      f" | {row['source_id']} | company {'linked' if row.get('company_id') else 'not in CRM'}")
                if new and row.get("spec"):
                    print(f"    spec {json.dumps(row['spec'], ensure_ascii=False)}")
        if not args.apply:
            conn.rollback()
    conn.close()
    print(f"{'added' if args.apply else 'would add'} {added} of {len(candidates)} ({skipped} skipped: internal, test or empty)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
