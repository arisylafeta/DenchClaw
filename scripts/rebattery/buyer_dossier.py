#!/usr/bin/env python3
"""Buyer dossier: parse, validate, and derive the flat `buyer_profile` today's readers use.

A buyer dossier is Markdown with YAML frontmatter (schema: workspace/buyer-dossiers-pilot/TEMPLATE.md).
`crm_companies.buyer_profile` becomes a derived copy of that frontmatter: the existing TypeScript and
Python readers keep reading `chemistries`, `formats`, `makes`, `cell_makers`, `part_numbers`,
`kwh_min`, `kwh_max` and `wants`, while the whole frontmatter travels under `dossier`.

Everything here is pure: parse and map take text and return data. The only database access is the
read-only SELECT behind the `diff` command.

Canonical value lists mirror `crm_bulk_attribute_options` (side='demand', type='set'), which is the
source `BUY_BOX` reads at runtime. They are copied here so this module stays stdlib+yaml and testable
without a database.

Usage:
  python3 scripts/rebattery/buyer_dossier.py check <file.md>...
  python3 scripts/rebattery/buyer_dossier.py map <file.md>
  python3 scripts/rebattery/buyer_dossier.py diff <file.md> --company-id <id> [--dsn DSN]
"""
import argparse
import datetime as dt
import json
import re
import sys
from pathlib import Path

import yaml

# --- controlled values -------------------------------------------------------------------------
# Format values are Title Case and chemistry values upper case because that is what the readers
# compare: scoreBuyer upper-cases chemistries and compares formats case-insensitively, demand-match
# compares formats exactly and chemistries upper-cased.
CHEMISTRIES = ["LFP", "NMC", "NCA", "LMO", "LMFP", "LTO", "Sodium-ion", "Lead-acid", "Mixed"]
FORMATS = ["Cells", "Modules", "Packs", "Systems"]
MAKES = [
    "Tesla", "VW Group", "Renault", "Nissan", "Hyundai or Kia", "BMW or Mini", "Mercedes-Benz",
    "Stellantis", "Ford", "GM", "BYD", "MG or SAIC", "Volvo or Polestar", "JLR", "Toyota or Lexus",
]
CELL_MAKERS = [
    "CATL", "LG", "Samsung SDI", "SK On", "Panasonic", "BYD", "EVE", "CALB", "Gotion",
    "Northvolt", "AESC",
]
# Not in the registry yet but named by real dossiers; matching is plain text so they still help.
EXTRA_CELL_MAKERS = ["Kokam", "Svolt", "Farasis", "Lishen"]
BUYER_TYPES = ["integrator", "trader", "recycler", "module_builder", "rnd", "oem", "other"]
INTENTS = ["reuse", "repair", "cells", "recycling"]
PRODUCT_STATUSES = ["bought", "asked", "said_interested", "declined"]
ACTIVE_STATUSES = ["bought", "asked", "said_interested"]
CELL_FORMATS = ["18650", "21700", "prismatic", "pouch", "Cylindrical"]
CADENCES = ["one_off", "repeat", "standing"]
COLLECTS = ["own_haulier", "needs_delivery", "either"]
DECISION_SPEEDS = ["fast", "normal", "slow"]
PRICE_BASES = ["paid", "quoted_by_buyer", "stated_target"]
EVIDENCE_REQUIRED = [
    "tested_soh", "bms_access", "bms_data", "label_photos", "pack_photos", "interior_photos",
    "sds", "un383", "test_report", "sample_pack", "provenance", "waste_code",
]

TOP_LEVEL_KEYS = [
    "company_id", "company", "buyer_type", "intent", "countries", "products", "rules_out",
    "substitution", "price", "evidence_required", "quantity", "logistics", "capability",
    "decision_speed", "last_verified", "conflicts", "alerts",
    "needs_continuity", "timing", "origins", "min_soh",
]
PRODUCT_KEYS = [
    "part_number", "platform", "make", "model", "format", "chemistry", "kwh", "module_series",
    "cell_format", "status", "seen", "src",
]
PRICE_KEYS = ["eur_per_kwh", "eur_per_unit", "currency_original", "basis", "incoterm", "seen", "src"]
RULES_OUT_KEYS = ["chemistries", "formats", "damaged", "bess_systems", "other"]
ALERT_KEYS = ["label", "filters", "status", "seen", "src"]
TIMING_KEYS = ["max_lead_days", "notes"]
# A list entry is a plain value, or a mapping that dates the evidence for it.
ENTRY_KEYS = ["value", "seen", "src"]

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_SPLIT_RE = re.compile(r"[/,;|]|\band\b", re.IGNORECASE)


