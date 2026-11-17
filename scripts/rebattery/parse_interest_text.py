#!/usr/bin/env python3
"""Turn free-text buyer wants into specific, dated buyer_interest lines (foundation step 2, the parse before 1d).

Two kinds of text hold product facts the structured buy box lacks:

  wants     companies whose buyer_profile.wants is free text ("MEB 55-84 kWh packs (asked 2026-10-07)") and whose own
            mastered lines are all broad. Date: the earliest buyer_profile change, else buyer_profiled_at.
  demand    closed research_profile, moved_to_profile and expired demand rows whose summary, note, quote or
            product_family name a product word the row's spec does not. Date: the row's observed_on.

A cheap model call (the Hermes gateway, like bulk_trade_inbox_check.call_model) reads several texts at once and
returns JSON only. Every answer is validated against a strict schema AND checked against the text: a make, model,
platform, part number, kWh figure, quantity, price, chemistry or format that the text does not state is rejected
with a reason, never repaired. kWh is never invented. Text the model cannot parse stays exactly as it is.

A price is always a target, never a hard limit: it is stored with price_basis 'target', and a flexible upper figure the text
states beside it (\"under $30/kWh, flexible up to $50\") is kept as price_max. Only a note that carries a price and a word
like flexible or \"up to\" is asked a second, small question for the flexible figure (the main answers stay as cached).
Matching never filters on either.

Notes that only guess what kind of company this is (\"could be a supplier or buyer\", \"likely trader/competitor\"), and notes
that say the company buys new cells only or has little fit for used stock, write no line (checked in code before the model is
asked). A named maker stays its own product: \"Donor modules/packs for Tesla and Bolt\" is Tesla modules and Tesla packs; a
bare model no maker owns (Bolt) is dropped, never written as any modules or any packs.

Accepted products become mastered lines through the same fact builder the importers use: kind 'interest' for what
the buyer stated, 'inferred' for research-sourced text; first_seen = last_seen = the source date; source_refs = the
source row plus parse:<run id>. The product key comes from the TypeScript builder (pack families included) through
apps/web/lib/match/product-key-cli.ts, or from the SQL helpers of migration 112 with --key-builder sql. Lines that
already exist (any other writer's, or this parser's) are left alone; the broad lines stay and specific ones are added.

Dry run by default: every batch (100 sources) runs in its own transaction and is rolled back. --apply needs --dsn.
Any run on a connection whose current_database() is denchclaw needs --i-have-approval. lock_timeout 3s and
statement_timeout 60s per batch. Re-running adds nothing: a source already parsed is skipped, and raw model answers
are cached under --cache-dir, so a re-run makes no model call.

  parse_interest_text.py --dsn <dsn>                     # dry run, model calls cached
  parse_interest_text.py --dsn <dsn> --apply             # write
  parse_interest_text.py --dsn <dsn> --sample 10         # also write the review sheet for Alex
"""
import argparse
import concurrent.futures
import datetime as dt
import hashlib
import json
import math
import os
import random
import re
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

REPO = Path(__file__).resolve().parents[2]
WEB = REPO / "apps" / "web"
HERMES_ENV = Path("/root/.hermes/.env")
GATEWAY_URL = os.environ.get("HERMES_API_BASE_URL", "http://127.0.0.1:8642") + "/v1/chat/completions"
DEFAULT_CACHE = Path("/root/.hermes/cache/scratch/parse-interest-cache")
DEFAULT_SAMPLE_OUT = Path("/root/.hermes/workspace/buyer-dossiers-pilot/foundation/parse-sample.md")
PROFILE_REASONS = ("research_profile", "moved_to_profile", "expired")
EXPIRY_DAYS = {"interest": 180, "inferred": 180}
TEXTS_PER_CALL = 8
DB_BATCH = 100
MAX_TEXT = 1500
FACT_COMBINATIONS = 12

FLEX_PROMPT = """You read a short note about what a buyer of used EV and industrial batteries wants. Each item gives the note and the
target price a reader already found in it. Say whether the note ALSO states a flexible upper figure for that same price, in the
same currency and unit: "under $30/kWh, flexible up to $50/kWh" has target 30 and flexible figure 50. Reply with ONLY a JSON
object, no prose:
{"results": [{"id": "<item id>", "price_max": <number or null>, "quote": "<the exact words of the note that state it, or null>"}, ...]}
Give one result for every item id. price_max is null unless the note states a higher figure the buyer would still accept.
A range of the target itself ("10-15") is not flexibility. Never calculate, convert or estimate a figure the note does not give."""
FLEX_WORDS = re.compile(r"flexib|up to|stretch|ceiling|at most|no more than|not more than|maximum|\bmax\b|as high as|could go|can go|willing to", re.I)
FLEX_PER_CALL = 8

PRODUCT_KEYS = ("make", "model", "platform", "part_number", "format", "chemistry", "kwh_min", "kwh_max",
                "cell_format", "quantity", "quantity_unit", "cadence", "price", "price_max", "price_currency", "price_unit",
                "status", "quote")
# Keys an earlier model answer (still in the cache) may lack: they read as null.
OPTIONAL_KEYS = ("price_max",)
FORMATS = ("pack", "module", "cell", "system")
CHEMISTRIES = ("LFP", "NMC", "NCA", "LTO", "NiMH", "LMO")
CURRENCIES = ("EUR", "USD", "GBP")
PRICE_UNITS = ("kWh", "pack", "cell")
CADENCES = ("one_off", "weekly", "monthly", "quarterly", "yearly", "ongoing")
STATUSES = ("asked", "said_interested")
STRING_KEYS = ("make", "model", "platform", "part_number", "cell_format", "quantity_unit", "quote")
NUMBER_KEYS = ("kwh_min", "kwh_max", "quantity", "price", "price_max")

SYSTEM_PROMPT = """You read short free-text notes about what a buyer of used EV and industrial batteries wants and list the
specific products each note states. You have no tools. Reply with ONLY a JSON object, no prose:
{"results": [{"id": "<note id>", "products": [ {product}, ... ]}, ...]}
Give one result for every note id you were sent; products is [] when the note names no product.
Every product has EXACTLY these keys (null when the note does not say):
  make          vehicle maker or, for cells, the cell maker, exactly as the note names it (Tesla, Nissan, Samsung SDI,
                Molicel). Only when the note names it, or when the model it names belongs to exactly one maker
                (Leaf is Nissan, Zoe is Renault, Model 3 is Tesla, i3 is BMW). Never guess a maker otherwise.
  model         vehicle or cell model as written (Leaf, Corsa-e, 50E)
  platform      shared platform or pack family as written (MEB, e-CMP, CMP)
  part_number   an OEM part number as written
  format        one of "pack", "module", "cell", "system" (a containerised or BESS unit is "system")
  chemistry     one of "LFP", "NMC", "NCA", "LTO", "NiMH", "LMO"
  kwh_min, kwh_max   numbers in kWh. A single figure goes in both. 1.26 MWh is 1260. Never calculate, estimate or
                complete a capacity the note does not give; null when it gives none.
  cell_format   as written (cylindrical, prismatic, pouch, 21700, 18650)
  quantity      one number; null for a range or an unclear amount
  quantity_unit packs, modules, cells, units, kWh, MWh, systems, containers, vehicles (as the note says)
  cadence       one of "one_off", "weekly", "monthly", "quarterly", "yearly", "ongoing"; only when the note says so
  price, price_currency ("EUR", "USD" or "GBP"), price_unit ("kWh", "pack" or "cell")  only what the buyer offers or
                targets, one number; null for a range
  status        "asked" when the note states a want or request, "said_interested" when it says they are open to or
                interested in it
  quote         the exact words of the note this product comes from, copied character for character (3 to 300 characters)
Rules: one product per distinct thing wanted; a note that says "Tesla packs and Nissan Leaf 40 kWh" is two products.
Use only what the note states. Never guess a chemistry or a capacity. Write out shorthand: "Model S/X and 3/Y" is Model S,
Model X, Model 3 and Model Y; "37501-GI300/GI301" is two part numbers, 37501-GI300 and 37501-GI301.
Ignore what the buyer sells, offers, refuses or does not want. A date in the note is not a quantity or a kWh figure.
An empty products list is a good answer."""

# ---------------------------------------------------------------------------
# Text helpers
# ---------------------------------------------------------------------------
_ACCENTS = str.maketrans("àáâãäåāăąçćčďèéêëēėęěìíîïīįñńňòóôõöøōőťùúûüūůűýÿžźżšśł",
                         "aaaaaaaaacccdeeeeeeeeiiiiiinnnooooooootuuuuuuuyyzzzssl")


def fold(text):
    """Lower case, accents off, letters and digits only."""
    return re.sub(r"[^a-z0-9]+", "", str(text or "").lower().translate(_ACCENTS))


def words(text):
    return set(re.findall(r"[a-z0-9]+", str(text or "").lower().translate(_ACCENTS)))


def squash(text):
    return re.sub(r"\s+", " ", str(text or "")).strip().lower()


ISO_DATE = re.compile(r"\b(19|20)\d{2}-\d{2}-\d{2}\b")
NUMBER_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
                "ten": 10, "eleven": 11, "twelve": 12, "dozen": 12, "twenty": 20, "fifty": 50, "hundred": 100}