# --- parsing -----------------------------------------------------------------------------------
def _jsonable(value):
    """YAML turns unquoted dates into date objects; JSON columns and diffs need plain types."""
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, (dt.date, dt.datetime)):
        return value.isoformat()[:10]
    return value


def _as_dict(value):
    """A dict or an empty one; keeps callers safe on malformed input."""
    return value if isinstance(value, dict) else {}


def parse(markdown):
    """(frontmatter dict, body str). Missing or broken frontmatter yields ({}, whole text)."""
    text = (markdown or "").lstrip("\ufeff")
    if not text.startswith("---"):
        return {}, text
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}, text
    raw = parts[1]
    body = parts[2].lstrip("\r\n")
    try:
        data = yaml.safe_load(raw)
    except yaml.YAMLError:
        return {}, text
    if not isinstance(data, dict):
        return {}, text
    return _as_dict(_jsonable(data)), body


def load(path):
    return parse(Path(path).read_text(encoding="utf-8"))


# --- validation --------------------------------------------------------------------------------
def _is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _date_error(value):
    """None when the value is a valid YYYY-MM-DD date, else a short reason."""
    if isinstance(value, (dt.date, dt.datetime)):
        return None
    if isinstance(value, str) and not value.strip():
        return None
    if not isinstance(value, str) or not DATE_RE.match(value):
        return f"{value!r} is not a YYYY-MM-DD date"
    try:
        dt.date.fromisoformat(value)
    except ValueError:
        return f"{value!r} is not a real date"
    return None


def _check_enum(errors, where, value, allowed, label):
    # An empty YAML value left from the template means "not stated", not a wrong value.
    if value is None or (isinstance(value, str) and not value.strip()):
        return
    if not isinstance(value, str):
        errors.append(f"{where}: {label} must be a string, got {type(value).__name__}")
        return
    lowered = {a.lower(): a for a in allowed}
    if value.lower() not in lowered:
        errors.append(f"{where}: {value!r} is not a valid {label} ({', '.join(allowed)})")


def _check_list(errors, where, value, allowed=None, label="value"):
    if value is None:
        return
    if not isinstance(value, list):
        errors.append(f"{where}: must be a list, got {type(value).__name__}")
        return
    if allowed is None:
        return
    for i, item in enumerate(value):
        _check_enum(errors, f"{where}[{i}]", item, allowed, label)


def entry_value(item):
    """The value of a rules_out or evidence_required entry: a plain string, or its {value, ...} mapping."""
    if isinstance(item, dict):
        value = item.get("value")
        return value if isinstance(value, str) else None
    return item if isinstance(item, str) else None


def _check_entry_list(errors, where, value, allowed=None, label="value"):
    """A list whose items are plain values, or {value, seen, src} mappings that date the evidence.

    The plain form stays valid, so existing dossiers need no edit.
    """
    if value is None:
        return
    if not isinstance(value, list):
        errors.append(f"{where}: must be a list, got {type(value).__name__}")
        return
    for i, item in enumerate(value):
        item_where = f"{where}[{i}]"
        if isinstance(item, dict):
            for key in sorted(set(item) - set(ENTRY_KEYS)):
                errors.append(f"{item_where}.{key}: unknown key (allowed: {', '.join(ENTRY_KEYS)})")
            if not isinstance(item.get("value"), str) or not item["value"].strip():
                errors.append(f"{item_where}.value: required text")
            if "seen" in item:
                reason = _date_error(item["seen"])
                if reason:
                    errors.append(f"{item_where}.seen: {reason}")
            if "src" in item and not isinstance(item["src"], str):
                errors.append(f"{item_where}.src: must be text")
            if allowed:
                _check_enum(errors, item_where, item.get("value"), allowed, label)
            continue
        if not isinstance(item, str) or not item.strip():
            errors.append(f"{item_where}: must be text or a mapping with value (and seen, src)")
            continue
        if allowed:
            _check_enum(errors, item_where, item, allowed, label)


def validate(frontmatter):
    """Human-readable errors; an empty list means the dossier can be synced."""
    if not isinstance(frontmatter, dict):
        return ["frontmatter: not a mapping"]
    errors = []
    unknown = sorted(set(frontmatter) - set(TOP_LEVEL_KEYS))
    for key in unknown:
        errors.append(f"{key}: unknown top-level key (allowed: {', '.join(TOP_LEVEL_KEYS)})")

    if not isinstance(frontmatter.get("company_id", ""), (str, int)):
        errors.append("company_id: must be a string")
    _check_enum(errors, "buyer_type", frontmatter.get("buyer_type"), BUYER_TYPES, "buyer_type")
    _check_list(errors, "intent", frontmatter.get("intent"), INTENTS, "intent")
    _check_entry_list(errors, "evidence_required", frontmatter.get("evidence_required"), EVIDENCE_REQUIRED,
                      "evidence_required")
    _check_enum(errors, "decision_speed", frontmatter.get("decision_speed"), DECISION_SPEEDS,
                "decision_speed")
    if "last_verified" in frontmatter:
        reason = _date_error(frontmatter["last_verified"])
        if reason:
            errors.append(f"last_verified: {reason}")

    continuity = frontmatter.get("needs_continuity")
    if continuity is not None and not isinstance(continuity, bool):
        errors.append(f"needs_continuity: must be true, false or null, got {continuity!r}")

    timing = frontmatter.get("timing")
    if timing is not None and not isinstance(timing, dict):
        errors.append("timing: must be a mapping")
    elif isinstance(timing, dict):
        for key in sorted(set(timing) - set(TIMING_KEYS)):
            errors.append(f"timing.{key}: unknown key (allowed: {', '.join(TIMING_KEYS)})")
        lead = timing.get("max_lead_days")
        if lead is not None and (not isinstance(lead, int) or isinstance(lead, bool) or lead < 0):
            errors.append(f"timing.max_lead_days: must be a whole number of days, got {lead!r}")
        notes = timing.get("notes")
        if notes is not None and not isinstance(notes, str):
            errors.append(f"timing.notes: must be text, got {type(notes).__name__}")

    origins = frontmatter.get("origins")
    if origins is not None:
        if not isinstance(origins, list):
            errors.append("origins: must be a list of ISO-2 country codes")
        else:
            for i, origin in enumerate(origins):
                if not isinstance(origin, str) or not re.fullmatch(r"[A-Za-z]{2}", origin.strip()):
                    errors.append(f"origins[{i}]: {origin!r} is not an ISO-2 country code")

    min_soh = frontmatter.get("min_soh")
    if min_soh is not None:
        if not _is_number(min_soh):
            errors.append(f"min_soh: must be a number 0-100, got {min_soh!r}")
        elif not 0 <= float(min_soh) <= 100:
            errors.append(f"min_soh: {min_soh!r} is outside 0-100")

    quantity = frontmatter.get("quantity") or {}
    if not isinstance(quantity, dict):
        errors.append("quantity: must be a mapping")
    else:
        for key in ("min_units", "typical_units"):
            value = quantity.get(key)
            if value is not None and not _is_number(value):
                errors.append(f"quantity.{key}: must be a number, got {value!r}")
        _check_enum(errors, "quantity.cadence", quantity.get("cadence"), CADENCES, "cadence")
        whole_batch = quantity.get("whole_batch_ok")
        if whole_batch is not None and not isinstance(whole_batch, bool):
            errors.append(f"quantity.whole_batch_ok: must be true, false or null, got {whole_batch!r}")

    substitution = frontmatter.get("substitution") or {}
    if not isinstance(substitution, dict):
        errors.append("substitution: must be a mapping")
    else:
        tolerance = substitution.get("kwh_tolerance")
        if tolerance is not None and not _is_number(tolerance):
            errors.append(f"substitution.kwh_tolerance: must be a number, got {tolerance!r}")

    logistics = frontmatter.get("logistics") or {}
    if not isinstance(logistics, dict):
        errors.append("logistics: must be a mapping")
    else:
        _check_enum(errors, "logistics.collects", logistics.get("collects"), COLLECTS, "collects")

    rules_out = frontmatter.get("rules_out") or {}
    if not isinstance(rules_out, dict):
        errors.append("rules_out: must be a mapping")
    else:
        for key in sorted(set(rules_out) - set(RULES_OUT_KEYS)):
            errors.append(f"rules_out.{key}: unknown key (allowed: {', '.join(RULES_OUT_KEYS)})")
        _check_entry_list(errors, "rules_out.chemistries", rules_out.get("chemistries"), CHEMISTRIES,
                          "chemistry")
        _check_entry_list(errors, "rules_out.formats", rules_out.get("formats"), FORMATS, "format")
        for key in ("damaged", "bess_systems"):
            value = rules_out.get(key)
            if value is not None and not isinstance(value, bool):
                errors.append(f"rules_out.{key}: must be true, false or null, got {value!r}")
        _check_entry_list(errors, "rules_out.other", rules_out.get("other"))

    products = frontmatter.get("products") or []
    if not isinstance(products, list):
        errors.append("products: must be a list")
        products = []
    for i, product in enumerate(products):
        where = f"products[{i}]"
        if not isinstance(product, dict):
            errors.append(f"{where}: must be a mapping")
            continue
        for key in sorted(set(product) - set(PRODUCT_KEYS)):
            errors.append(f"{where}.{key}: unknown key (allowed: {', '.join(PRODUCT_KEYS)})")
        if not product.get("status"):
            errors.append(f"{where}.status: required (one of {', '.join(PRODUCT_STATUSES)})")
        _check_enum(errors, f"{where}.status", product.get("status"), PRODUCT_STATUSES, "status")
        if not product.get("format"):
            errors.append(f"{where}.format: required (one of {', '.join(FORMATS)})")
        _check_enum(errors, f"{where}.format", product.get("format"), FORMATS, "format")
        _check_enum(errors, f"{where}.chemistry", product.get("chemistry"), CHEMISTRIES, "chemistry")
        _check_enum(errors, f"{where}.cell_format", product.get("cell_format"), CELL_FORMATS,
                    "cell_format")
        kwh = product.get("kwh")
        if kwh is not None:
            values = kwh if isinstance(kwh, list) else [kwh]
            for j, value in enumerate(values):
                if not _is_number(value):
                    errors.append(f"{where}.kwh[{j}]: must be a number, got {value!r}")
        if "seen" in product:
            reason = _date_error(product["seen"])
            if reason:
                errors.append(f"{where}.seen: {reason}")

    prices = frontmatter.get("price") or []
    if not isinstance(prices, list):
        errors.append("price: must be a list")
        prices = []
    for i, price in enumerate(prices):
        where = f"price[{i}]"
        if not isinstance(price, dict):
            errors.append(f"{where}: must be a mapping")
            continue
        for key in sorted(set(price) - set(PRICE_KEYS)):
            errors.append(f"{where}.{key}: unknown key (allowed: {', '.join(PRICE_KEYS)})")
        for key in ("eur_per_kwh", "eur_per_unit"):
            value = price.get(key)
            if value is not None and not _is_number(value):
                errors.append(f"{where}.{key}: must be a number, got {value!r}")
        _check_enum(errors, f"{where}.basis", price.get("basis"), PRICE_BASES, "basis")
        if "seen" in price:
            reason = _date_error(price["seen"])
            if reason:
                errors.append(f"{where}.seen: {reason}")

    alerts = frontmatter.get("alerts")
    if alerts is not None:
        if not isinstance(alerts, list):
            errors.append("alerts: must be a list")
        else:
            for i, alert in enumerate(alerts):
                where = f"alerts[{i}]"
                if not isinstance(alert, dict):
                    errors.append(f"{where}: must be a mapping")
                    continue
                for key in sorted(set(alert) - set(ALERT_KEYS)):
                    errors.append(f"{where}.{key}: unknown key (allowed: {', '.join(ALERT_KEYS)})")
                if not alert.get("label"):
                    errors.append(f"{where}.label: required")
                if not isinstance(alert.get("filters"), dict):
                    errors.append(f"{where}.filters: required mapping of platform filters")
                if "seen" in alert:
                    reason = _date_error(alert["seen"])
                    if reason:
                        errors.append(f"{where}.seen: {reason}")
    return errors