def text_numbers(text):
    """Every number the text states (dates left out), with MWh figures also in kWh, as floats."""
    clean = ISO_DATE.sub(" ", str(text or ""))
    numbers = set()
    for token in re.findall(r"\d+(?:[.,]\d+)*", clean):
        variants = [token.replace(",", ""), token.replace(",", ".")]
        if re.fullmatch(r"\d{1,3}(?:[.,]\d{3})+", token):
            variants.append(re.sub(r"[.,]", "", token))  # 10.000 and 10,000 are ten thousand
        for variant in variants:
            try:
                numbers.add(float(variant))
            except ValueError:
                pass
    for token, _unit in re.findall(r"(\d+(?:[.,]\d+)?)\s*(mwh)\b", clean, re.I):
        try:
            numbers.add(float(token.replace(",", ".")) * 1000)
        except ValueError:
            pass
    for token, _unit in re.findall(r"(\d+(?:[.,]\d+)?)\s*(gwh)\b", clean, re.I):
        try:
            numbers.add(float(token.replace(",", ".")) * 1_000_000)
        except ValueError:
            pass
    tokens = words(clean)
    for word, value in NUMBER_WORDS.items():
        if word in tokens:
            numbers.add(float(value))
    return numbers


def number_in(value, numbers):
    return any(abs(value - known) <= 0.0501 + abs(known) * 1e-9 for known in numbers)


# Vehicle models that belong to one maker only, so a note that names the model implies the make. Reviewed, short on purpose.
IMPLIED_MAKES = {"leaf": "Nissan", "zoe": "Renault", "twizy": "Renault", "kangoo": "Renault", "prius": "Toyota",
                 "mirai": "Toyota", "ioniq": "Hyundai", "kona": "Hyundai", "i3": "BMW", "i4": "BMW", "ix3": "BMW", "taycan": "Porsche",
                 "etron": "Audi", "e208": "Peugeot", "e2008": "Peugeot", "corsae": "Vauxhall", "mokkae": "Vauxhall",
                 "modelx": "Tesla", "models": "Tesla", "model3": "Tesla", "modely": "Tesla", "boltev": "Chevrolet", "ampera": "Opel", "i-miev": "Mitsubishi", "imiev": "Mitsubishi", "eniro": "Kia", "niro": "Kia", "ev6": "Kia",
                 "id3": "Volkswagen", "id4": "Volkswagen", "egolf": "Volkswagen",
                 "enyaq": "Skoda", "fluence": "Renault", "i-pace": "Jaguar", "ipace": "Jaguar"}


def make_implied(make, model):
    """The make a reviewed model name implies, when it is the make given: Leaf is a Nissan."""
    key = fold(model)
    return bool(key) and any(fold(make) == fold(IMPLIED_MAKES[prefix]) for prefix in IMPLIED_MAKES if key.startswith(fold(prefix)))


def implied_make(model):
    """The one maker a reviewed model name belongs to (Leaf: Nissan), or None. Used when the note names a model and no maker."""
    key = fold(model)
    return next((IMPLIED_MAKES[prefix] for prefix in IMPLIED_MAKES if key and key.startswith(fold(prefix))), None)


MAKE_ALIASES = {"vw": ("vw", "volkswagen", "volkwagen"), "volkswagen": ("vw", "volkswagen", "volkwagen"),
                "mercedes": ("mercedes", "mercedesbenz", "mb"), "mercedesbenz": ("mercedes", "mercedesbenz", "mb"),
                "citroen": ("citroen", "citroën"), "skoda": ("skoda", "škoda"), "gm": ("gm", "generalmotors")}


def make_grounded(make, text):
    """Each make a value names (\"BMW / Volvo\" is two) appears in the text as a word or a multi-word name."""
    folded_text, tokens = fold(text), words(text)
    pieces = [p.strip() for p in re.split(r"\s*(?:,|/|&|\band\b)\s*", str(make), flags=re.I) if p.strip()] or [str(make)]
    for piece in pieces:
        key = fold(piece)
        options = MAKE_ALIASES.get(key, (key,))
        if not any((opt in tokens) if len(fold(opt)) < 4 else (fold(opt) in folded_text) for opt in options):
            return False
    return True


def part_fold(value):
    return fold(value).replace("o", "0")


GENERIC_MODEL_WORDS = {"model", "series", "gen", "generation", "phase", "type", "class"}


def code_grounded(value, text):
    """A model name or platform as the text writes it, ignoring case, spaces and hyphens. Slash shorthand counts:
    \"Model S/X\" holds Model S, because the S stands in the text as its own word."""
    if not fold(value):
        return False
    if fold(value) in fold(text):
        return True
    parts = words(value) - GENERIC_MODEL_WORDS
    return bool(parts) and len(parts) <= 2 and parts <= words(text) and all(
        len(part) > 1 or re.search(rf"(?<![a-z0-9]){part}(?![a-z0-9])", str(text).lower()) for part in parts)


SHORTHAND = re.compile(r"([A-Za-z0-9][A-Za-z0-9-]{4,})((?:\s*[/,]\s*[A-Za-z0-9-]{2,8})+)")


def part_grounded(value, text):
    """The code as the text writes it, or as its slash shorthand writes it: 37501-GI300/GI301 holds 37501-GI301."""
    wanted = part_fold(value)
    if len(wanted) < 4:
        return False
    if wanted in part_fold(text):
        return True
    for first, rest in SHORTHAND.findall(text):
        base = part_fold(first)
        for suffix in re.findall(r"[A-Za-z0-9-]+", rest):
            tail = part_fold(suffix)
            if tail and len(tail) < len(base) and base[:len(base) - len(tail)] + tail == wanted:
                return True
    return False


CHEMISTRY_WORDS = {
    "LFP": r"lfp|lifepo4?|lithium[\s-]*iron[\s-]*phosphate|lithium[\s-]*ferro[\s-]*phosphate",
    "NMC": r"nmc|ncm|nickel[\s-]*manganese[\s-]*cobalt",
    "NCA": r"nca|nickel[\s-]*cobalt[\s-]*alumin",
    "LTO": r"lto|titanate",
    "NiMH": r"nimh|ni-mh|nickel[\s-]*metal[\s-]*hydride",
    "LMO": r"lmo|manganese[\s-]*oxide",
}
FORMAT_WORDS = {
    "pack": r"packs?\b",
    "module": r"modules?\b",
    "cell": r"cells?\b|cylindrical|prismatic|pouch|\b(?:18650|21700|4680|26650)\b",
    "system": r"systems?\b|bess\b|container|cabinet|\brack",
}
CURRENCY_WORDS = {"EUR": r"€|\beur\b|\beuros?\b", "USD": r"\$|\busd\b|\bdollars?\b", "GBP": r"£|\bgbp\b|\bpounds?\b|sterling"}
UNIT_WORDS = {"kWh": r"kwh", "pack": r"packs?\b", "cell": r"cells?\b"}
CADENCE_WORDS = {
    "weekly": r"week", "monthly": r"month", "quarterly": r"quarter", "yearly": r"year|annual|p\.a\.",
    "ongoing": r"ongoing|on-going|regular|recurring|continu|steady|standing|repeat", "one_off": r"one[\s-]*off|once|single|just one|trial|test",
}
UNIT_STEMS = {"packs": "pack", "modules": "module", "cells": "cell", "units": "unit", "systems": "system",
              "containers": "container", "vehicles": "vehicle", "kwh": "kwh", "mwh": "mwh"}


def any_word(pattern, text):
    return re.search(pattern, str(text or ""), re.I) is not None


def normal_unit(unit):
    text = str(unit or "").strip().lower()
    if text in UNIT_STEMS:
        return {"kwh": "kWh", "mwh": "MWh"}.get(text, text)
    for plural, stem in UNIT_STEMS.items():
        if text == stem:
            return {"kwh": "kWh", "mwh": "MWh"}.get(plural, plural)
    return None


# ---------------------------------------------------------------------------
# Validation: strict shape, then grounding in the source text
# ---------------------------------------------------------------------------
class Rejected(Exception):
    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


def clean_product(raw):
    """Shape only: exact keys, types, enums. Returns the product with empty strings as None."""
    if not isinstance(raw, dict):
        raise Rejected("not_an_object")
    extra = set(raw) - set(PRODUCT_KEYS)
    if extra:
        raise Rejected("unknown_field:" + ",".join(sorted(extra)))
    missing = [key for key in PRODUCT_KEYS if key not in raw and key not in OPTIONAL_KEYS]
    if missing:
        raise Rejected("missing_field:" + ",".join(missing))
    product = {}
    for key in PRODUCT_KEYS:
        value = raw.get(key)
        if isinstance(value, str):
            value = value.strip() or None
        if value is None:
            product[key] = None
        elif key in STRING_KEYS:
            if not isinstance(value, str):
                raise Rejected(f"bad_type:{key}")
            product[key] = value
        elif key in NUMBER_KEYS:
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise Rejected(f"bad_type:{key}")
            if value <= 0 and key != "price":
                raise Rejected(f"bad_value:{key}")
            if value < 0:
                raise Rejected(f"bad_value:{key}")
            product[key] = float(value)
        else:
            product[key] = value
    for key, allowed in (("format", FORMATS), ("chemistry", CHEMISTRIES), ("price_currency", CURRENCIES),
                         ("price_unit", PRICE_UNITS), ("cadence", CADENCES), ("status", STATUSES)):
        if product[key] is not None and product[key] not in allowed:
            raise Rejected(f"bad_value:{key}")
    if product["price_max"] is not None and (product["price"] is None or product["price_max"] <= product["price"]):
        product["price_max"] = None  # a flexible figure is only kept beside a lower target
    if product["status"] is None:
        product["status"] = "asked"  # the note did not say how firm; the line kind comes from the source, not from this
    if product["kwh_min"] is not None and product["kwh_max"] is not None and product["kwh_min"] > product["kwh_max"]:
        raise Rejected("bad_value:kwh_range")
    if product["quote"] is None:
        raise Rejected("no_quote")
    if product["price"] is not None and product["price_unit"] is None and product["price_currency"] is None:
        pass  # a bare number is allowed to stay unitless; grounding still has to find it
    identity = ("make", "model", "platform", "part_number", "format", "chemistry", "kwh_min", "kwh_max", "cell_format")
    if not any(product[key] is not None for key in identity):
        raise Rejected("no_product_facts")
    return product