# --- mapping to buyer_profile ------------------------------------------------------------------
def _canonical(value, allowed):
    """The canonical spelling of a controlled value, or None."""
    if not isinstance(value, str) or not value.strip():
        return None
    lookup = {a.lower(): a for a in allowed}
    return lookup.get(value.strip().lower())


def _make_groups(make):
    """(vehicle make groups, cell makers) named by one product `make` string.

    Product makes are sometimes lists ("MG, Stellantis, Tesla") or compound ("Stellantis / FPT /
    Kokam"), so each token is mapped on its own. FPT and PSA belong to the Stellantis group in the
    dossiers' own wording. Unrecognised tokens map to nothing rather than inventing a group.
    """
    groups, cells = [], []
    for token in _SPLIT_RE.split(make or ""):
        token = token.strip()
        if not token:
            continue
        key = " ".join(token.lower().split())
        if key in MAKE_ALIASES:
            group = MAKE_ALIASES[key]
            if group not in groups:
                groups.append(group)
        elif key in CELL_MAKER_ALIASES:
            maker = CELL_MAKER_ALIASES[key]
            if maker not in cells:
                cells.append(maker)
    return groups, cells


MAKE_ALIASES = {}
for _groups, _words in {
    "Tesla": ["tesla"],
    "VW Group": ["vw", "vw group", "volkswagen", "volkswagen group", "audi", "skoda", "seat",
                 "cupra", "porsche", "bentley", "lamborghini"],
    "Renault": ["renault", "dacia", "alpine"],
    "Nissan": ["nissan", "infiniti"],
    "Hyundai or Kia": ["hyundai", "kia", "genesis"],
    "BMW or Mini": ["bmw", "mini"],
    "Mercedes-Benz": ["mercedes", "mercedes-benz", "mercedes benz", "smart"],
    "Stellantis": ["stellantis", "psa", "peugeot", "citroen", "citroën", "opel", "vauxhall",
                   "fiat", "jeep", "ds", "alfa romeo", "alfa", "abarth", "lancia", "fpt",
                   "fpt industrial"],
    "Ford": ["ford"],
    "GM": ["gm", "general motors", "chevrolet", "cadillac", "gmc", "buick", "opel gm"],
    "BYD": ["byd", "findreams"],
    "MG or SAIC": ["mg", "saic", "maxus", "roewe"],
    "Volvo or Polestar": ["volvo", "polestar", "lynk", "lynk & co"],
    "JLR": ["jlr", "jaguar", "land rover", "range rover"],
    "Toyota or Lexus": ["toyota", "lexus"],
}.items():
    for _word in _words:
        MAKE_ALIASES[_word] = _groups

CELL_MAKER_ALIASES = {}
for _maker, _words in {
    "CATL": ["catl"],
    "LG": ["lg", "lg chem", "lg energy solution", "lg energy"],
    "Samsung SDI": ["samsung", "samsung sdi"],
    "SK On": ["sk on", "sk innovation"],
    "Panasonic": ["panasonic", "sanyo"],
    "BYD": ["byd", "findreams"],
    "EVE": ["eve", "eve energy"],
    "CALB": ["calb"],
    "Gotion": ["gotion", "gotion high-tech"],
    "Northvolt": ["northvolt"],
    "AESC": ["aesc", "envision aesc"],
    "Kokam": ["kokam"],
    "Svolt": ["svolt"],
    "Farasis": ["farasis"],
    "Lishen": ["lishen"],
}.items():
    for _word in _words:
        CELL_MAKER_ALIASES[_word] = _maker


def _kwh_values(product):
    kwh = product.get("kwh")
    if kwh is None:
        return []
    values = kwh if isinstance(kwh, list) else [kwh]
    return [float(v) for v in values if _is_number(v)]


def _product_label(product):
    """Short label for a wants line: platform, else make, else model, else chemistry."""
    for key in ("platform", "make", "model"):
        value = product.get(key)
        if isinstance(value, str) and value.strip():
            text = " ".join(value.split())
            if text.lower() in ("other", "mixed"):
                continue
            return text if len(text) <= 60 else text[:57].rstrip(" ,;") + "..."
    return _canonical(product.get("chemistry"), CHEMISTRIES) or ""