def ground_product(product, text):
    """Every value must be stated in, or directly implied by, the text. Raises Rejected with the first failure."""
    numbers = text_numbers(text)
    if not (3 <= len(product["quote"]) <= 300) or squash(product["quote"]) not in squash(text):
        raise Rejected("quote_not_in_text")
    if product["make"] and not make_grounded(product["make"], text):
        if not (product["model"] and code_grounded(product["model"], text) and make_implied(product["make"], product["model"])):
            raise Rejected("ungrounded:make")
    for key in ("model", "platform", "cell_format"):
        if product[key] and not code_grounded(product[key], text):
            raise Rejected(f"ungrounded:{key}")
    if product["part_number"] and not part_grounded(product["part_number"], text):
        raise Rejected("ungrounded:part_number")
    for key in ("kwh_min", "kwh_max"):
        if product[key] is not None and not number_in(product[key], numbers):
            raise Rejected(f"ungrounded:{key}")
    if product["chemistry"] and not any_word(CHEMISTRY_WORDS[product["chemistry"]], text):
        raise Rejected("ungrounded:chemistry")
    if product["format"] and not any_word(FORMAT_WORDS[product["format"]], text):
        raise Rejected("ungrounded:format")
    if product["quantity"] is not None:
        if not number_in(product["quantity"], numbers):
            raise Rejected("ungrounded:quantity")
        unit = normal_unit(product["quantity_unit"]) if product["quantity_unit"] else None
        if product["quantity_unit"] and unit is None:
            raise Rejected("ungrounded:quantity_unit")
        product["quantity_unit"] = unit
        if unit and UNIT_STEMS.get(unit.lower(), unit.lower()) not in squash(text):
            raise Rejected("ungrounded:quantity_unit")
    elif product["quantity_unit"]:
        product["quantity_unit"] = None  # a unit with no number says nothing
    if product["cadence"] and not any_word(CADENCE_WORDS[product["cadence"]], text):
        raise Rejected("ungrounded:cadence")
    if product["price"] is not None:
        if not number_in(product["price"], numbers):
            raise Rejected("ungrounded:price")
        if product["price_currency"] and not any_word(CURRENCY_WORDS[product["price_currency"]], text):
            raise Rejected("ungrounded:price_currency")
        if product["price_unit"] and not any_word(UNIT_WORDS[product["price_unit"]], text):
            raise Rejected("ungrounded:price_unit")
        if product["price_max"] is not None and not number_in(product["price_max"], numbers):
            raise Rejected("ungrounded:price_max")
    else:
        product["price_currency"] = product["price_unit"] = product["price_max"] = None
    return product


def validate_product(raw, text):
    return ground_product(clean_product(raw), text)


def product_signature(product):
    return tuple(product.get(key) for key in PRODUCT_KEYS if key not in ("quote", "status"))


def validate_response(payload, batch):
    """Check one model answer against the batch it answered.

    batch: {local id: text}. Returns {local id: {"products": [...], "rejected": [(raw, reason)], "status": str}}.
    status is 'parsed' (at least one product kept), 'no_products', 'rejected' (every product failed) or
    'missing' (the model skipped the id). A malformed answer raises ValueError.
    """
    if not isinstance(payload, dict) or not isinstance(payload.get("results"), list):
        raise ValueError("answer has no results list")
    out = {}
    for item in payload["results"]:
        if not isinstance(item, dict) or item.get("id") not in batch or set(item) - {"id", "products"}:
            continue  # an unknown id is dropped, never matched to a source by guesswork
        if item["id"] in out or not isinstance(item.get("products"), list):
            continue
        kept, rejected, seen = [], [], set()
        for raw in item["products"]:
            try:
                product = validate_product(raw, batch[item["id"]])
            except Rejected as exc:
                rejected.append((raw, exc.reason))
                continue
            signature = product_signature(product)
            if signature in seen:
                continue
            seen.add(signature)
            kept.append(product)
        status = "parsed" if kept else ("rejected" if rejected else "no_products")
        out[item["id"]] = {"products": kept, "rejected": rejected, "status": status}
    for local_id in batch:
        out.setdefault(local_id, {"products": [], "rejected": [], "status": "missing"})
    return out


# ---------------------------------------------------------------------------
# Which texts are worth a model call
# ---------------------------------------------------------------------------
VOCAB = set("""pack packs module modules cell cells system systems battery batteries used new ev evs bev bevs phev hybrid
hybrids lfp nmc nca lto lmo nimh cylindrical prismatic pouch storage stationary second life for and or the of in to with from we
our looking want wants need needs buy buying all any some more less not no only also but are is as at by on up per each asked
said interested passenger ess bms hv lv soh oem uk eu us usa europe european price kwh mwh wh modules/cells packs/modules
cells/modules cells/packs packs/cells various other others used/new premium little occasional conversions rebuilds rebuild
projects project redeploy test testing repair repairs custom kits kit channel group group's trader acts mostly especially
preferably approximately approx around about over under between high low grade quality tested untested damaged recycling
recycle scrap second-life ev/hybrid li-ion lithium ion power energy vehicle vehicles car cars bus buses truck trucks van
vans e-bike ebike scooter scooters motorcycle motorcycles marine industrial commercial residential grid backup solar
january february march april may june july august september october november december monday tuesday wednesday thursday
friday saturday sunday""".split())
SPEC_TEXT_KEYS = ("makes", "make", "models", "model", "chemistries", "chemistry", "formats", "format", "cell_makers",
                  "cell_maker", "part_numbers", "origins", "conditions", "product_family", "system_brands", "cell_formats",
                  "kwh", "kwh_min", "kwh_max", "min_soh", "volume", "volume_unit", "max_price")


def spec_words(spec):
    found = set()
    for key in SPEC_TEXT_KEYS:
        value = (spec or {}).get(key)
        for item in value if isinstance(value, list) else [value]:
            if item not in (None, "", {}, []):
                found.add(fold(item))
                found |= {fold(w) for w in re.findall(r"[A-Za-z0-9]+", str(item))}
    found.discard("")
    return found


def needs_parse(text, spec=None):
    """True when the text carries a word the structured spec does not: a figure, a part code or a proper name.

    Plain words (packs, modules, LFP, used) and anything the spec already holds do not count, so a note that only
    repeats its own buy box is not sent to the model.
    """
    known = spec_words(spec)
    clean = ISO_DATE.sub(" ", str(text or ""))
    for word in re.findall(r"[^\s\"'“”‘’()\[\],;:!?]+", clean):
        bare = word.strip(".,·|*-–—")
        if not bare or fold(bare) in known:
            continue
        if re.search(r"\d", bare):
            if re.fullmatch(r"(19|20)\d{2}", bare):
                continue
            return True
        if bare.lower() in VOCAB or any(part in VOCAB or fold(part) in known for part in re.split(r"[/\-–]", bare.lower()) if part):
            continue
        if bare[:1].isupper() or re.search(r"[a-z][A-Z]", bare):
            return True
    return False