def _wants_line(product):
    kwh = _kwh_values(product)
    if len(kwh) == 1:
        capacity = f"{kwh[0]:g} kWh"
    elif len(kwh) > 1:
        capacity = f"{min(kwh):g}-{max(kwh):g} kWh"
    else:
        capacity = ""
    fmt = _canonical(product.get("format"), FORMATS)
    format_word = fmt.lower() if fmt else ""
    seen = product.get("seen")
    status = str(product.get("status") or "").replace("_", " ")
    suffix = " ".join(x for x in (status, str(seen) if seen else "") if x)
    parts = [x for x in (_product_label(product), capacity, format_word) if x]
    line = " ".join(parts) or "Batteries"
    return f"{line} ({suffix})" if suffix else line


def to_buyer_profile(frontmatter):
    """The derived flat profile: only what current readers compare, plus the full dossier.

    Products that are bought, asked or said_interested drive the buy box. Declined products are
    history and are excluded. `rules_out` removes a chemistry or format; its entries are plain
    values or {value, seen, src} mappings, and only the value matters here. `origins` and `min_soh`
    pass through under their own flat names because the readers already understand them, and are
    left out when the dossier does not state them. Deterministic: same frontmatter, same output.
    """
    frontmatter = _as_dict(_jsonable(frontmatter or {}))
    products = [p for p in (frontmatter.get("products") or []) if isinstance(p, dict)]
    active = [p for p in products if p.get("status") in ACTIVE_STATUSES]

    rules_out = _as_dict(frontmatter.get("rules_out"))
    blocked_chems = {_canonical(entry_value(c), CHEMISTRIES) for c in (rules_out.get("chemistries") or [])}
    blocked_formats = {_canonical(entry_value(f), FORMATS) for f in (rules_out.get("formats") or [])}

    chemistries, formats, makes, cell_makers, part_numbers = [], [], [], [], []
    kwh = []
    wants = []

    for product in active:
        chemistry = _canonical(product.get("chemistry"), CHEMISTRIES)
        if chemistry and chemistry not in blocked_chems and chemistry not in chemistries:
            chemistries.append(chemistry)
        fmt = _canonical(product.get("format"), FORMATS)
        if fmt and fmt not in blocked_formats and fmt not in formats:
            formats.append(fmt)
        groups, cells = _make_groups(product.get("make"))
        for group in groups:
            if group not in makes:
                makes.append(group)
        for maker in cells:
            if maker not in cell_makers:
                cell_makers.append(maker)
        part_number = product.get("part_number")
        if isinstance(part_number, str) and part_number.strip() and part_number.strip() not in part_numbers:
            part_numbers.append(part_number.strip())
        kwh.extend(_kwh_values(product))
        line = _wants_line(product)
        if line not in wants:
            wants.append(line)

    order = {value: i for i, value in enumerate(MAKES)}
    makes.sort(key=lambda m: order.get(m, len(order)))
    order = {value: i for i, value in enumerate(CELL_MAKERS + EXTRA_CELL_MAKERS)}
    cell_makers.sort(key=lambda m: order.get(m, len(order)))
    order = {value: i for i, value in enumerate(CHEMISTRIES)}
    chemistries.sort(key=lambda c: order.get(c, len(order)))
    order = {value: i for i, value in enumerate(FORMATS)}
    formats.sort(key=lambda f: order.get(f, len(order)))

    profile = {
        "chemistries": chemistries,
        "formats": formats,
        "makes": makes,
        "cell_makers": cell_makers,
        "part_numbers": part_numbers,
        "kwh_min": min(kwh) if kwh else None,
        "kwh_max": max(kwh) if kwh else None,
        "wants": "\n".join(wants),
        "dossier": frontmatter,
    }
    # Whole numbers read better in JSON and in the old columns.
    for key in ("kwh_min", "kwh_max"):
        if profile[key] is not None and float(profile[key]).is_integer():
            profile[key] = int(profile[key])

    # Sourcing origins and a minimum SoH have flat names the readers already look for.
    origins = []
    for origin in frontmatter.get("origins") or []:
        code = origin.strip().upper() if isinstance(origin, str) else ""
        if re.fullmatch(r"[A-Z]{2}", code) and code not in origins:
            origins.append(code)
    if origins:
        profile["origins"] = origins
    min_soh = frontmatter.get("min_soh")
    if isinstance(min_soh, (int, float)) and not isinstance(min_soh, bool):
        profile["min_soh"] = int(min_soh) if float(min_soh).is_integer() else float(min_soh)
    return profile