# ---------------------------------------------------------------------------
# The model call, cached
# ---------------------------------------------------------------------------
def gateway_key():
    if os.environ.get("HERMES_API_KEY"):
        return os.environ["HERMES_API_KEY"]
    try:
        for line in HERMES_ENV.read_text().splitlines():
            if line.startswith("API_SERVER_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return None


def call_model(system, user, key):
    """One Hermes gateway call: JSON-only system prompt, temperature 0, no tools. Returns the reply text."""
    body = json.dumps({"model": "hermes-agent", "temperature": 0,
                       "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}).encode()
    request = urllib.request.Request(GATEWAY_URL, data=body, headers={
        "Authorization": f"Bearer {key}", "content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=300) as response:
        return json.loads(response.read())["choices"][0]["message"]["content"]


def json_object(content):
    match = re.search(r"\{.*\}", content or "", re.S)
    if not match:
        raise ValueError("model reply had no JSON object")
    return json.loads(match.group(0))


def user_message(batch):
    return json.dumps({"notes": [{"id": local, "text": text} for local, text in batch.items()]}, ensure_ascii=False)


class ModelRunner:
    """Sends batches of texts, caches what the model said, and counts what it did.

    Two caches sit under cache_dir: the raw reply of each batch (kept as the record of what the model returned) and, per
    text, the raw products the model gave for it. A re-run forms its batches from the texts nobody has answered yet, so
    it asks the model nothing it has already been asked. Answers are validated again on every read, never trusted
    from the cache.
    """

    def __init__(self, cache_dir, caller=None, key=None, cache_only=False, retries=2):
        self.cache_dir = Path(cache_dir)
        self.caller = caller or call_model
        self.key = key if key is not None else gateway_key()
        self.cache_only = cache_only
        self.retries = retries
        self.calls = 0
        self.cache_hits = 0
        self.failures = []
        self._lock = threading.Lock()

    @staticmethod
    def _digest(*parts):
        return hashlib.sha256("\n\x00\n".join(parts).encode("utf-8")).hexdigest()

    def _batch_path(self, user):
        return self.cache_dir / f"{self._digest(SYSTEM_PROMPT, user)}.json"

    def _text_path(self, text):
        return self.cache_dir / f"text-{self._digest(SYSTEM_PROMPT, text)}.json"

    def _store_texts(self, batch, payload):
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        for item in payload.get("results") or []:
            if isinstance(item, dict) and item.get("id") in batch and isinstance(item.get("products"), list):
                self._text_path(batch[item["id"]]).write_text(json.dumps(
                    {"text": batch[item["id"]], "products": item["products"]}, ensure_ascii=False))

    def _answer(self, batch):
        """The validated answer for these texts from the model (or the batch cache). Raises ValueError on failure."""
        user = user_message(batch)
        path = self._batch_path(user)
        last = None
        raw = json.loads(path.read_text())["reply"] if path.exists() else None
        if raw is not None:
            with self._lock:
                self.cache_hits += 1
        for attempt in range(self.retries + 1):
            if raw is None:
                if self.cache_only:
                    raise ValueError("not_cached")
                try:
                    with self._lock:
                        self.calls += 1
                    raw = self.caller(SYSTEM_PROMPT, user, self.key)
                except Exception as exc:  # noqa: BLE001
                    last, raw = f"model_error:{type(exc).__name__}", None
                    time.sleep(min(2 ** attempt, 8))
                    continue
            try:
                payload = json_object(raw)
                validate_response(payload, batch)
            except (ValueError, json.JSONDecodeError) as exc:
                last, raw = f"bad_answer:{exc}", None
                if path.exists():
                    path.unlink()  # a cached answer that no longer validates is not kept
                continue
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            if not path.exists():
                path.write_text(json.dumps({"at": dt.datetime.now(dt.timezone.utc).isoformat(), "ids": list(batch),
                                            "reply": raw}, ensure_ascii=False))
            self._store_texts(batch, payload)
            return payload
        raise ValueError(last or "unknown")

    def _flex_path(self, text, price):
        return self.cache_dir / f"flex-{self._digest(FLEX_PROMPT, text, repr(float(price)))}.json"

    def flex(self, items):
        """{local id: (price_max or None, quote or None)} for {local id: (text, price)}; cached per text and price.

        A reply that does not parse leaves its items out, so the caller keeps the target price alone."""
        out, missing = {}, {}
        for local, (text, price) in items.items():
            path = self._flex_path(text, price)
            if path.exists():
                got = json.loads(path.read_text())
                out[local] = (got["price_max"], got["quote"])
                with self._lock:
                    self.cache_hits += 1
            else:
                missing[local] = (text, price)
        if not missing or self.cache_only:
            return out
        user = json.dumps({"items": [{"id": local, "text": text, "target_price": price} for local, (text, price) in missing.items()]},
                          ensure_ascii=False)
        for attempt in range(self.retries + 1):
            try:
                with self._lock:
                    self.calls += 1
                payload = json_object(self.caller(FLEX_PROMPT, user, self.key))
                answers = {r["id"]: r for r in payload["results"] if isinstance(r, dict) and r.get("id") in missing}
                break
            except Exception as exc:  # noqa: BLE001
                with self._lock:
                    self.failures.append((f"flex_error:{type(exc).__name__}", list(missing)))
                answers = {}
                time.sleep(min(2 ** attempt, 8))
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        for local, (text, price) in missing.items():
            answer = answers.get(local)
            if answer is None:
                continue
            value, quote = answer.get("price_max"), answer.get("quote")
            value = float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None
            quote = quote if isinstance(quote, str) else None
            self._flex_path(text, price).write_text(json.dumps({"text": text, "price": price, "price_max": value, "quote": quote}, ensure_ascii=False))
            out[local] = (value, quote)
        return out

    def run(self, batch):
        """({local id: validate_response entry or None}, failure reason or None) for one batch of {local id: text}."""
        out, missing = {}, {}
        for local, text in batch.items():
            path = self._text_path(text)
            if path.exists():
                products = json.loads(path.read_text())["products"]
                out[local] = validate_response({"results": [{"id": local, "products": products}]}, {local: text})[local]
                with self._lock:
                    self.cache_hits += 1
            else:
                missing[local] = text
        if not missing:
            return out, None
        # The whole batch may be in the batch cache from an earlier run (it is the same request).
        asked = batch if self._batch_path(user_message(batch)).exists() else missing
        try:
            payload = self._answer(asked)
        except ValueError as exc:
            reason = str(exc)
            with self._lock:
                self.failures.append((reason, list(missing)))
            return {**out, **{local: None for local in missing}}, reason
        answered = validate_response(payload, asked)
        for local in missing:
            out[local] = answered[local]
        return out, None


# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------
def clip(text):
    text = re.sub(r"[ \t]+", " ", str(text or "")).strip()
    return text[:MAX_TEXT]


def is_inferred_demand(row):
    spec = row.get("spec") or {}
    return (row.get("closed_reason") == "research_profile" or row.get("source_kind") == "research"
            or str(spec.get("basis") or "").lower() in ("estimated", "researched", "inferred"))


def demand_text(row):
    parts = []
    for label, value in (("Summary", row.get("summary")), ("Note", row.get("note")), ("Quote", row.get("source_quote")),
                         ("Product family", (row.get("spec") or {}).get("product_family"))):
        if str(value or "").strip():
            parts.append(f"{label}: {clip(value)}")
    return clip("\n".join(parts))


def read_sources(cur, limit=None, only_companies=None):
    """Both source kinds as one list of dicts: id, ref, kind, company, text, date, spec, skip (a reason or None)."""
    cur.execute("""select c.id, c.name, c.buyer_profile, c.buyer_profile_basis, c.buyer_profiled_at, c.created_at::date as created,
                          c.buyer_dossier is not null as has_dossier,
                          (select ch.id from crm_buyer_profile_changes ch where ch.company_id = c.id and ch.field = 'buyer_profile'
                            order by ch.changed_at, ch.id limit 1) as change_id,
                          (select min(ch.changed_at)::date from crm_buyer_profile_changes ch
                            where ch.company_id = c.id and ch.field = 'buyer_profile') as first_change
                     from crm_companies c
                    where btrim(coalesce(c.buyer_profile->>'wants', '')) <> ''
                      and (%s::text[] is null or c.id = any(%s::text[])) order by c.id""" + (f" limit {int(limit)}" if limit else ""),
                (only_companies, only_companies))
    companies = cur.fetchall()
    cur.execute("""select company_id,
                          bool_or(kind in ('inferred', 'standing', 'interest') and ownership = 'mastered'
                                  and product_key_level <> 'broad' and not exists (
                                    select 1 from unnest(source_refs) r where r like 'parse:%')) as specific
                     from buyer_interest group by company_id""")
    specific = {row["company_id"]: bool(row["specific"]) for row in cur.fetchall()}
    sources = []
    for row in companies:
        profile = row["buyer_profile"] or {}
        when = row["first_change"] or row["buyer_profiled_at"] or row["created"]
        ref = f"crm:buyer_profile_change:{row['change_id']}" if row["change_id"] else f"crm:{row['id']}:wants"
        skip = "dossier_company" if row["has_dossier"] else ("already_specific" if specific.get(row["id"]) else None)
        sources.append({"id": f"wants:{row['id']}", "ref": ref, "kind": "wants", "company_id": row["id"], "company": row["name"],
                        "text": clip(profile.get("wants")), "date": str(when) if when else None, "spec": profile,
                        "line_kind": "interest" if row["buyer_profile_basis"] == "stated" else "inferred", "skip": skip})
    cur.execute("""select l.id, l.company_id, c.name, l.observed_on, l.created_at::date as created, l.closed_reason, l.source_kind,
                          l.summary, l.note, l.source_quote, l.spec, c.buyer_dossier is not null as has_dossier
                     from crm_bulk_listings l join crm_companies c on c.id = l.company_id
                    where l.kind = 'demand' and l.status = 'closed' and l.closed_reason = any(%s)
                      and (%s::text[] is null or l.company_id = any(%s::text[])) order by l.id"""
                + (f" limit {int(limit)}" if limit else ""), (list(PROFILE_REASONS), only_companies, only_companies))
    for row in cur.fetchall():
        when = row["observed_on"] or row["created"]
        sources.append({"id": f"demand:{row['id']}", "ref": f"crm:{row['id']}", "kind": "demand", "company_id": row["company_id"],
                        "company": row["name"], "text": demand_text(row), "date": str(when) if when else None,
                        "spec": row["spec"] or {}, "closed_reason": row["closed_reason"],
                        "line_kind": "inferred" if is_inferred_demand(row) else "interest",
                        "skip": "dossier_company" if row["has_dossier"] else None})
    return sources


def parsed_refs(cur, refs):
    """Which of these source refs already sit on a line a parse run wrote."""
    if not refs:
        return set()
    cur.execute("""select distinct r as ref from buyer_interest, unnest(source_refs) r
                    where source_refs && %s::text[] and r = any(%s::text[])
                      and exists (select 1 from unnest(source_refs) p where p like 'parse:%%')""", (list(refs), list(refs)))
    return {row["ref"] for row in cur.fetchall()}


# A note that only guesses what kind of company this is, or that says the company buys new cells only or has little fit
# for used stock, states no want we can use. These are the plain phrasings; the prompt asks the model for the same.
ROLE_GUESS_LEAD = re.compile(r"^\W*(?:summary:\s*)?(?:likely|probably|possibly|perhaps|may be|might be|could be)\b[^.;:\n]{0,40}"
                             r"\b(?:trader|competitor|supplier|reseller|broker|dealer|distributor|buyer)\b", re.I)
ROLE_GUESS_ONLY = re.compile(r"\b(?:could|may|might) be (?:a |an )?(?:supplier|buyer|trader|competitor|reseller)(?: or (?:a |an )?(?:supplier|buyer|trader|competitor|reseller))\b"
                             r"|\b(?:supplier|buyer) or (?:supplier|buyer)\b", re.I)
NEW_ONLY = re.compile(r"\b(?:little|low|no|poor|limited)\s+fit\b|\bnot (?:a )?(?:good )?fit\b"
                      r"|\bnew (?:cylindrical |prismatic |pouch )?(?:cells|batteries|modules|stock)\b[^.;\n]{0,60}\bonly\b"
                      r"|\bonly (?:new|unused|brand[- ]new)\b", re.I)


def not_a_want(text):
    """'role_guess' or 'new_only' when the text states no want worth a line, else None.

    The role guess has to lead the note (\"Likely trader/competitor: ...\") or be all it says; a real want followed by a
    side remark (\"... Could be a volume outlet for tested modules\") is still a want.
    """
    body = "\n".join(line for line in str(text or "").splitlines() if not re.match(r"\s*(?:note:\s*estimated from web research|demand audit|restored to history|quote:)", line, re.I))
    if ROLE_GUESS_LEAD.search(body):
        return "role_guess"
    if NEW_ONLY.search(body):
        return "new_only"
    return None


def select_for_model(cur, sources):
    """Marks each source's skip reason; the rest are the ones to send."""
    done = parsed_refs(cur, [s["ref"] for s in sources])
    for source in sources:
        if source["skip"]:
            continue
        if not source["text"]:
            source["skip"] = "no_text"
        elif not source["date"]:
            source["skip"] = "no_date"
        elif source["ref"] in done:
            source["skip"] = "already_parsed"
        elif not_a_want(source["text"]):
            source["skip"] = not_a_want(source["text"])
        elif not needs_parse(source["text"], source["spec"]):
            source["skip"] = "no_new_product_words"
    return [s for s in sources if not s["skip"]]


def run_model(sources, runner, per_call=TEXTS_PER_CALL, workers=3):
    """Fills source['result'] (validate_response's entry) for every source; failed batches leave source['failure']."""
    batches = [sources[i:i + per_call] for i in range(0, len(sources), per_call)]

    def one(batch):
        local = {f"n{i + 1}": s["text"] for i, s in enumerate(batch)}
        result, reason = runner.run(local)
        return batch, result, reason

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        for batch, result, reason in pool.map(one, batches):
            for i, source in enumerate(batch):
                answer = result.get(f"n{i + 1}")
                if answer is None:
                    source["failure"] = reason or "model_failed"
                else:
                    source["result"] = answer


def apply_flex(sources, runner, per_call=FLEX_PER_CALL):
    """Asks the second question for every priced product of a note that says flexible, up to, a ceiling, and keeps an answer
    only when it is a higher figure the note states. Returns {"asked": n, "kept": n}."""
    todo = [(source, product) for source in sources for product in source["result"]["products"]
            if product["price"] is not None and FLEX_WORDS.search(source["text"])]
    counts = {"asked": len(todo), "kept": 0}
    for start in range(0, len(todo), per_call):
        chunk = todo[start:start + per_call]
        answers = runner.flex({f"f{i + 1}": (source["text"], product["price"]) for i, (source, product) in enumerate(chunk)})
        for i, (source, product) in enumerate(chunk):
            value, quote = answers.get(f"f{i + 1}", (None, None))
            text = source["text"]
            if (value is not None and value > product["price"] and number_in(value, text_numbers(text))
                    and quote and 3 <= len(quote) <= 300 and squash(quote) in squash(text)):
                product["price_max"] = float(value)
                counts["kept"] += 1
    return counts


# ---------------------------------------------------------------------------
# Facts and keys
# ---------------------------------------------------------------------------
# Makers of cells, so a vehicle make written beside a cell format ("Nissan Leaf cells") is never read as a cell maker.
CELL_MAKERS = {fold(name) for name in (
    "Samsung SDI", "Samsung", "LG Chem", "LG Energy Solution", "LG", "Panasonic", "Sanyo", "Molicel", "Murata", "Sony", "EVE",
    "EVE Energy", "CATL", "CALB", "BYD", "A123", "SK On", "SK Innovation", "Toshiba", "Lishen", "Gotion", "REPT", "Tenpower",
    "Sunwoda", "Farasis", "AESC", "Envision AESC", "Kokam", "Saft", "BAK", "Maxell", "Varta", "Headway", "Winston", "Hithium",
    "Great Power", "Ganfeng", "SVOLT", "Cosmx", "Li-Fun", "Lithium Werks", "Primearth", "Prime Planet", "Lithium Energy Japan")}


def split_makes(make):
    pieces = [p.strip() for p in re.split(r"\s*(?:,|/|&|\band\b)\s*", str(make or ""), flags=re.I) if p.strip()]
    return list(dict.fromkeys(pieces)) or [None]


def fact_sets(product):
    """One fact dict per stated make (a product may name several), in the SQL builder's and the TS builder's names."""
    out = []
    makes = split_makes(product["make"]) if product["make"] else [implied_make(product["model"])]
    for make in makes[:FACT_COMBINATIONS]:
        kwh = product["kwh_min"] if product["kwh_min"] is not None and product["kwh_min"] == product["kwh_max"] else None
        model = product["model"] or product["platform"]
        sql = {"make": make, "model": model, "format": product["format"], "chemistry": product["chemistry"],
               "kwh": kwh, "kwh_min": product["kwh_min"], "kwh_max": product["kwh_max"],
               "part_numbers": [product["part_number"]] if product["part_number"] else None,
               "cell_maker": make if product["format"] == "cell" and model and fold(make) in CELL_MAKERS else None,
               "cell_format": product.get("cell_format") if product["format"] == "cell" else None}
        ts = {"make": make, "model": model, "format": product["format"], "chemistry": product["chemistry"], "kwh": kwh,
              "kwhMin": product["kwh_min"], "kwhMax": product["kwh_max"],
              "partNumbers": [product["part_number"]] if product["part_number"] else None,
              "cellMaker": sql["cell_maker"]}
        out.append({"sql": {k: v for k, v in sql.items() if v is not None}, "ts": {k: v for k, v in ts.items() if v is not None},
                    "platform_unused": product["platform"] if product["model"] and product["platform"] else None})
    return out


def ts_keys(facts_list, tsx=None):
    """The app's own builder (pack families included), one subprocess for the whole list. Returns every key per input."""
    tsx = tsx or str(WEB / "node_modules" / ".bin" / "tsx")
    done = subprocess.run([tsx, "lib/match/product-key-cli.ts"], cwd=WEB, input=json.dumps(facts_list), text=True,
                          capture_output=True, timeout=120)
    if done.returncode != 0:
        raise RuntimeError("product-key-cli failed: " + done.stderr.strip()[:300])
    return json.loads(done.stdout)


def ts_available():
    return (WEB / "node_modules" / ".bin" / "tsx").exists()


def sql_keyed(cur, facts):
    """Key and the columns behind it from the SQL helpers of migration 112 (the importers' own builder)."""
    cur.execute("""with facts as (select %s::jsonb as facts)
                   select buyer_interest_product_key(facts) as key, buyer_interest_key_level(buyer_interest_product_key(facts)) as level,
                          buyer_interest_states_product(facts) as stated, buyer_interest_raw_product(facts) as raw_product,
                          facts->>'make' as make, facts->>'model' as model, buyer_interest_format(facts->>'format') as format,
                          buyer_interest_chemistry(facts->>'chemistry') as chemistry,
                          buyer_interest_number(facts->'kwh_min') as kwh_min, buyer_interest_number(facts->'kwh_max') as kwh_max
                     from facts""", (json.dumps(facts),))
    return cur.fetchone()


def ts_key_table(products, tsx=None):
    """{json of ts facts: [keys, most specific first]} for every fact set of these products, from one subprocess call."""
    unique = list(dict.fromkeys(json.dumps(f["ts"], sort_keys=True) for p in products for f in fact_sets(p)))
    if not unique:
        return {}
    return dict(zip(unique, ts_keys([json.loads(u) for u in unique], tsx)))


def pick_key(keys, fact):
    """The most specific key the TEXT proves. The app's builder can match a pack family on a model alone, which
    quietly supplies a capacity the buyer never stated, and it reads one kWh figure as a pack's capacity whatever the
    format. So: a part number gives a part key; one stated kWh figure on a pack, a system or an unstated format gives
    a pack or model key; a cell maker plus model gives a cell key; everything else is the broad key (make-scoped when
    a make is stated)."""
    ts = fact["ts"]
    allowed = {"broad"}
    if ts.get("partNumbers"):
        allowed.add("part")
    if ts.get("kwh") is not None and ts.get("format") in (None, "pack", "system"):
        allowed |= {"pack", "model"}
    if ts.get("cellMaker") and ts.get("model"):
        allowed.add("cell")
    # A stated make and model with no kWh is the model-level key (model:kia-ev3, every pack size of the model). It
    # states no capacity, so it is proven by the text whatever the format.
    wide = bool(ts.get("make") and ts.get("model") and not ts.get("cellMaker"))
    return next((k for k in keys if k["level"] in allowed or (wide and k["level"] == "model" and not k["key"].endswith("kwh"))),
                keys[-1])


STATIONARY_MODEL = re.compile(r"\b(megapack|powerwall|powerpack|bess|container|cabinet|rack|ess)\b", re.I)


def drop_system_make(cur, fact):
    """R5: a vehicle make is never paired with a battery system (unless the model is itself stationary)."""
    sql = fact["sql"]
    if sql.get("format") != "system" or not sql.get("make") or STATIONARY_MODEL.search(sql.get("model") or ""):
        return fact
    cur.execute("select buyer_interest_is_vehicle_make(%s) as vehicle", (sql["make"],))
    if not cur.fetchone()["vehicle"]:
        return fact
    return {**fact, "sql": {k: v for k, v in sql.items() if k not in ("make", "cell_maker")},
            "ts": {k: v for k, v in fact["ts"].items() if k not in ("make", "cellMaker")}}


def stated_detail(product, sql):
    """R6: part number, cell maker and cell format the text states, kept on the line whatever level the key falls to."""
    stated = {"part_numbers": [product["part_number"]] if product["part_number"] else None,
              "cell_makers": [sql["cell_maker"]] if sql.get("cell_maker") else None,
              "cell_formats": [product["cell_format"]] if product.get("cell_format") else None}
    return {k: v for k, v in stated.items() if v} or None


def key_lines(cur, product, builder="sql", ts_table=None):
    """The lines one accepted product becomes: [{key, level, make, model, format, chemistry, kwh_min, kwh_max, raw_product}]."""
    lines = []
    sets = fact_sets(product)
    ts_first = [pick_key((ts_table or {})[json.dumps(f["ts"], sort_keys=True)], f) if builder == "ts" else None for f in sets]
    for fact, ts in zip(sets, ts_first):
        stated = stated_detail(product, fact["sql"])
        fact = drop_system_make(cur, fact)
        keyed = sql_keyed(cur, fact["sql"])
        if not keyed or not keyed["stated"]:
            continue
        if ts and fact["sql"].get("cell_format") and ts["level"] == keyed["level"] == "broad":
            ts = None  # the app's builder has no cell format yet; the SQL key is cell-format scoped
        key, level = (ts["key"], ts["level"]) if ts else (keyed["key"], keyed["level"])
        if key == "broad:any-batteries":
            continue  # nothing that names a product
        if (level == "broad" and keyed["model"] and not keyed["make"] and keyed["kwh_min"] is None and keyed["kwh_max"] is None
                and not fact["ts"].get("partNumbers") and not product["platform"]):
            continue  # a bare model no maker owns (\"Bolt\"): not a product, and never an any-pack line
        raw = keyed["raw_product"] or (f"platform {fact['platform_unused']}" if fact["platform_unused"] else None)
        if product.get("min_ah"):
            raw = f"{raw}; {min_ah_text(product['min_ah'])}" if raw else min_ah_text(product["min_ah"])
        lines.append({"key": key, "level": level, "make": keyed["make"], "model": keyed["model"], "format": keyed["format"],
                      "chemistry": keyed["chemistry"], "kwh_min": keyed["kwh_min"], "kwh_max": keyed["kwh_max"], "raw_product": raw,
                      "stated": stated, "fact": fact["sql"]})
    return lines


def _blank_product(**fields):
    product = {key: None for key in PRODUCT_KEYS}
    product.update({"status": "asked", "text_stated": True}, **fields)
    return product


def augment_products(text, products):
    """Products the text itself states and the model's answer left out, plus the Ah minimum and quantity it states.

    Research and buy-box text keeps what it says: a make or model it names (Tesla, Leaf, Volt; a bare Bolt names none),
    a cell format (18650, 21700), a minimum Ah (kept on raw_product), and one quantity when the source has one product.
    Nothing here overrides a value the model already gave.
    """
    import model_aliases as ma
    products = list(products)
    folds = set()
    for product in products:
        folds |= {ma.make_fold(m) for m in split_makes(product["make"]) if m}
        if product["model"] and not product["make"] and implied_make(product["model"]):
            folds.add(ma.make_fold(implied_make(product["model"])))
    named = {(ma.make_fold(row["make"]), row["slug"]): row for row in ma.text_stated_models(text)}
    have = {(ma.make_fold(p["make"] or implied_make(p["model"]) or ""), ma.model_slug(p["make"] or implied_make(p["model"]), p["model"]))
            for p in products if p["model"]}
    for (make_fold, slug), row in named.items():
        if (make_fold, slug) not in have:
            products.append(_blank_product(make=row["make"], model=row["model"], quote=row["model"]))
            have.add((make_fold, slug))
            folds.add(make_fold)
    for make in ma.text_makes(text):
        if ma.make_fold(make) not in folds:
            products.append(_blank_product(make=make, quote=make))
            folds.add(ma.make_fold(make))
    shown = " ".join(str(p["cell_format"] or "") for p in products)
    for cell_format in ma.text_cell_formats(text):
        if cell_format not in shown:
            products.append(_blank_product(format="cell", cell_format=cell_format, quote=cell_format))
    ah = ma.text_min_ah(text)
    qty = ma.text_quantity(text)
    for product in products:
        if ah is not None and not product.get("min_ah"):
            product["min_ah"] = ah
    if qty and len(products) == 1 and products[0]["quantity"] is None:
        products[0]["quantity"], products[0]["quantity_unit"] = qty
    return products


def min_ah_text(ah):
    return f"min {ah:g} Ah"


def one_per_key(cur, pairs):
    """R4 within one source: one line per key, and none a more specific line of the same source already says.
    `pairs` is [(product, line)]; the survivors keep their order."""
    index, unique = {}, []
    for product, line in pairs:
        if line["key"] not in index:
            index[line["key"]] = len(unique)
            unique.append((product, line))
            continue
        # A model-level key covers every format: two formats of one model are one line with the format left open.
        first_product, first = unique[index[line["key"]]]
        if first.get("format") != line.get("format"):
            fact = {k: v for k, v in (first.get("fact") or {}).items() if k != "format"}
            unique[index[line["key"]]] = (first_product, {**first, "format": None, "fact": fact})
    if len(unique) < 2:
        return unique
    from backfill_buyer_interest import _drop_redundant
    keep = {json.dumps(f, sort_keys=True) for f in _drop_redundant(cur, [line["fact"] for _p, line in unique])}
    return [(p, line) for p, line in unique if json.dumps(line["fact"], sort_keys=True) in keep]


# ---------------------------------------------------------------------------
# Writing lines
# ---------------------------------------------------------------------------
def line_id(company_id, kind, key):
    return "bi_parse_" + hashlib.sha1(f"{company_id}|{kind}|{key}".encode("utf-8")).hexdigest()[:24]


def adds_information(line, product):
    """A broad line only earns a row when it carries something the buy box's own broad line lacks."""
    return (line["level"] != "broad" or line["kwh_min"] is not None or line["kwh_max"] is not None
            or bool(line["model"]) or bool(line["raw_product"]) or product["quantity"] is not None or product["price"] is not None
            or bool(product.get("text_stated")) or bool(product.get("min_ah")))


def synced_keys(cur, source):
    """Keys the demand row already syncs (its own ask lines); empty for a wants source or a row with no synced lines."""
    ref = source.get("ref") or ""
    if not ref.startswith("crm:"):
        return set()
    cur.execute("select product_key from buyer_interest where demand_id = %s and ownership = 'synced'", (ref[4:],))
    return {row["product_key"] for row in cur.fetchall()}


def covered_by_ask(line, keys):
    """A demand row that syncs its own lines only gains a parsed line that says more: the same key or a make-less
    'any' key repeats the ask (SLS Energy's row gave 'any modules' next to its own ask lines)."""
    return bool(keys) and (line["key"] in keys or line["key"].startswith("broad:any-"))


def write_line(cur, source, kind, line, product, run_id):
    """Insert the line, or merge the dates and refs of one this parser already wrote. Returns 'added', 'merged' or 'present'.

    A line another writer made (an importer, the backfill, a person) is never touched.
    """
    refs = sorted({source["ref"], f"parse:{run_id}"})
    seen = source["date"][:10]
    cur.execute("""select id, source_refs, format from buyer_interest
                    where company_id = %s and product_key = %s and kind = %s and ownership = 'mastered' for update""",
                (source["company_id"], line["key"], kind))
    existing = cur.fetchone()
    quantity = product["quantity"]
    price = product["price"]
    if existing is None:
        cur.execute("""insert into buyer_interest (id, company_id, kind, ownership, product_key, product_key_level, make, model,
                         raw_product, format, chemistry, kwh_min, kwh_max, first_seen, last_seen, quantity, quantity_unit,
                         quantity_basis, price, price_currency, price_unit, price_basis, price_max, source_refs, expires_on, stated)
                       values (%s, %s, %s, 'mastered', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::date, %s::date, %s, %s, %s,
                         %s, %s, %s, %s, %s, %s::text[], %s::date + %s, %s::jsonb)""",
                    (line_id(source["company_id"], kind, line["key"]), source["company_id"], kind, line["key"], line["level"],
                     line["make"], line["model"], line["raw_product"], line["format"], line["chemistry"], line["kwh_min"],
                     line["kwh_max"], seen, seen, quantity, product["quantity_unit"] if quantity is not None else None,
                     "stated" if quantity is not None else "not_stated", price,
                     product["price_currency"] if price is not None else None,
                     product["price_unit"] if price is not None else None, "target" if price is not None else None,
                     product["price_max"] if price is not None else None, refs, seen, EXPIRY_DAYS[kind],
                     json.dumps(line["stated"]) if line.get("stated") else None))
        return "added"
    own = any(ref.startswith("parse:") for ref in existing["source_refs"] or [])
    if not own:
        return "present"
    if existing["format"] is not None and existing["format"] != line["format"]:
        # A model-level key covers every format, so a second format on the same line leaves the format open.
        cur.execute("update buyer_interest set format = null, updated_at = now() where id = %s", (existing["id"],))
    if set(refs) <= set(existing["source_refs"] or []):
        return "present"
    cur.execute("""update buyer_interest set first_seen = least(first_seen, %s::date), last_seen = greatest(last_seen, %s::date),
                     expires_on = greatest(expires_on, %s::date + %s),
                     quantity = coalesce(quantity, %s), quantity_unit = coalesce(quantity_unit, %s),
                     quantity_basis = case when quantity is null and %s::numeric is not null then 'stated' else quantity_basis end,
                     price = coalesce(price, %s), price_currency = coalesce(price_currency, %s),
                     price_unit = coalesce(price_unit, %s), price_basis = coalesce(price_basis, %s),
                     price_max = coalesce(price_max, case when %s::numeric > coalesce(price, %s::numeric) then %s::numeric end),
                     stated = coalesce(stated, %s::jsonb),
                     source_refs = (select array_agg(distinct r order by r) from unnest(source_refs || %s::text[]) r),
                     updated_at = now()
                   where id = %s""",
                (seen, seen, seen, EXPIRY_DAYS[kind], quantity, product["quantity_unit"] if quantity is not None else None,
                 quantity, price, product["price_currency"] if price is not None else None,
                 product["price_unit"] if price is not None else None, "target" if price is not None else None,
                 product["price_max"], price, product["price_max"],
                 json.dumps(line["stated"]) if line.get("stated") else None, refs, existing["id"]))
    return "merged"


# ---------------------------------------------------------------------------
# The run
# ---------------------------------------------------------------------------
def new_report(run_id, apply_writes):
    return {"run_id": run_id, "apply": bool(apply_writes), "sources": {"wants": 0, "demand": 0}, "skipped": {},
            "sent": 0, "model": {"calls": 0, "cache_hits": 0, "failed_batches": []}, "status": {}, "rejected": {},
            "rejected_examples": [], "lines": {"added": {}, "merged": 0, "present": 0, "added_total": 0}, "companies_gaining": [],
            "errors": [], "builder": None}


def bump(counter, key, n=1):
    counter[key] = counter.get(key, 0) + n


def write_sources(conn, parsed, report, run_id, builder, apply_writes, batch_size=DB_BATCH, tsx=None):
    """Turns every parsed source into lines, one transaction per batch of sources."""
    import psycopg2.extras
    from backfill_buyer_interest import _record_error, _set_timeouts
    gaining = {}
    shadow = set()  # a dry run rolls each batch back, so it remembers what an earlier batch would have added
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        for start in range(0, len(parsed), batch_size):
            chunk = parsed[start:start + batch_size]
            ts_table = ts_key_table([p for s in chunk for p in s["result"]["products"]], tsx) if builder == "ts" else None
            _set_timeouts(cur)
            cur.execute("savepoint parse_batch")
            for source in chunk:
                cur.execute("savepoint parse_source")
                try:
                    source["lines"] = []
                    asked = synced_keys(cur, source)
                    products = augment_products(source.get("text"), source["result"]["products"])
                    pairs = [(product, line) for product in products
                             for line in key_lines(cur, product, builder, ts_table)]
                    for product, line in one_per_key(cur, pairs):
                        kind = source["line_kind"]
                        if not adds_information(line, product):
                            source["lines"].append({**line, "kind": kind, "outcome": "broad_only", "product": product})
                            report["lines"]["broad_only_skipped"] = report["lines"].get("broad_only_skipped", 0) + 1
                            continue
                        if covered_by_ask(line, asked):
                            source["lines"].append({**line, "kind": kind, "outcome": "covered_by_ask", "product": product})
                            bump(report["lines"], "covered_by_ask")
                            continue
                        outcome = write_line(cur, source, kind, line, product, run_id)
                        marker = (source["company_id"], line["key"], kind)
                        if outcome == "added" and not apply_writes:
                            if marker in shadow:
                                outcome = "merged"
                            shadow.add(marker)
                        source["lines"].append({**line, "kind": kind, "outcome": outcome, "product": product})
                        if outcome == "added":
                            bump(report["lines"]["added"], f"{kind}:{line['level']}")
                            report["lines"]["added_total"] += 1
                            if line["level"] != "broad":
                                gaining.setdefault(source["company_id"], 0)
                                gaining[source["company_id"]] += 1
                        else:
                            report["lines"][outcome] += 1
                    cur.execute("release savepoint parse_source")
                except Exception as exc:  # noqa: BLE001
                    cur.execute("rollback to savepoint parse_source")
                    source["lines"] = []
                    source["failure"] = "write_error"
                    report["errors"].append({"source": source["id"], "error": str(exc)[:200]})
                    _record_error(cur, "crm_companies", source["company_id"], "parse_interest", exc)
            if apply_writes:
                cur.execute("release savepoint parse_batch")
                conn.commit()
            else:
                cur.execute("rollback to savepoint parse_batch")
                conn.rollback()
    report["companies_gaining"] = sorted(gaining)
    report["companies_gaining_specific"] = len(gaining)


def run(conn, runner, run_id=None, apply_writes=False, builder="sql", limit=None, workers=3, batch_size=DB_BATCH, tsx=None,
        per_call=TEXTS_PER_CALL, only_companies=None):
    """Read the sources, parse them, write the lines. Returns (report, sources)."""
    import psycopg2.extras
    run_id = run_id or dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    report = new_report(run_id, apply_writes)
    report["builder"] = builder
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("select to_regclass('public.buyer_interest') as name")
        if not cur.fetchone()["name"]:
            raise SystemExit("buyer_interest does not exist: apply migration 112 first")
        sources = read_sources(cur, limit, only_companies)
        for source in sources:
            report["sources"][source["kind"]] += 1
        todo = select_for_model(cur, sources)
        before = {}
        cur.execute("select company_id, array_agg(product_key order by product_key) as keys from buyer_interest group by 1")
        before = {row["company_id"]: row["keys"] for row in cur.fetchall()}
        conn.rollback()
    for source in sources:
        if source["skip"]:
            bump(report["skipped"], f"{source['kind']}:{source['skip']}")
    report["sent"] = len(todo)
    run_model(todo, runner, per_call=per_call, workers=workers)
    report["flex"] = apply_flex([s for s in todo if not s.get("failure")], runner)
    report["model"] = {"calls": runner.calls, "cache_hits": runner.cache_hits,
                       "failed_batches": [{"reason": reason, "texts": len(ids)} for reason, ids in runner.failures]}
    parsed = []
    for source in todo:
        if source.get("failure"):
            bump(report["status"], f"unparsed:{source['failure'].split(':')[0]}")
            continue
        result = source["result"]
        bump(report["status"], result["status"])
        for raw, reason in result["rejected"]:
            bump(report["rejected"], reason)
            if len(report["rejected_examples"]) < 40:
                report["rejected_examples"].append({"source": source["id"], "reason": reason, "text": source["text"][:160],
                                                    "product": raw})
        if result["products"]:
            parsed.append(source)
    write_sources(conn, parsed, report, run_id, builder, apply_writes, batch_size, tsx)
    if apply_writes:
        from backfill_buyer_interest import drop_covered_lines  # R4: a broad line a parsed specific one now covers
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            report["covered_removed"] = drop_covered_lines(cur)
        conn.commit()
    report["status"]["parsed_sources"] = len(parsed)
    report["before"] = {company: before.get(company, []) for company in report["companies_gaining"]}
    return report, sources


# ---------------------------------------------------------------------------
# Review sheet and preview
# ---------------------------------------------------------------------------
def fmt_num(value):
    return "" if value is None else f"{float(value):g}"


def describe_line(line):
    product = line["product"]
    bits = [f"`{line['key']}`", f"{line['kind']}, {line['level']}"]
    kwh = (f"{fmt_num(product['kwh_min'])}-{fmt_num(product['kwh_max'])} kWh" if product["kwh_min"] != product["kwh_max"]
           else f"{fmt_num(product['kwh_min'])} kWh") if product["kwh_min"] is not None or product["kwh_max"] is not None else ""
    if kwh:
        bits.append(kwh)
    if product["quantity"] is not None:
        bits.append(f"qty {fmt_num(product['quantity'])} {product['quantity_unit'] or ''}".strip())
    if product["price"] is not None:
        bits.append(f"target {fmt_num(product['price'])} {product['price_currency'] or ''}/{product['price_unit'] or '?'}"
                    + (f", flexible to {fmt_num(product['price_max'])}" if product.get("price_max") is not None else ""))
    if product["cadence"]:
        bits.append(f"cadence {product['cadence']}")
    bits.append(product["status"])
    note = {"broad_only": "not written: broad only", "present": "already a line", "merged": "merged into an earlier parsed line"}.get(line.get("outcome"))
    if note:
        bits.append(f"*{note}*")
    return "; ".join(bits)


def sample_sources(parsed, percent, seed=1):
    if not parsed or percent <= 0:
        return []
    count = max(1, math.ceil(len(parsed) * percent / 100))
    return sorted(random.Random(seed).sample(parsed, min(count, len(parsed))), key=lambda s: s["id"])


def sample_sheet(parsed, percent, run_id, seed=1):
    """Markdown for Alex: the original text and the lines proposed, for a random percent of the parsed sources."""
    chosen = sample_sources(parsed, percent, seed)
    out = [f"# Interest parse: review sample ({percent:g}% of parsed sources)", "",
           f"Run {run_id}. {len(chosen)} of {len(parsed)} parsed sources, drawn at random (seed {seed}). "
           f"{sum(1 for s in chosen if any(l['outcome'] != 'broad_only' for l in s.get('lines') or []))} of them write at least one line; "
           "the rest only restate a broad line the buy box already holds (shown, not written).",
           "For each: is every proposed line a want the original text states? Mark yes or no.", ""]
    for n, source in enumerate(chosen, 1):
        out += [f"## {n}. {source['company']} ({source['kind']}, {source['date']})", "",
                f"Source `{source['id']}`; lines will be kind **{source['line_kind']}**, first and last seen {source['date']}.", "",
                "Original text:", ""] + ["> " + line for line in source["text"].splitlines() or [""]] + ["", "Proposed lines:", ""]
        for line in source.get("lines") or []:
            out.append(f"- {describe_line(line)}  (from: \"{line['product']['quote']}\")")
        for raw, reason in source["result"]["rejected"]:
            out.append(f"- *dropped*: {reason} ({json.dumps(raw, ensure_ascii=False)[:140]})")
        out += ["", "Alex: yes / no  ", ""]
    return "\n".join(out) + "\n"


def md_table(headers, rows):
    out = ["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"]
    out += ["| " + " | ".join("" if v is None else str(v).replace("|", "/").replace("\n", " ") for v in row) + " |" for row in rows]
    return "\n".join(out)


def preview(conn, report, sources, source_note="", before_after=15, seed=7, notes=""):
    """parse-preview.md: what the run read, parsed, rejected and added, with before and after for some companies."""
    import psycopg2.extras
    status, lines = report["status"], report["lines"]
    out = ["# Interest parse: preview", "",
           f"Run `{report['run_id']}` on {source_note or 'the restored copy'}; key builder `{report['builder']}`; "
           f"{'applied' if report['apply'] else 'dry run'}.", "", "## Sources", "",
           md_table(["measure", "count"], [
               ("Sources read: buy-box wants", report["sources"]["wants"]),
               ("Sources read: closed demand rows", report["sources"]["demand"]),
               ("Skipped before the model", sum(report["skipped"].values())),
               ("Sent to the model", report["sent"]),
               ("Parsed (at least one product kept)", status.get("parsed_sources", 0)),
               ("Model answered with no product", status.get("no_products", 0)),
               ("Every product rejected", status.get("rejected", 0)),
               ("Missing in the model's answer", status.get("missing", 0)),
               ("Unparsed (model failure)", sum(v for k, v in status.items() if k.startswith("unparsed")))]), "",
           "Skipped, by reason:", "",
           md_table(["source:reason", "count"], sorted(report["skipped"].items())), "",
           f"Model calls made: {report['model']['calls']}; answers read from cache: {report['model']['cache_hits']}; "
           f"failed batches: {len(report['model']['failed_batches'])}.", "", "## Rejected products, by reason", "",
           md_table(["reason", "products"], sorted(report["rejected"].items(), key=lambda kv: -kv[1])) if report["rejected"] else "None.", ""]
    if report["rejected_examples"]:
        out += ["Examples (the text is cut at 160 characters):", "",
                md_table(["source", "reason", "text", "proposed"], [(e["source"], e["reason"], e["text"], json.dumps(e["product"], ensure_ascii=False)[:160])
                                                                 for e in report["rejected_examples"][:20]]), ""]
    kinds = sorted({k.split(":")[0] for k in lines["added"]} | {"interest", "inferred"})
    levels = ("part", "pack", "model", "cell", "broad")
    out += ["## Lines added", "",
            md_table(["kind"] + list(levels) + ["total"], [[k] + [lines["added"].get(f"{k}:{lv}", 0) for lv in levels]
                                                            + [sum(lines["added"].get(f"{k}:{lv}", 0) for lv in levels)] for k in kinds]), "",
            f"Total added: {lines['added_total']}. Merged into a line this parser wrote earlier: {lines['merged']}. "
            f"Already present (another writer's line, left alone): {lines['present']}. "
            f"Broad-only lines not written (nothing beyond the buy box's own broad line): {lines.get('broad_only_skipped', 0)}.", "",
            f"Companies gaining at least one specific (non-broad) line: {report.get('companies_gaining_specific', 0)}", ""]
    done = [s for s in sources if s.get("lines")]
    by_company = {}
    for source in done:
        for line in source["lines"]:
            if line["outcome"] == "added":
                by_company.setdefault(source["company_id"], []).append((source, line))
    specific = sorted(c for c in by_company if any(line["level"] != "broad" for _s, line in by_company[c]))
    others = sorted(set(by_company) - set(specific))
    rng = random.Random(seed)
    chosen = rng.sample(specific, min(before_after, len(specific)))
    chosen += rng.sample(others, min(before_after - len(chosen), len(others)))  # fill up with broad lines that carry a model or a range
    out += [f"## {len(chosen)} before and after", ""]
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        for company in chosen:
            cur.execute("""select name, buyer_profile->>'wants' as wants from crm_companies where id = %s""", (company,))
            row = cur.fetchone()
            cur.execute("""select kind, product_key, first_seen, last_seen, source_refs from buyer_interest where company_id = %s
                            order by kind, product_key""", (company,))
            after = cur.fetchall()
            old = set(report["before"].get(company, []))
            texts = list(dict.fromkeys((s["id"], s["date"], s["text"]) for s, _line in by_company[company]))
            out += [f"### {row['name']} (`{company}`)", ""]
            for source_id, when, text in texts:
                out += [f"Text read ({source_id}, {when}):", ""] + ["> " + t for t in text.splitlines()] + [""]
            out += [f"Before ({len(old)} lines): " + (", ".join(f"`{k}`" for k in sorted(old)) or "none"), "", "After:", ""]
            out.append(md_table(["kind", "key", "first seen", "last seen", "new?"],
                                [(a["kind"], a["product_key"], a["first_seen"], a["last_seen"],
                                  "new" if any(r.startswith("parse:") for r in a["source_refs"] or []) else "") for a in after]))
            out.append("")
    if notes:
        out += ["## Notes", "", notes, ""]
    return "\n".join(out) + "\n"


# ---------------------------------------------------------------------------
def main(argv=None):
    parser = argparse.ArgumentParser(description="Parse free-text buyer wants and old asks into specific, dated buyer_interest lines.")
    parser.add_argument("--dsn", help="connection string (required with --apply)")
    parser.add_argument("--apply", action="store_true", help="write; without it every batch is rolled back")
    parser.add_argument("--i-have-approval", action="store_true", help="allow a run (dry or apply) against the production database")
    parser.add_argument("--run-id", help="id for the parse:<run id> source ref (default: the UTC timestamp)")
    parser.add_argument("--cache-dir", default=str(DEFAULT_CACHE), help="where raw model answers are cached")
    parser.add_argument("--cache-only", action="store_true", help="make no model call; sources without a cached answer stay unparsed")
    parser.add_argument("--key-builder", choices=("auto", "ts", "sql"), default="auto",
                        help="ts = the app's builder with pack families (needs apps/web/node_modules); sql = migration 112's helpers")
    parser.add_argument("--texts-per-call", type=int, default=TEXTS_PER_CALL)
    parser.add_argument("--workers", type=int, default=3, help="parallel model calls")
    parser.add_argument("--batch-size", type=int, default=DB_BATCH, help="sources per database transaction")
    parser.add_argument("--limit", type=int, help="read at most this many sources of each kind (trial runs)")
    parser.add_argument("--sample", type=float, metavar="PERCENT", help="write a review sheet of this percent of parsed sources")
    parser.add_argument("--sample-out", default=str(DEFAULT_SAMPLE_OUT))
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--preview", help="write the preview markdown (counts, rejections, before and after) here")
    parser.add_argument("--preview-note", help="text added to the preview under Notes (what the earlier runs cost, for instance)")
    parser.add_argument("--report", help="write the run report as JSON here")
    parser.add_argument("--detail", help="write every source with its text, products and lines as JSON here")
    args = parser.parse_args(argv)

    from backfill_buyer_interest import DEFAULT_DSN, _dsn_params, is_production_dsn, refusal_for_database
    dsn = args.dsn or DEFAULT_DSN
    if args.apply and not args.dsn:
        parser.error("--apply needs an explicit --dsn")
    if is_production_dsn(dsn) and not args.i_have_approval:
        parser.error("refusing to run against the production database (even a dry run holds locks); "
                     "pass --i-have-approval to override")
    builder = args.key_builder
    if builder == "auto":
        builder = "ts" if ts_available() else "sql"
    elif builder == "ts" and not ts_available():
        parser.error("--key-builder ts needs apps/web/node_modules/.bin/tsx")

    import psycopg2
    import psycopg2.extras
    params = _dsn_params(dsn)
    conn = psycopg2.connect(dsn)
    conn.autocommit = False
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("select current_database() as db")
        where = cur.fetchone()
    conn.rollback()
    target = f"{params.get('host') or params.get('hostaddr') or 'local socket'}:{params.get('port') or '5432'}"
    print(f"database {where['db']} via {target}: {'apply' if args.apply else 'dry run'}")
    why = refusal_for_database(where["db"], args.i_have_approval)
    if why:
        conn.close()
        parser.error(why)
    runner = ModelRunner(args.cache_dir, cache_only=args.cache_only)
    if not args.cache_only and not runner.key:
        conn.close()
        parser.error("no gateway key (HERMES_API_KEY or API_SERVER_KEY in /root/.hermes/.env); use --cache-only")
    try:
        report, sources = run(conn, runner, run_id=args.run_id, apply_writes=args.apply, builder=builder, limit=args.limit,
                              workers=args.workers, batch_size=args.batch_size, per_call=args.texts_per_call)
        print(json.dumps({k: v for k, v in report.items() if k not in ("rejected_examples", "companies_gaining", "before")}, indent=1))
        parsed = [s for s in sources if s.get("lines") is not None and s.get("result", {}).get("products")]
        if args.sample:
            Path(args.sample_out).parent.mkdir(parents=True, exist_ok=True)
            Path(args.sample_out).write_text(sample_sheet(parsed, args.sample, report["run_id"], args.seed), encoding="utf-8")
            print(f"review sheet written to {args.sample_out}")
        if args.preview:
            Path(args.preview).write_text(preview(conn, report, sources, f"database {where['db']} on {target}", notes=args.preview_note or ""), encoding="utf-8")
            print(f"preview written to {args.preview}")
        if args.report:
            Path(args.report).write_text(json.dumps(report, indent=1, default=str), encoding="utf-8")
        if args.detail:
            Path(args.detail).write_text(json.dumps([
                {"id": s["id"], "company_id": s["company_id"], "date": s["date"], "kind": s["line_kind"], "skip": s["skip"],
                 "text": s["text"], "status": (s.get("result") or {}).get("status"),
                 "lines": [{k: v for k, v in line.items() if k != "product"} | {"quote": line["product"]["quote"]}
                           for line in s.get("lines") or []],
                 "rejected": [[raw, reason] for raw, reason in (s.get("result") or {}).get("rejected", [])]} for s in sources],
                indent=1, default=str), encoding="utf-8")
    finally:
        conn.rollback()
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