# --- diff --------------------------------------------------------------------------------------
def _as_set(value):
    if isinstance(value, list):
        return [str(v) for v in value]
    if isinstance(value, str) and "\n" in value:
        return [line for line in value.split("\n") if line]
    return None


def diff_profiles(old, new):
    """Per key: added/removed list values, or old/new scalars. Keys without a difference are absent."""
    old = old or {}
    new = new or {}
    diff = {}
    for key in list(dict.fromkeys([*old, *new])):
        before, after = old.get(key), new.get(key)
        if before == after:
            continue
        before_list, after_list = _as_set(before), _as_set(after)
        if before_list is not None or after_list is not None:
            before_list = before_list or []
            after_list = after_list or []
            added = [v for v in after_list if v not in before_list]
            removed = [v for v in before_list if v not in after_list]
            if added or removed:
                diff[key] = {"added": added, "removed": removed}
            continue
        diff[key] = {"old": before, "new": after}
    return diff


def _read_profile(company_id, dsn):
    import psycopg2
    import psycopg2.extras

    conn = psycopg2.connect(dsn)
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("select buyer_profile from crm_companies where id = %s", (company_id,))
            row = cur.fetchone()
    finally:
        conn.close()
    return None if row is None else (row["buyer_profile"] or {})


def _print_diff(diff):
    if not diff:
        print("no change")
        return
    for key in sorted(diff):
        change = diff[key]
        if key == "dossier":
            new = change.get("new") or {}
            products = new.get("products") or []
            print(f"+ dossier: full frontmatter ({len(new)} keys, {len(products)} products)")
            continue
        if "added" in change or "removed" in change:
            for value in change.get("added", []):
                print(f"+ {key}: {value}")
            for value in change.get("removed", []):
                print(f"- {key}: {value}")
        else:
            print(f"~ {key}: {json.dumps(change['old'], ensure_ascii=False)}"
                  f" -> {json.dumps(change['new'], ensure_ascii=False)}")


# --- CLI ---------------------------------------------------------------------------------------
def main(argv=None):
    parser = argparse.ArgumentParser(description="Buyer dossier parse, validate and map.")
    sub = parser.add_subparsers(dest="command", required=True)
    check = sub.add_parser("check", help="print validation errors for dossier files")
    check.add_argument("files", nargs="+")
    map_cmd = sub.add_parser("map", help="print the derived buyer_profile JSON")
    map_cmd.add_argument("file")
    diff_cmd = sub.add_parser("diff", help="diff a dossier against the stored buyer_profile")
    diff_cmd.add_argument("file")
    diff_cmd.add_argument("--company-id")
    diff_cmd.add_argument("--dsn", default="host=/var/run/postgresql dbname=denchclaw")
    args = parser.parse_args(argv)

    if args.command == "check":
        failed = False
        for path in args.files:
            frontmatter, _ = load(path)
            errors = validate(frontmatter)
            if errors:
                failed = True
                print(f"{path}: {len(errors)} error(s)")
                for error in errors:
                    print(f"  {error}")
            else:
                print(f"{path}: ok")
        return 1 if failed else 0

    if args.command == "map":
        frontmatter, _ = load(args.file)
        errors = validate(frontmatter)
        if errors:
            for error in errors:
                print(f"error: {error}", file=sys.stderr)
            return 1
        print(json.dumps(to_buyer_profile(frontmatter), indent=2, ensure_ascii=False))
        return 0

    frontmatter, _ = load(args.file)
    errors = validate(frontmatter)
    if errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        return 1
    company_id = args.company_id or frontmatter.get("company_id")
    if not company_id:
        print("error: no company_id on the dossier and none given", file=sys.stderr)
        return 1
    stored = _read_profile(company_id, args.dsn)
    if stored is None:
        print(f"error: no crm_companies row {company_id}", file=sys.stderr)
        return 1
    _print_diff(diff_profiles(stored, to_buyer_profile(frontmatter)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
