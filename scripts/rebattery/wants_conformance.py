#!/usr/bin/env python3
"""Read-only conformance checker for the Wants (buyer_interest) lines.

Reports every violation of ten rules, from the lines against the sources that produced them:

  R1  invented combination: a make/chemistry/format pairing the source does not state together (demand rows, offers,
      dossier products, parsed text; not buy-box lists, whose cross product is independent criteria).
  R2  declined line whose only source is a closed request (no declined offer, no dossier declined product); a Said
      (interest) line of a request, valid only when the request is closed not_a_fit or offer_reply.
  R3  model key slug that is not the canonical slug of model_aliases.model_slug().
  R4  duplicate lines (company + kind + product_key), a less specific line next to a more specific one
      from the same source, and a live dossier line whose source_refs name the demand/offer of another live line
      of the same company, kind and key (the same evidence written twice). Separate requests or purchases with
      the same key stay clean.
  R5  vehicle make carrying the systems format.
  R6  lost detail: cell makers, cell formats, part numbers, kWh or voltage the source states and no line of
      that source carries. Cell maker, part number and kWh count only in product_key, raw_product, make, model or the
      kWh columns (matching reads those, not `stated`); cell format and voltage may sit in `stated`.
  R7  regression against a baseline table (default buyer_interest_pre_rebuild): per source and kind the best key level
      dropped (part > pack > model > cell > broad), a part number, cell maker, cell key or model key of the old keys is
      in none of the source's new keys, or a company lost all lines of a kind. A hit whose detail the source (demand
      row text, dossier products) no longer states, or a decline removed by R2, is listed as explained.
  R8  widening: a line broader than its source. Buy box (makes, cell_makers, chemistries, formats): the line carries no
      listed make, or a chemistry/format outside the list (model and part keys are exempt from chemistry/format).
      Demand row or dossier product: the line drops a stated make, model, chemistry or format. Only a line a research run
      or a text parser wrote must sit inside the buy box; a line from the buyer's own request, alert, offer, dossier, mail
      or chat may be broader than it.
  R9  open request (demand open/qualifying) with no line, or whose lines together miss a make, model, kWh, cell format,
      cell maker, quantity or price the row states in spec or summary. Lines are taken together, since a multi-make
      request cannot sit on one line. A make or model the sync deliberately removed (buyer_interest_suppressed) is not missed.
      A recycler's scrap feedstock request (text says scrap, feedstock or recycling, states no product fact) writes no Want
      by design and is exempt.

Key shapes of the current sync (migrations 119/120): a cell format and a cell maker may sit in a broad key
(broad:lg-cylindrical-nmc-cells, broad:21700-any-cells); that is not an invented combination. The cell format of the
cells inside a pack, module or system is a property, not a key dimension, so no pack/module/system line has to carry it.
A line from a dossier is judged against the dossier's products as well as the requests.
  R10 two saved-search lines of one company with the same product_key (report only).
  R11 narrower than source: a line whose key carries one cell format while its request states several. The request
      lists all three families (prismatic, cylindrical, pouch): no line may carry a format (broad:nmc-cells). It lists
      2+ short of all three: its lines together must carry every stated format (one line each); a line is flagged when
      they do not.
  R12 exact size written for a stated minimum: an ask/standing/interest line with no model (broad key) whose
      kwh_min = kwh_max while its source text says '+', minimum, at least or from next to that number. Bought and
      declined lines are exempt.
  R13 non-canonical model key: two live lines (bought and declined excluded, any companies) whose model keys differ only in
      the make segment (model:fpt-ebs37-36.9kwh, model:iveco-ebs37-36.9kwh) or only in kWh within 2 kWh for the same make
      and model (model:kia-niro-64kwh, model:kia-niro-64.8kwh). Each non-canonical key is reported once; the canonical key
      is the keyMakes make or kwhVariants figure of model_aliases.json, else the key most lines carry.

  R14 request model not stated: a spec.models entry of a request that is only a prefix of another listed model
      and never appears on its own in the request text (summary, spec.product_family, spec.model, note), e.g.
      'Ioniq' next to 'Ioniq 5' when the text only says 'Ioniq 5'.

  R15 narrowed despite any: an open request whose text (summary, spec.product_family) says "any" for the product family
      (any / beliebige + cells, packs, modules, a chemistry or a format) but whose lines all carry a make, cell maker or
      cell format. The maker or format the text names is an example; the broad line (broad:nmc-cells) must be there.
      Extra specific lines next to the broad one are fine.

The rule functions take plain dicts (see `check`), so they need no database. `main` reads one database in a
read-only session and writes nothing to it.

  wants_conformance.py --dsn "dbname=denchclaw" --out report.md --json summary.json
"""
import argparse
import collections
import datetime
import hashlib
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import buyer_dossier  # noqa: E402
import model_aliases  # noqa: E402

RULES = {
    "R1": "Invented combination",
    "R2": "Declined line backed only by a closed request",
    "R3": "Model key slug not canonical",
    "R4": "Duplicate or redundant less specific line",
    "R5": "Vehicle make with the systems format",
    "R6": "Detail the source states and no line carries",
    "R7": "Regression against the baseline lines",
    "R8": "Line broader than its source (widening)",
    "R9": "Open request not fully covered by its lines",
    "R10": "Same product key in two saved searches of one company (report only)",
    "R11": "Line carries one cell format while its source states several (narrower than source)",
    "R12": "Exact kWh written for a stated minimum",
    "R13": "Non-canonical model key (make spelling or near-identical kWh)",
    "R14": "Request model listed but not stated on its own (prefix of another listed model)",
    "R15": "Request text says any, but every line carries a make, cell maker or cell format (narrowed despite any)",
}
EXAMPLES_PER_RULE = 20
LEVEL_RANK = {"broad": 0, "model": 1, "cell": 1, "pack": 1, "part": 2}

# ---------------------------------------------------------------------------------------------- helpers

fold = model_aliases.fold


def as_list(value):
    if value is None or value == "":
        return []
    if isinstance(value, (list, tuple, set)):
        return [v for v in value if v not in (None, "")]
    return [value]


def num(value):
    try:
        return None if value is None or value == "" else float(value)
    except (TypeError, ValueError):
        return None


def norm_format(value):
    text = (str(value or "")).strip().lower()
    return text[:-1] if text.endswith("s") else text


def make_pieces(make):
    """A make text names one make or a group ("Toyota or Lexus", "Hyundai / Kia", "VW Group")."""
    pieces = []
    for part in re.split(r"\s+or\s+|[/,;&]|\band\b", str(make or ""), flags=re.IGNORECASE):
        part = re.sub(r"\bgroup\b", "", part, flags=re.IGNORECASE).strip()
        if part:
            pieces.append(part)
    return pieces


def make_folds(make):
    return {model_aliases.make_fold(p) for p in make_pieces(make)} | {fold(p) for p in make_pieces(make)}


def kwh_numbers(line):
    found = {n for n in (num(line.get("kwh_min")), num(line.get("kwh_max"))) if n is not None}
    for match in re.finditer(r"(\d+(?:\.\d+)?)kwh", str(line.get("product_key") or "")):
        found.add(float(match.group(1)))
    return found


def line_blob(line, with_stated=False):
    """What matching reads of a line: key, raw product, make, model. `stated` only for detail matching never uses."""
    text = " ".join(str(line.get(k) or "") for k in ("product_key", "raw_product", "make", "model"))
    stated = line.get("stated")
    if with_stated and stated:
        text += " " + (json.dumps(stated, ensure_ascii=False) if isinstance(stated, (dict, list)) else str(stated))
    return fold(text)


def _words(text):
    return " " + " ".join(re.sub(r"[^a-z0-9]+", " ", model_aliases.unaccent(text)).split()) + " "


def segments(*texts):
    """Pieces of free text that state one thing each: a clause, a sentence, an item of a plus list."""
    out = []
    for text in texts:
        for item in as_list(text):
            for piece in re.split(r";|\n|\.\s|\s\+\s|\bplus\b|,\s*and\b|,\s*(?=\d)", str(item), flags=re.IGNORECASE):
                if piece.strip():
                    out.append(piece)
    return out


def segment_has(segment, dim, value):
    words = _words(segment)
    if dim == "make":
        return any(f" {_words(p).strip()} " in words for p in make_pieces(value))
    if dim == "chemistry":
        return f" {_words(value).strip()} " in words
    if dim == "format":
        stem = norm_format(value)
        pattern = {"system": r"systems?|ess", "pack": r"packs?", "module": r"modules?", "cell": r"cells?"}.get(stem, re.escape(stem))
        return re.search(rf"\b(?:{pattern})\b", model_aliases.unaccent(segment)) is not None
    return False


def combination_traced(line, dims, segs):
    """True when one segment states every dimension value the line carries."""
    values = [(dim, line.get(dim)) for dim in dims if line.get(dim)]
    return any(all(segment_has(seg, dim, value) for dim, value in values) for seg in segs)


CELL_FORMAT_TOKENS = ("18650", "21700", "26650", "32700", "4680", "cylindrical", "prismatic", "pouch")
STORAGE_SYSTEM_MODELS = ("megapack", "powerwall", "powerpack")  # Tesla products that are systems by nature


def key_has_cell_format(line):
    """A broad cell key that carries a cell format: broad:lg-cylindrical-nmc-cells, broad:21700-any-cells."""
    key = str(line.get("product_key") or "")
    return key.startswith("broad:") and key.endswith("-cells") and any(f"-{t}-" in f"-{key[6:]}" for t in CELL_FORMAT_TOKENS)


def is_cell_line(line):
    return norm_format(line.get("format")) == "cell"


def _source_label(line):
    for key in ("demand_id", "offer_id", "saved_search_id"):
        if line.get(key):
            return f"{key.split('_')[0]} {line[key]}"
    refs = line.get("source_refs") or []
    return str(refs[0]) if refs else "no source ref"


def _violation(ctx, rule, line, why, source=None, key=None):
    company = (ctx["companies"].get(line.get("company_id")) or {}).get("name") or line.get("company_id")
    return {"rule": rule, "company_id": line.get("company_id"), "company": company, "line_id": line.get("id"),
            "key": key or line.get("product_key"), "source": source or _source_label(line), "why": why}


def _is_profile_line(line):
    return not (line.get("demand_id") or line.get("offer_id") or line.get("saved_search_id")
                or str(line.get("id") or "").startswith("bi_dossier_"))


def _is_dossier_line(line):
    return str(line.get("id") or "").startswith("bi_dossier_")


# ---------------------------------------------------------------------------------------------- R1

def _multi_dims(lists):
    """The dimensions a source gives several values for, from {dim: [values]}."""
    return [dim for dim, values in lists.items() if len(values) > 1]


def _untraced_why(dims, line):
    stated = ", ".join(f"{dim} {line.get(dim)}" for dim in dims if line.get(dim))
    return f"{stated} is not stated together in the source; it is one of a cross product of lists"


def r1(ctx):
    found = []
    for line in ctx["lines"]:
        if line.get("demand_id") and line["demand_id"] in ctx["demands"]:
            demand = ctx["demands"][line["demand_id"]]
            spec = demand.get("spec") or {}
            lists = {"make": as_list(spec.get("makes")), "chemistry": as_list(spec.get("chemistries")),
                     "format": as_list(spec.get("formats"))}
            segs = segments(demand.get("summary"), spec.get("product_family"), demand.get("note"), demand.get("source_quote"))
            source = f"demand {demand['id']}"
        elif _is_profile_line(line):
            continue  # buy-box lists are independent criteria: their cross product is not an invented combination
        elif _is_dossier_line(line):
            problem = _dossier_mismatch(line, (ctx["companies"].get(line.get("company_id")) or {}).get("dossier_products"))
            if problem:
                found.append(_violation(ctx, "R1", line, problem, f"dossier of {line.get('company_id')}"))
            continue
        else:
            continue
        if key_has_cell_format(line):
            continue  # a cell format (and its maker) in the key is its own criterion, not a made-up pairing
        multi = _multi_dims(lists)
        carried = [d for d in multi if line.get(d)]
        if len(multi) < 2 or len(carried) < 2:
            continue
        if not combination_traced(line, multi, segs):
            found.append(_violation(ctx, "R1", line, _untraced_why(multi, line), source))
    return found


def _dossier_mismatch(line, products):
    """Why no dossier product states this line's make, chemistry and format together (None when one does)."""
    if not products:
        return None
    line_makes = make_folds(line.get("make")) if line.get("make") else set()
    for product in products:
        if line_makes and not (line_makes & make_folds(product.get("make"))):
            continue
        if line.get("chemistry") and str(line["chemistry"]).upper() not in {str(c).upper() for c in as_list(product.get("chemistry"))}:
            continue
        if line.get("format") and norm_format(line["format"]) not in {norm_format(f) for f in as_list(product.get("format"))}:
            continue
        return None
    stated = ", ".join(f"{k} {line.get(k)}" for k in ("make", "chemistry", "format") if line.get(k))
    return f"no dossier product states {stated} together"


# ---------------------------------------------------------------------------------------------- R2

def _crm_refs(line):
    return [r[4:] for r in (line.get("source_refs") or []) if str(r).startswith("crm:")]


def _declined_product_matches(line, products):
    line_makes = make_folds(line.get("make")) if line.get("make") else set()
    for product in products or []:
        if str(product.get("status") or "").lower() != "declined":
            continue
        if line_makes and not (line_makes & make_folds(product.get("make"))):
            continue
        if not line_makes and product.get("make"):
            continue
        if line.get("format") and product.get("format") and norm_format(line["format"]) not in {norm_format(f) for f in as_list(product["format"])}:
            continue
        return True
    return False


SAID_REASONS = ("not_a_fit", "offer_reply")  # a request closed this way is the buyer's reply: it writes a Said (interest) line


def r2(ctx):
    found = []
    declined_offer_ids = {o["id"] for o in ctx["offers"].values() if o.get("stage") in ("declined", "lost")}
    declined_listings = {(o.get("company_id"), o.get("bulk_listing_id")) for o in ctx["offers"].values()
                         if o.get("stage") in ("declined", "lost")}
    for line in ctx["lines"]:
        if line.get("kind") == "interest" and line.get("demand_id") in ctx["demands"]:
            demand = ctx["demands"][line["demand_id"]]
            if demand.get("status") != "closed" or demand.get("closed_reason") not in SAID_REASONS:
                found.append(_violation(ctx, "R2", line, f"Said line of request {demand['id']} ({demand.get('status')}, {demand.get('closed_reason') or 'no reason'}); "
                                        "only a request closed not_a_fit or offer_reply writes one", f"demand {demand['id']}"))
            continue
        if line.get("kind") != "declined":
            continue
        if line.get("offer_id"):
            continue
        company = ctx["companies"].get(line.get("company_id")) or {}
        if _declined_product_matches(line, company.get("dossier_products")):
            continue
        refs = _crm_refs(line)
        if any(r in declined_offer_ids or (line.get("company_id"), r) in declined_listings for r in refs):
            continue
        demand_ids = [d for d in dict.fromkeys([line.get("demand_id")] + refs) if d in ctx["demands"]]
        if demand_ids and all(ctx["demands"][d].get("status") == "closed" for d in demand_ids):
            states = ", ".join(f"{d} closed ({ctx['demands'][d].get('closed_reason') or 'no reason'})" for d in demand_ids)
            found.append(_violation(ctx, "R2", line, f"only source is a closed request: {states}; no declined offer or dossier declined product",
                                    f"demand {demand_ids[0]}"))
    return found


# ---------------------------------------------------------------------------------------------- R3

_KWH_SUFFIX = re.compile(r"-\d+(?:\.\d+)?kwh$")


def key_model_text(line):
    """What follows model: in a model key, without its kWh suffix (<make>-<slug>), or None for any other key."""
    key = str(line.get("product_key") or "")
    return _KWH_SUFFIX.sub("", key[len("model:"):]) if key.startswith("model:") else None


def r3(ctx):
    found = []
    for line in ctx["lines"]:
        rest = key_model_text(line)
        if rest is None or not line.get("model"):
            continue
        expected = model_aliases.model_slug(line.get("make"), line.get("model"))
        # The make part of a key is its own slug (lg-chem, mercedes-benz), so compare the tail only.
        if expected and rest != expected and not rest.endswith("-" + expected):
            found.append(_violation(ctx, "R3", line, f"key {line['product_key']} does not end in the canonical slug '{expected}' for {line.get('make')} / {line.get('model')}"))
    return found


# ---------------------------------------------------------------------------------------------- R4

def _source_key(line):
    for key in ("demand_id", "offer_id", "saved_search_id"):
        if line.get(key):
            return (line.get("company_id"), key, line[key])
    if _is_dossier_line(line):
        return (line.get("company_id"), "dossier", "")
    return (line.get("company_id"), "profile", "")


def _less_specific(a, b):
    """a states less than b and is covered by it: same kind and source, b ranks higher and agrees on make, chemistry, format."""
    if LEVEL_RANK.get(a.get("product_key_level"), 0) >= LEVEL_RANK.get(b.get("product_key_level"), 0):
        return False
    if a.get("make") and not (make_folds(a["make"]) & make_folds(b.get("make"))):
        return False
    if a.get("chemistry") and str(a["chemistry"]).upper() != str(b.get("chemistry") or "").upper():
        return False
    if a.get("format") and norm_format(a["format"]) != norm_format(b.get("format")):
        return False
    # b must also say the capacity a states: a kWh floor or range is detail a line without it does not carry.
    for field in ("kwh_min", "kwh_max"):
        if num(a.get(field)) is not None and num(a.get(field)) != num(b.get(field)):
            return False
    return True


def _dossier_states_line(line, products):
    """True when a dossier product states this line itself: same make, chemistry, format, model and part (a product that
    names no model or part states a broad line)."""
    key_fold = fold(line.get("product_key") or "")
    for p in products or []:
        if (str(p.get("status") or "") == "declined") != (line.get("kind") == "declined"):
            continue  # a declined product states a declined line only
        if bool(p.get("make")) != bool(line.get("make")) or (p.get("make") and not (make_folds(p["make"]) & make_folds(line["make"]))):
            continue
        if str(p.get("chemistry") or "").upper() != str(line.get("chemistry") or "").upper() and not (as_list(p.get("chemistry")) and str(line.get("chemistry") or "").upper() in {str(c).upper() for c in as_list(p.get("chemistry"))}):
            continue
        pf = {norm_format(f) for f in as_list(p.get("format"))}
        if norm_format(line.get("format")) not in (pf or {""}):
            continue
        parts = [fold(x) for x in as_list(p.get("part_number"))]
        if parts:
            if not any(x and x in key_fold for x in parts):
                continue
        elif p.get("model"):
            model = fold(model_aliases.model_slug(p.get("make"), p["model"]) or p["model"])
            if model not in key_fold and fold(p["model"]) not in key_fold:
                continue
        elif line.get("product_key_level") != "broad":
            continue
        return True
    return False


def r4(ctx):
    found = []
    groups = collections.defaultdict(list)
    for line in ctx["lines"]:
        groups[(_source_key(line), line.get("kind"), line.get("product_key"))].append(line)
    for (_source, kind, key), items in groups.items():
        if len(items) > 1:
            ids = ", ".join(i["id"] for i in items)
            for item in items[1:]:
                found.append(_violation(ctx, "R4", item, f"duplicate of {items[0]['id']} (same source, kind {kind}, key {key}); lines: {ids}"))
    # The same evidence written twice: a dossier line that cites the request or offer another live line is built from.
    by_key = collections.defaultdict(list)
    for line in ctx["lines"]:
        if _unexpired(line):
            by_key[(line.get("company_id"), line.get("kind"), line.get("product_key"))].append(line)
    for items in by_key.values():
        for dossier in items:
            if not _is_dossier_line(dossier):
                continue
            refs = {str(r) for r in dossier.get("source_refs") or []}
            for other in items:
                if other is not dossier and not _is_dossier_line(other) and any(
                        other.get(k) and f"crm:{other[k]}" in refs for k in ("demand_id", "offer_id")):
                    found.append(_violation(ctx, "R4", dossier, f"duplicate of {other['id']} (same evidence: its source_refs name "
                                            f"{other.get('demand_id') or other.get('offer_id')}, kind {dossier.get('kind')}, key {dossier.get('product_key')})"))
                    break
    by_source = collections.defaultdict(list)
    for line in ctx["lines"]:
        by_source[(_source_key(line), line.get("kind"))].append(line)
    for items in by_source.values():
        for a in items:
            for b in items:
                if a is not b and _less_specific(a, b):
                    if _is_dossier_line(a) and _dossier_states_line(a, (ctx["companies"].get(a.get("company_id")) or {}).get("dossier_products")):
                        break  # the dossier lists this broader product itself
                    found.append(_violation(ctx, "R4", a, f"redundant: {b['product_key']} ({b['id']}) from the same source is more specific"))
                    break
    return found


# ---------------------------------------------------------------------------------------------- R5

def vehicle_make_folds():
    names = list(model_aliases.BRAND_WORDS) + [m["make"] for m in model_aliases._DATA["models"]]
    for entry in buyer_dossier.MAKES:
        names.extend(make_pieces(entry))
    cell_makers = {fold(n) for n in buyer_dossier.CELL_MAKERS + buyer_dossier.EXTRA_CELL_MAKERS}
    folds = {fold(n) for n in names} | {model_aliases.make_fold(n) for n in names}
    # A name that is also a cell maker (BYD, LG, Samsung) is not taken as a vehicle make: its systems are real.
    return {f for f in folds if f and f not in cell_makers}


VEHICLE_MAKES = vehicle_make_folds()


def r5(ctx):
    found = []
    for line in ctx["lines"]:
        if norm_format(line.get("format")) == "system" and line.get("make") and make_folds(line["make"]) & VEHICLE_MAKES \
                and not any(m in fold(line.get("product_key")) or m in fold(line.get("model")) for m in STORAGE_SYSTEM_MODELS):
            found.append(_violation(ctx, "R5", line, f"vehicle make {line['make']} with format {line['format']}"))
    return found


# ---------------------------------------------------------------------------------------------- R6

def _carried(blob, numbers, kind, value):
    if kind == "kwh":
        return any(abs(n - value) < 1e-9 for n in numbers)
    return fold(str(value)) in blob


STATED_OK = ("cell format", "voltage")  # descriptive detail: carried by `stated`, which matching does not read


def _lost(blob, numbers, items, stated_blob=None):
    out = []
    for label, kind, value in items:
        if value in (None, ""):
            continue
        use = stated_blob if (stated_blob is not None and label in STATED_OK) else blob
        if not _carried(use, numbers, kind, value):
            out.append(f"{label} {value}")
    return out


def _voltages(*texts):
    return [f"{m}V" for text in texts for m in re.findall(r"(?<![\w.])(\d{2,4})\s?V\b", str(text or ""))]


def _states_cells(spec):
    """A request carries its cell format only when it asks for cells (or names no format); packs hold cells, they do not key on them."""
    formats = {norm_format(f) for f in as_list(spec.get("formats"))}
    return not formats or "cell" in formats


def _unexpired(line):
    expires = line.get("expires_on")
    if not expires:
        return True
    try:
        return datetime.date.fromisoformat(str(expires)[:10]) >= datetime.date.today()
    except ValueError:
        return True


def _line_range_carries(line, product, value):
    """An unexpired line of the same make (or none) with the same or a broader key carries a dossier kWh when its kWh range
    contains it, or states no kWh bound at all (Colvert VW Group 55/63/82 under broad:vw-group-any-packs kwh_min 30)."""
    if not _unexpired(line):
        return False
    if line.get("make") and product.get("make") and not (make_folds(line["make"]) & make_folds(product["make"])):
        return False
    if _is_specific_key(line) and not product.get("model"):
        return False  # a model line is narrower than a make or platform product
    lo, hi = num(line.get("kwh_min")), num(line.get("kwh_max"))
    return (lo is None or lo <= value) and (hi is None or value <= hi)


def r6(ctx):
    found = []
    by_demand = collections.defaultdict(list)
    by_company_dossier = collections.defaultdict(list)
    by_company = collections.defaultdict(list)
    for line in ctx["lines"]:
        by_company[line["company_id"]].append(line)
        if line.get("demand_id"):
            by_demand[line["demand_id"]].append(line)
        if _is_dossier_line(line):
            by_company_dossier[line["company_id"]].append(line)
    for demand_id, lines in by_demand.items():
        demand = ctx["demands"].get(demand_id)
        if not demand:
            continue
        spec = demand.get("spec") or {}
        items = [("cell maker", "text", v) for v in as_list(spec.get("cell_makers"))]
        if _states_cells(spec):
            items += [("cell format", "text", v) for v in as_list(spec.get("cell_formats"))]
        items += [("part number", "text", v) for v in as_list(spec.get("part_numbers"))]
        items += [("kWh", "kwh", n) for n in (num(spec.get("kwh_min")), num(spec.get("kwh_max")))]
        items += [("voltage", "text", v) for v in dict.fromkeys(_voltages(demand.get("summary"), spec.get("min_pack_voltage") and f"{spec['min_pack_voltage']}V"))]
        blob = "".join(line_blob(line) for line in lines)
        stated_blob = "".join(line_blob(line, True) for line in lines)
        numbers = set().union(*(kwh_numbers(line) for line in lines))
        lost = _lost(blob, numbers, items, stated_blob)
        if lost:
            found.append(_violation(ctx, "R6", lines[0], f"source states {'; '.join(lost)} but none of its {len(lines)} line(s) carries it", f"demand {demand_id}", key=f"{len(lines)} line(s): {lines[0]['product_key']}"))
    for company_id, lines in by_company_dossier.items():
        company = ctx["companies"].get(company_id) or {}
        # A product the dossier shares with a demand row or offer is written once, by that source: any line of the company carries it.
        everything = by_company[company_id]
        blob = "".join(line_blob(line) for line in everything)
        stated_blob = "".join(line_blob(line, True) for line in everything)
        numbers = set().union(*(kwh_numbers(line) for line in everything))
        for product in company.get("dossier_products") or []:
            items = [("part number", "text", v) for v in as_list(product.get("part_number"))]
            if "cell" in {norm_format(f) for f in as_list(product.get("format"))} and not (product.get("part_number") or product.get("model")):
                items += [("cell format", "text", v) for v in as_list(product.get("cell_format"))]  # a cell model or part names its cell
            kwhs = [num(v) for v in as_list(product.get("kwh")) + as_list(product.get("kwh_min")) + as_list(product.get("kwh_max"))]
            items += [("kWh", "kwh", v) for v in kwhs]
            # A make or platform product has no model key to hold a kWh; a line of its make that spans the kWh in
            # kwh_min..kwh_max carries it. A kWh outside every such range is still lost.
            product_numbers = set(numbers)
            for v in kwhs:
                for other in everything:
                    if v is not None and _line_range_carries(other, product, v):
                        product_numbers.add(v)
            maker = product.get("make")
            if maker and fold(maker) in {fold(n) for n in buyer_dossier.CELL_MAKERS + buyer_dossier.EXTRA_CELL_MAKERS}:
                items.append(("cell maker", "text", maker))
            lost = _lost(blob, product_numbers, [i for i in items if i[2] is not None], stated_blob)
            if lost:
                label = " ".join(str(product.get(k)) for k in ("make", "model") if product.get(k)) or "product"
                found.append(_violation(ctx, "R6", lines[0], f"dossier product {label} states {'; '.join(lost)} but no dossier line carries it", f"dossier of {company_id}", key=f"dossier product {label}"))
    return found



# ---------------------------------------------------------------------------------------------- R7

LEVEL7 = {"broad": 0, "cell": 1, "model": 2, "pack": 3, "part": 4}
_CELL_MAKER_FOLDS = None


def _cell_maker_folds():
    global _CELL_MAKER_FOLDS
    if _CELL_MAKER_FOLDS is None:
        _CELL_MAKER_FOLDS = {fold(n) for n in buyer_dossier.CELL_MAKERS + buyer_dossier.EXTRA_CELL_MAKERS}
    return _CELL_MAKER_FOLDS


def _key_tokens(line):
    """The details a key states, as (label, value to find in new keys, value to find in the source's text)."""
    key = str(line.get("product_key") or "")
    out = []
    if key.startswith("part:"):
        out.append(("part number", key[5:], key[5:]))
    elif key.startswith("model:") and line.get("model"):
        slug = model_aliases.model_slug(line.get("make"), line.get("model")) or key_model_text(line)
        out.append(("model", slug, line["model"]))
    elif key.startswith("model:"):
        out.append(("model", key_model_text(line), key_model_text(line)))
    elif key.startswith("cell:"):
        out.append(("cell key", key, line.get("model") or key[5:]))
    # Only a broad key can hold a cell maker (a part number or a model key names the product itself).
    if key.startswith("broad:") and line.get("make") and fold(line["make"]) in _cell_maker_folds() and fold(line["make"]) in fold(key):
        out.append(("cell maker", line["make"], line["make"]))
    return out


def _token_in(text, value):
    return bool(value) and fold(value) in text


def _source_text(ctx, source):
    """Free text the source states things in, or None when it has none (offers, profile, saved searches)."""
    company, kind, ident = source
    if kind == "demand_id":
        demand = ctx["demands"].get(ident)
        if not demand:
            return ""
        return fold(" ".join(str(demand.get(k) or "") for k in ("summary", "note", "source_quote")) + " " + json.dumps(demand.get("spec") or {}, ensure_ascii=False, default=str))
    if kind == "dossier":
        products = (ctx["companies"].get(company) or {}).get("dossier_products") or []
        return fold(json.dumps(products, ensure_ascii=False, default=str))
    return None


def _load_exceptions():
    path = Path(__file__).with_name("wants_conformance_exceptions.json")
    if not path.exists():
        return {}
    return {(e["company_id"], e["product_key"]): e["reason"] for e in json.loads(path.read_text(encoding="utf-8"))}


EXCEPTIONS = _load_exceptions()


def r7(ctx):
    base = ctx.get("baseline_lines")
    ctx["r7_explained"] = []
    if not base:
        return []
    new_by_source, old_by_source = collections.defaultdict(list), collections.defaultdict(list)
    for line in ctx["lines"]:
        new_by_source[_source_key(line)].append(line)
    for line in base:
        old_by_source[_source_key(line)].append(line)
    found = []

    def add(line, why, source, token_text, explained_text):
        v = _violation(ctx, "R7", line, why, source=source)
        v["explained"] = explained_text
        (ctx["r7_explained"] if explained_text else found).append(v)

    for source, olds in old_by_source.items():
        news = new_by_source.get(source)
        if not news:
            continue  # the source wrote nothing now: a removed source, not a regression of what it still writes
        new_keys = " ".join(fold(n.get("product_key") or "") for n in news)
        text = _source_text(ctx, source)
        label = f"{source[1].replace('_id', '')} {source[2]}".strip()
        for kind in sorted({o["kind"] for o in olds}):
            o_kind = [o for o in olds if o["kind"] == kind]
            n_kind = [n for n in news if n["kind"] == kind]
            if not n_kind:
                continue  # a kind change belongs to the company-level check below
            best_old = max(o_kind, key=lambda o: LEVEL7.get(o.get("product_key_level"), 0))
            best_new = max(LEVEL7.get(n.get("product_key_level"), 0) for n in n_kind)
            if LEVEL7.get(best_old.get("product_key_level"), 0) > best_new:
                toks = _key_tokens(best_old)
                why_gone = all(text is not None and not _token_in(text, t) for _, _, t in toks) and bool(toks)
                add(best_old, f"best level {best_old.get('product_key_level')} ({best_old['product_key']}) fell to {[n['product_key_level'] for n in n_kind]}",
                    label, None, "source no longer states " + ", ".join(t for _, _, t in toks) if why_gone else None)
        for old in olds:
            for k, v, t in _key_tokens(old):
                if _token_in(new_keys, v):
                    continue
                gone = text is not None and not _token_in(text, t)
                covered = k == "cell maker" and any(
                    LEVEL7.get(n.get("product_key_level"), 0) > LEVEL7.get(old.get("product_key_level"), 0)
                    and n["kind"] == old["kind"] and make_folds(old.get("make")) & make_folds(n.get("make")) for n in news)
                add(old, f"{k} {v} of the old key {old['product_key']} is in none of the source's new keys", label, None,
                    f"source no longer states {t}" if gone else "R4: a more specific line of the same source and make carries it" if covered else None)
    # a company that lost every line of a kind
    old_kinds = collections.defaultdict(list)
    for line in base:
        old_kinds[(line["company_id"], line["kind"])].append(line)
    new_kinds = {(l["company_id"], l["kind"]) for l in ctx["lines"]}
    for (company, kind), olds in old_kinds.items():
        if (company, kind) in new_kinds or company not in ctx["companies"]:
            continue
        only_closed = kind == "declined" and all(
            o.get("demand_id") and (ctx["demands"].get(o["demand_id"]) or {}).get("status") == "closed" for o in olds)
        explained = "R2: a closed request is not a decline" if only_closed else None
        add(olds[0], f"company lost all {len(olds)} {kind} line(s)", f"{kind} lines", None, explained)
    # a demand row, offer or saved search that wrote lines before and writes none now
    for source, olds in old_by_source.items():
        if new_by_source.get(source) or source[1] not in ("demand_id", "offer_id", "saved_search_id"):
            continue
        demand = ctx["demands"].get(source[2]) if source[1] == "demand_id" else None
        if source[1] == "demand_id" and (not demand or demand.get("status") not in ("open", "qualifying", "closed")
                                         or (demand.get("status") == "closed" and demand.get("closed_reason") not in ("expired", "bought_from_us"))):
            continue  # the row is gone or no longer a buying fact
        add(olds[0], f"{source[1].replace('_id', '')} {source[2]} wrote {len(olds)} line(s) before and writes none now",
            f"{source[1].replace('_id', '')} {source[2]}", None, None)
    # explained exceptions kept in the repo: a deliberate change under R1-R5, one entry per old line
    for v in list(found):
        reason = EXCEPTIONS.get((v["company_id"], v["key"]))
        if reason:
            found.remove(v)
            v["explained"] = reason
            ctx["r7_explained"].append(v)
    return found

# ---------------------------------------------------------------------------------------------- R8

def _is_specific_key(line):
    return str(line.get("product_key") or "").startswith(("model:", "part:"))


GROUP_BRANDS = {"vwgroup": {"audi", "skoda", "seat", "cupra", "porsche", "volkswagen", "bentley", "lamborghini"},
                "volkswagen": {"audi", "skoda", "seat", "cupra", "porsche", "bentley", "lamborghini"},
                "hyundai": {"genesis"}, "kia": set(),
                "stellantis": {"citroen", "peugeot", "opel", "vauxhall", "fiat", "ds", "jeep", "alfaromeo", "chrysler",
                               "dodge", "abarth", "lancia", "maserati"},
                "renault": {"dacia", "alpine"}}


def _line_make_ok(line, allowed_folds):
    if not line.get("make"):
        return False
    folds = make_folds(line["make"])
    # A buy box that lists a group covers the brands of that group.
    allowed_folds = set(allowed_folds) | {member for g, members in GROUP_BRANDS.items() if g in allowed_folds for member in members}
    # "LG Chem" is the LG of a buy box, "Samsung" the Samsung SDI: one fold may be the other's front part.
    return any(a == b or (min(len(a), len(b)) >= 2 and (a.startswith(b) or b.startswith(a))) for a in folds for b in allowed_folds)


def _is_box_checked(line):
    """Only a line a research run or a text parser wrote must sit inside the buy box. A line the buyer stated in their own
    request, alert, offer, dossier, mail or chat may be broader than the box: the box is the narrower reading."""
    refs = [str(ref) for ref in as_list(line.get("source_refs"))]
    return (str(line.get("id") or "").startswith("bi_parse_") or line.get("kind") == "inferred"
            or any(ref.startswith(("parse:", "crm:research")) for ref in refs))


def _model_hits(text_values, make_hint_folds=()):
    """(owner make fold, slug) of every model the texts name. An alias counts when one model owns it or its make is hinted."""
    words = " ".join(_words(t) for t in text_values)
    hits = set()
    for own, alias, slug, is_global in model_aliases.ALIAS_ROWS:
        # A bare word alias (zoe, focus, across) needs its make named too; one with a digit (model 3, ev6) names a model alone.
        if (own in make_hint_folds or (is_global and re.search(r"\d", alias))) and f" {_words(alias).strip()} " in words:
            hits.add((own, slug))
    return hits


def _line_model_slugs(line):
    out = set()
    if line.get("model"):
        slug = model_aliases.model_slug(line.get("make"), line.get("model"))
        if slug:
            out.add(slug)
    tail = key_model_text(line)
    if tail:
        out.add(tail)
    return out


def _line_has_model(line, slug):
    tail = key_model_text(line)
    return slug in _line_model_slugs(line) or bool(tail and re.search(rf"(?:^|-){re.escape(slug)}(?:-|$)", tail))


def _dropped(line, makes=(), chemistries=(), formats=(), models=(), exempt_chem_format=False, exempt_chemistry=False):
    """What the line leaves out of a product that states makes, chemistries, formats or models (a list = alternatives)."""
    out = []
    make_set = {f for m in makes for f in make_folds(m)}
    if make_set and not _line_make_ok(line, make_set):
        out.append(f"make ({'/'.join(map(str, makes))})" + (f", line says {line['make']}" if line.get("make") else ""))
    if chemistries and not exempt_chem_format and not exempt_chemistry and str(line.get("chemistry") or "").upper() not in {str(c).upper() for c in chemistries}:
        out.append(f"chemistry ({'/'.join(map(str, chemistries))})" + (f", line says {line['chemistry']}" if line.get("chemistry") else ""))
    if formats and not exempt_chem_format and norm_format(line.get("format")) not in {norm_format(f) for f in formats}:
        out.append(f"format ({'/'.join(map(str, formats))})" + (f", line says {line['format']}" if line.get("format") else ""))
    line_make = make_folds(line.get("make")) if line.get("make") else set()
    # A model the source states is dropped when the line is of that model's make (or states no make) and carries no stated model.
    stated = [(own, slug) for own, slug in models if not line_make or own in line_make]
    if str(line.get("product_key") or "").startswith("part:"):
        stated = []  # a part number names one product of the model itself
    if stated and not any(_line_has_model(line, slug) for _, slug in stated):
        out.append("model (" + "/".join(sorted({slug for _, slug in stated})) + ")")
    return out


def _demand_models(demand):
    spec = demand.get("spec") or {}
    makes = {model_aliases.make_fold(m) for v in as_list(spec.get("makes")) for m in make_pieces(v)}
    texts = [t for t in [demand.get("summary"), spec.get("product_family")] + [str(m) for m in as_list(spec.get("models"))] if t]
    makes |= {model_aliases.make_fold(w) for t in texts for w in _words(t).split()}  # makes the text itself names
    return _model_hits(texts, makes)


KWH_MODEL_KEY = re.compile(r"^(model:.+)-\d+(?:\.\d+)?kwh$")


def _plain_model_with_kwh_siblings(line, siblings):
    """A plain model line (model:make-model) written beside kWh model lines of the same request is by design."""
    key = str(line.get("product_key") or "")
    return key.startswith("model:") and not KWH_MODEL_KEY.match(key) and any(
        (m := KWH_MODEL_KEY.match(str(other.get("product_key") or ""))) and m.group(1) == key for other in siblings)


def r8(ctx):
    found = []
    by_demand = collections.defaultdict(list)
    for line in ctx["lines"]:
        if line.get("demand_id"):
            by_demand[line["demand_id"]].append(line)
    for line in ctx["lines"]:
        company = ctx["companies"].get(line.get("company_id")) or {}
        if line.get("demand_id") and line["demand_id"] in ctx["demands"]:
            demand = ctx["demands"][line["demand_id"]]
            spec = demand.get("spec") or {}
            makes, chemistries, models = as_list(spec.get("makes")), as_list(spec.get("chemistries")), _demand_models(demand)
            # Migration 121: a request of 2+ makes or models and 2+ chemistries keeps chemistry as a preference, not a line key.
            multi = (len(makes) >= 2 or len(models) >= 2) and len(chemistries) >= 2
            drops = _dropped(line, makes, chemistries, as_list(spec.get("formats")), models, exempt_chemistry=multi,
                             exempt_chem_format=_plain_model_with_kwh_siblings(line, by_demand[line["demand_id"]]))
            if drops:
                found.append(_violation(ctx, "R8", line, f"line is broader than the request: dropped {'; '.join(drops)}", f"demand {demand['id']}"))
        elif _is_profile_line(line) and _is_box_checked(line):
            box = company.get("buyer_profile") or {}
            makes = [m for key in ("makes", "cell_makers") for m in as_list(box.get(key))]
            drops = _dropped(line, makes, as_list(box.get("chemistries")), as_list(box.get("formats")), exempt_chem_format=_is_specific_key(line))
            if _is_specific_key(line):  # a model or part key narrows the buy box; only a make outside it is wrong
                drops = [d for d in drops if d.startswith("make")]
            if drops:
                found.append(_violation(ctx, "R8", line, f"line is broader than the buy box: dropped {'; '.join(drops)}", f"buyer_profile of {line.get('company_id')}"))
        elif _is_dossier_line(line):
            products = [p for p in (company.get("dossier_products") or [])]
            candidates = []
            for product in products:
                make, chem, fmt = product.get("make"), as_list(product.get("chemistry")), as_list(product.get("format"))
                if line.get("make") and make and not (make_folds(line["make"]) & make_folds(make)):
                    continue
                if line.get("chemistry") and chem and str(line["chemistry"]).upper() not in {str(c).upper() for c in chem}:
                    continue
                if line.get("format") and fmt and norm_format(line["format"]) not in {norm_format(f) for f in fmt}:
                    continue
                slug = model_aliases.model_slug(make, product.get("model")) if product.get("model") else None
                if slug and line.get("model") and slug not in _line_model_slugs(line):
                    continue
                shared = ((line.get("make") and make) or (line.get("chemistry") and chem) or (line.get("format") and fmt) or (slug and line.get("model")))
                if not shared:
                    continue
                models = {(model_aliases.make_fold(make) if make else "", slug)} if slug else set()
                candidates.append(_dropped(line, [make] if make else [], chem, fmt, models))
            if candidates and all(candidates):
                best = min(candidates, key=len)
                found.append(_violation(ctx, "R8", line, f"line is broader than its dossier product: dropped {'; '.join(best)}", f"dossier of {line.get('company_id')}"))
    return found


# ---------------------------------------------------------------------------------------------- R9

KWH_FIGURE = re.compile(r"(?<![\w.])(\d{1,3}(?:\.\d+)?)\s?kwh\b", re.IGNORECASE)
CELL_FORMAT_NUMBERS = ("18650", "21700", "4680", "26650", "46800")
CELL_FORMAT_WORDS = ("prismatic", "pouch", "cylindrical")
NEGATED_CELL_FORMAT = re.compile(
    r"\b(?:no|not|non|without|excluding|excludes?|except|never|rejects?)\s+(?:(?!pouch|prismatic|cylindrical)[a-z0-9/-]+\s+){0,2}"
    r"(?:pouch|prismatic|cylindrical)\b")
OPEN_STATUSES = ("open", "qualifying")


def _kwh_stated(demand):
    spec = demand.get("spec") or {}
    figures = {n for n in (num(spec.get("kwh_min")), num(spec.get("kwh_max")), num(spec.get("pack_kwh"))) if n}
    texts = [demand.get("summary"), spec.get("product_family")] + [str(m) for m in as_list(spec.get("models"))]
    for text in texts:
        figures |= {float(m) for m in KWH_FIGURE.findall(str(text or "")) if 1 <= float(m) <= 200}  # pack scale; MWh-size figures are volumes
    return sorted(figures)


FAMILY_RANGE = re.compile(r"(?<![\w.])(\d{1,3}(?:\.\d+)?)\s?-\s?(\d{1,3}(?:\.\d+)?)\s?kwh\b", re.IGNORECASE)


def _family_range(demand, lines):
    """(lo, hi) of a kWh range a mixed-model request states only in product_family, when no line states a bound that
    conflicts with it; else None."""
    spec = demand.get("spec") or {}
    if any(num(spec.get(k)) for k in ("kwh", "kwh_min", "kwh_max", "pack_kwh")) or len(as_list(spec.get("models"))) < 2:
        return None
    match = FAMILY_RANGE.search(str(spec.get("product_family") or ""))
    if not match:
        return None
    lo, hi = float(match.group(1)), float(match.group(2))
    bounds = [b for line in lines for b in (num(line.get("kwh_min")), num(line.get("kwh_max"))) if b is not None]
    return (lo, hi) if all(lo <= b <= hi for b in bounds) else None


def _line_has_kwh(line, value):
    lo, hi = num(line.get("kwh_min")), num(line.get("kwh_max"))
    near = lambda a, b: a is not None and abs(a - b) < 1e-9
    return near(lo, value) or near(hi, value) or (lo is not None and hi is not None and lo <= value <= hi) or value in kwh_numbers(line)


def _cell_formats_stated(demand):
    spec = demand.get("spec") or {}
    text = " ".join(str(t or "") for t in [demand.get("summary"), spec.get("product_family")] + as_list(spec.get("cell_formats")))
    # "No pouch cells" or an excluded format is a stated no, not a wanted format (Phoenix BS, 23 Nov 2026).
    low = NEGATED_CELL_FORMAT.sub(" ", text.lower())
    excluded = " ".join(str(t) for t in as_list(spec.get("excludes"))).lower()
    return [f for f in CELL_FORMAT_NUMBERS + CELL_FORMAT_WORDS
            if re.search(rf"\b{f}\b", low) and not re.search(rf"\b{f}\b", excluded)]


def _cell_makers_stated(demand):
    spec = demand.get("spec") or {}
    stated = {str(m) for m in as_list(spec.get("cell_makers"))}
    words = _words(" ".join(str(t or "") for t in [demand.get("summary"), spec.get("product_family")]))
    for name in buyer_dossier.CELL_MAKERS + buyer_dossier.EXTRA_CELL_MAKERS:
        if f" {_words(name).strip()} " in words:
            stated.add(name)
    return sorted(stated)


_SCRAP_WORDS = re.compile(r"\b(?:scrap|feedstock|recycl\w*)\b", re.IGNORECASE)
_CHEMISTRY_WORDS = re.compile(r"\b(?:lfp|nmc|nca|ncm|lto|lmo|nimh|lifepo4?)\b", re.IGNORECASE)
_PRODUCT_SPEC_KEYS = ("makes", "make", "models", "model", "chemistries", "chemistry", "formats", "format", "part_numbers",
                      "kwh", "kwh_min", "kwh_max", "pack_kwh", "capacity_kwh", "cell_formats", "cell_makers")


def _is_scrap_feedstock(demand):
    """A recycler's scrap feedstock request: the text says scrap, feedstock or recycling and states no product fact."""
    spec = demand.get("spec") or {}
    text = " ".join(str(t or "") for t in (demand.get("summary"), spec.get("product_family"), spec.get("intent_note")))
    if not _SCRAP_WORDS.search(text) or any(as_list(spec.get(key)) for key in _PRODUCT_SPEC_KEYS):
        return False
    return not (model_aliases.text_makes(text) or model_aliases.text_models(text) or _CHEMISTRY_WORDS.search(text)
                or KWH_FIGURE.search(text) or _cell_formats_stated(demand))


def r9(ctx):
    found = []
    by_demand = collections.defaultdict(list)
    for line in ctx["lines"]:
        if line.get("demand_id"):
            by_demand[line["demand_id"]].append(line)
    for demand_id, demand in sorted(ctx["demands"].items()):
        if demand.get("status") not in OPEN_STATUSES:
            continue
        lines = by_demand.get(demand_id) or []
        label = f"demand {demand_id}"
        spec = demand.get("spec") or {}
        stub = {"company_id": demand.get("company_id"), "id": None, "product_key": (lines[0]["product_key"] if lines else None)}
        removed = " ".join(fold(k) for k in ctx.get("suppressed_by_demand", {}).get(demand_id, []))
        if not lines and removed:
            continue  # every line of the request was removed on purpose (buyer_interest_suppressed)
        if not lines and _is_scrap_feedstock(demand):
            continue  # a recycler's scrap feedstock request names no product, so it writes no Want by design
        if not lines:
            found.append(_violation(ctx, "R9", stub, f"open request has no line: {str(demand.get('summary'))[:120]}", label, key="no line"))
            continue
        missing = []
        for make in as_list(spec.get("makes")):
            if not any(make_folds(line.get("make")) & make_folds(make) for line in lines if line.get("make")) \
                    and not any(f and f in removed for f in make_folds(make)):
                missing.append(f"make {make}")
        named = sorted(_demand_models(demand))
        for own, slug in named:
            # 'Ioniq 5' is one model: a bare family that only occurs as the start of a longer named model is not demand.
            if any(other != slug and other.startswith(slug) for _, other in named):
                continue
            if not any(_line_has_model(line, slug) for line in lines) and fold(slug) not in removed:
                missing.append(f"model {slug}")
        family = _family_range(demand, lines)
        unbound = []
        for value in _kwh_stated(demand):
            if not any(_line_has_kwh(line, value) for line in lines):
                if family and family[0] <= value <= family[1]:
                    unbound.append(f"kWh {value:g}")  # the range is a family description, not a per-line bound
                else:
                    missing.append(f"kWh {value:g}")
        if unbound:
            ctx.setdefault("r9_report_only", []).append(_violation(
                ctx, "R9", lines[0], f"request kWh range {family[0]:g}-{family[1]:g} stated only in product_family; not on lines: {'; '.join(unbound)}", label,
                key=f"{len(lines)} line(s): {lines[0]['product_key']}"))
        blob = " ".join(line_blob(line, True) for line in lines)
        for value in (_cell_formats_stated(demand) if _states_cells(spec) else []):
            cylindrical = value == "cylindrical" and any(n in blob for n in CELL_FORMAT_NUMBERS)
            if value not in blob and not cylindrical:
                missing.append(f"cell format {value}")
        key_blob = " ".join(line_blob(line) for line in lines)
        for name in _cell_makers_stated(demand):
            if fold(name) not in key_blob:
                missing.append(f"cell maker {name}")
        volume = num(spec.get("volume"))
        if volume is not None and not any(num(line.get("quantity")) == volume for line in lines):
            missing.append(f"quantity {volume:g} {spec.get('volume_unit') or ''}".strip())
        for field in ("max_price", "target_price_per_pack"):
            value = num(spec.get(field))
            if field == "target_price_per_pack" and any(
                    num(line.get(key)) is not None for line in lines for key in ("price_max", "price")):
                continue  # a line carrying the price (the ceiling) or price_max holds the request's price; a target price below it is not a defect
            if value is not None and not any(value in (num(line.get("price")), num(line.get("price_max"))) for line in lines):
                missing.append(f"price {field} {value:g}")
        if missing:
            found.append(_violation(ctx, "R9", lines[0], f"open request not fully covered by its {len(lines)} line(s), missing: {'; '.join(missing)}", label,
                                    key=f"{len(lines)} line(s): {lines[0]['product_key']}"))
    return found


# ---------------------------------------------------------------------------------------------- R10

def r10(ctx):
    """Report only: two saved-search lines of one company with the same product_key."""
    groups = collections.defaultdict(list)
    for line in ctx["lines"]:
        if line.get("saved_search_id"):
            groups[(line.get("company_id"), line.get("product_key"))].append(line)
    found = []
    for (_company, key), items in groups.items():
        if len(items) > 1:
            ids = ", ".join(f"{i['id']} (search {i['saved_search_id']})" for i in items)
            for item in items[1:]:
                found.append(_violation(ctx, "R10", item, f"same product_key as {items[0]['id']} from another saved search; lines: {ids}"))
    return found

# ---------------------------------------------------------------------------------------------- R11

def _key_cell_format(line):
    """The cell format token a broad cell key carries, or None."""
    key = str(line.get("product_key") or "")
    if not key_has_cell_format(line):
        return None
    return next((t for t in CELL_FORMAT_TOKENS if f"-{t}-" in f"-{key[6:]}"), None)


def _format_family(token):
    return token if token in ("prismatic", "pouch") else "cylindrical"  # every size token is a cylindrical cell


def r11(ctx):
    found = []
    by_demand = collections.defaultdict(list)
    for line in ctx["lines"]:
        if line.get("demand_id"):
            by_demand[line["demand_id"]].append(line)
    for demand_id, demand in sorted(ctx["demands"].items()):
        spec = demand.get("spec") or {}
        if demand.get("status") not in OPEN_STATUSES or not _states_cells(spec):
            continue
        stated = _cell_formats_stated(demand)
        if len(set(stated)) < 2:
            continue
        families = {_format_family(t) for t in stated}
        everything = families >= {"prismatic", "cylindrical", "pouch"}
        lines = by_demand.get(demand_id) or []
        carried = {_key_cell_format(line) for line in lines} - {None}
        for line in lines:
            token = _key_cell_format(line)
            if token is None:
                continue
            if everything:
                why = f"line carries cell format {token}; the request lists prismatic, cylindrical and pouch, so the key has no format"
            elif gone := sorted(t for t in set(stated) if t not in carried
                                and not (t == "cylindrical" and carried & set(CELL_FORMAT_NUMBERS))):
                why = f"line carries cell format {token}; the request states {', '.join(sorted(set(stated)))} and no line carries {', '.join(gone)}"
            else:
                continue
            found.append(_violation(ctx, "R11", line, why, f"demand {demand_id}"))
    return found


# ---------------------------------------------------------------------------------------------- R12

MINIMUM_WORDS = r"(?:minimum|min\.?|at least|from|over|more than|>=|\u2265)"
EXACT_KINDS = ("ask", "standing", "interest")


def _minimum_stated(text, number):
    n = re.escape(f"{number:g}")
    plain = rf"(?<![\d.]){n}(?:\.0+)?(?![\d])"
    return re.search(rf"{plain}\s*\+|{plain}\s*(?:kwh)?\s*(?:minimum|min\b|or more|and above|or above)|{MINIMUM_WORDS}\s*(?:of\s*)?{plain}",
                     text, re.IGNORECASE) is not None


def _flat_strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from _flat_strings(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from _flat_strings(item)


def _line_source_text(ctx, line):
    if line.get("demand_id") and line["demand_id"] in ctx["demands"]:
        demand = ctx["demands"][line["demand_id"]]
        return " \n ".join(_flat_strings([demand.get("summary"), demand.get("spec"), demand.get("note"), demand.get("source_quote")]))
    products = (ctx["companies"].get(line.get("company_id")) or {}).get("dossier_products") or []
    return " \n ".join(_flat_strings([line.get("raw_product"), line.get("stated"), products]))


def r12(ctx):
    found = []
    for line in ctx["lines"]:
        lo, hi = num(line.get("kwh_min")), num(line.get("kwh_max"))
        if line.get("kind") not in EXACT_KINDS or lo is None or lo != hi:
            continue
        if not str(line.get("product_key") or "").startswith("broad:"):
            continue  # a model line states the model's own size
        if _minimum_stated(_line_source_text(ctx, line), lo):
            found.append(_violation(ctx, "R12", line, f"kWh {lo:g} is written as an exact size; the source states it as a minimum ({lo:g}+, minimum, at least or from)"))
    return found


# ---------------------------------------------------------------------------------------------- R13

KWH_NEAR = 2.0
_KEY_PARTS = re.compile(r"^model:(?P<rest>.+?)(?:-(?P<kwh>\d+(?:\.\d+)?)kwh)?$")


def _model_key_parts(line):
    """(make segment, model slug, kwh or None) of a live model key whose model text gives the slug, else None."""
    if line.get("kind") in ("bought", "declined"):
        return None
    m = _KEY_PARTS.match(str(line.get("product_key") or ""))
    slug = model_aliases.model_slug(line.get("make"), line.get("model")) if m and line.get("model") else None
    if not m or not slug:
        return None
    rest = m.group("rest")
    if rest == slug:
        make = ""
    elif rest.endswith("-" + slug):
        make = rest[:-len(slug) - 1]
    else:
        return None
    return make, slug, float(m.group("kwh")) if m.group("kwh") else None


def _key_of(make, slug, kwh):
    return "model:" + "-".join(p for p in (make, slug) if p) + (f"-{model_aliases.kwh_text(kwh)}kwh" if kwh is not None else "")


def r13(ctx):
    counts = collections.Counter()
    first = {}
    parts = {}
    for line in ctx["lines"]:
        p = _model_key_parts(line)
        if p:
            key = line["product_key"]
            counts[key] += 1
            first.setdefault(key, line)
            parts[key] = p
    flagged = {}  # key -> why
    by_model = collections.defaultdict(set)
    for key, (make, slug, kwh) in parts.items():
        by_model[(slug, kwh)].add(make)
    for (slug, kwh), makes in by_model.items():
        if len(makes) < 2:
            continue
        mapped = {model_aliases.canonical_make_slug(m) for m in makes} - {None}
        if len(mapped) == 1 and next(iter(mapped)) in makes:
            winner = next(iter(mapped))
        else:
            winner = max(sorted(makes), key=lambda m: (counts[_key_of(m, slug, kwh)], -len(m)))
        for m in makes - {winner}:
            flagged[_key_of(m, slug, kwh)] = f"make spelling '{m}' for the same model; canonical key {_key_of(winner, slug, kwh)}"
    by_make = collections.defaultdict(set)
    for key, (make, slug, kwh) in parts.items():
        if kwh is not None:
            by_make[(make, slug)].add(kwh)
    for (make, slug), values in by_make.items():
        ordered = sorted(values)
        cluster = [ordered[0]]
        for v in ordered[1:] + [None]:
            if v is not None and v - cluster[-1] <= KWH_NEAR:
                cluster.append(v)
                continue
            if len(cluster) > 1:
                snapped = {model_aliases.snap_kwh(make, slug, c) for c in cluster} & set(cluster)
                winner = (min(snapped) if snapped else
                          max(cluster, key=lambda c: (counts[_key_of(make, slug, c)], -c)))
                for c in cluster:
                    key = _key_of(make, slug, c)
                    if c in snapped:  # a listed pack variant (Niro 64 and 64.8 are different packs)
                        continue
                    if c != winner and key not in flagged:
                        flagged[key] = f"kWh {c:g} is within {KWH_NEAR:g} kWh of {winner:g}; canonical key {_key_of(make, slug, winner)}"
            cluster = [v] if v is not None else []
    return [_violation(ctx, "R13", first[key], f"non-canonical model key {key}: {why}") for key, why in sorted(flagged.items())]


# ---------------------------------------------------------------------------------------------- R14

def _tokens(text):
    return re.sub(r"[^a-z0-9.]+", " ", str(text or "").lower()).split()


def _find(tokens, needle):
    return [i for i in range(len(tokens) - len(needle) + 1) if tokens[i:i + len(needle)] == needle]


def r14(ctx):
    found = []
    for demand in ctx["demands"].values():
        spec = demand.get("spec") if isinstance(demand.get("spec"), dict) else {}
        models = [m for m in as_list(spec.get("models")) if isinstance(m, str) and _tokens(m)]
        if len(models) < 2:
            continue
        text = _tokens(" \n ".join(_flat_strings([demand.get("summary"), spec.get("product_family"), spec.get("model"), demand.get("note")])))
        for model in models:
            mine = _tokens(model)
            longer = [_tokens(o) for o in models if len(_tokens(o)) > len(mine) and _tokens(o)[:len(mine)] == mine]
            if not longer:
                continue
            masked = list(text)
            for other in longer:
                for i in _find(text, other):
                    masked[i:i + len(other)] = [None] * len(other)
            if not any(masked[i:i + len(mine)] == mine for i in range(len(masked) - len(mine) + 1)):
                found.append(_violation(ctx, "R14", {"company_id": demand.get("company_id"), "id": None}, f"spec.models lists '{model}' but the request text only says "
                                        f"{', '.join(repr(o) for o in models if _tokens(o)[:len(mine)] == mine and o != model)}", source=f"demand {demand['id']}", key=model))
    return found


# ---------------------------------------------------------------------------------------------- R15

# Mirrors buyer_interest_text_says_any() of migration 131.
SAYS_ANY = re.compile(r"\b(?:any|beliebige[rnms]?|jede[rnms]?)\s+(?:(?:nmc|nca|lfp|lto|lmo|li-ion|lithium|pouch|prismatic|cylindrical|[0-9][0-9./-]*\s*(?:ah|kwh)?)\s+){0,3}"
                      r"(?:cells?|packs?|modules?|zellen|nmc|nca|lfp|lto|lmo|pouch|prismatic|cylindrical)\b", re.IGNORECASE)


def _line_narrow(line):
    return bool(line.get("make")) or key_has_cell_format(line)


def r15(ctx):
    found = []
    by_demand = collections.defaultdict(list)
    for line in ctx["lines"]:
        if line.get("demand_id"):
            by_demand[line["demand_id"]].append(line)
    for demand_id, demand in sorted(ctx["demands"].items()):
        spec = demand.get("spec") if isinstance(demand.get("spec"), dict) else {}
        if demand.get("status") not in OPEN_STATUSES:
            continue
        text = " ".join(_flat_strings([demand.get("summary"), spec.get("product_family")]))
        match = SAYS_ANY.search(text)
        lines = [l for l in by_demand.get(demand_id, []) if l.get("kind") == "ask"]
        if not match or not lines or not all(_line_narrow(l) for l in lines):
            continue
        found.append(_violation(ctx, "R15", lines[0], f"the request text says '{match.group(0)}' but every line carries a make, cell maker or cell format "
                                f"({', '.join(sorted(l['product_key'] for l in lines))}); the broad line is missing", f"demand {demand_id}"))
    return found


# ---------------------------------------------------------------------------------------------- run and report

RULE_FUNCTIONS = {"R1": r1, "R2": r2, "R3": r3, "R4": r4, "R5": r5, "R6": r6, "R7": r7, "R8": r8, "R9": r9, "R10": r10, "R11": r11, "R12": r12, "R13": r13, "R14": r14, "R15": r15}


def check(ctx):
    """ctx = {"lines": [dict], "demands": {id: dict}, "offers": {id: dict}, "companies": {id: dict}}; returns violations by rule."""
    return {rule: fn(ctx) for rule, fn in RULE_FUNCTIONS.items()}


def source_kind(source):
    first = str(source).split()[0]
    return first if first in ("demand", "buyer_profile", "dossier", "offer", "saved") else "other"


def summarise(ctx, results, limit=EXAMPLES_PER_RULE):
    return {"lines": len(ctx["lines"]),
            "counts": {rule: len(items) for rule, items in results.items()},
            "companies": {rule: len({v["company_id"] for v in items}) for rule, items in results.items()},
            "by_source": {rule: dict(collections.Counter(source_kind(v["source"]) for v in items)) for rule, items in results.items()},
            "examples": {rule: top_examples(items, limit) for rule, items in results.items()},
            "r9_report_only": len(ctx.get("r9_report_only") or []),
            "r7_explained": len(ctx.get("r7_explained") or []),
            "r7_explained_examples": top_examples(ctx.get("r7_explained") or [], limit)}


def finding_records(results):
    """Every finding (not just examples) as a flat record with a stable key: rule, line id or source, short hash of the detail."""
    records = []
    for rule, items in results.items():
        for v in items:
            anchor = v.get("line_id") or v.get("source") or ""
            digest = hashlib.sha1(str(v.get("why") or "").encode("utf-8")).hexdigest()[:8]
            records.append({"key": f"{rule}|{anchor}|{digest}", "rule": rule, "company": v.get("company"),
                            "line_id": v.get("line_id"), "source_id": v.get("source"), "message": v.get("why")})
    return records


def top_examples(items, limit=EXAMPLES_PER_RULE):
    """The companies with the most violations first, so the worst offenders show. limit 0 lists every hit."""
    per_company = collections.Counter(v["company_id"] for v in items)
    return sorted(items, key=lambda v: (-per_company[v["company_id"]], str(v["company_id"]), str(v["line_id"])))[:limit or None]


def render_markdown(ctx, results, dsn_label="", limit=EXAMPLES_PER_RULE):
    summary = summarise(ctx, results, limit)
    out = ["# Wants conformance report", "", f"Database: {dsn_label or 'n/a'}. Lines checked: {summary['lines']}.", "",
           "| Rule | Violations | Companies | Meaning |", "| --- | ---: | ---: | --- |"]
    for rule, title in RULES.items():
        out.append(f"| {rule} | {summary['counts'][rule]} | {summary['companies'][rule]} | {title} |")
    out += ["", "By source kind: " + "; ".join(f"{r} " + ", ".join(f"{k} {n}" for k, n in sorted(c.items())) for r, c in summary["by_source"].items() if c)]
    for rule, title in RULES.items():
        total = summary["counts"][rule]
        out += ["", f"## {rule} {title}", "", f"{total} violation(s); showing {len(summary['examples'][rule])}.", ""]
        for v in summary["examples"][rule]:
            out.append(f"- **{v['company']}** | line `{v['line_id']}` | key `{v['key']}` | source {v['source']} | {v['why']}")
    explained = ctx.get("r7_explained") or []
    out += ["", f"## R7 explained exceptions", "", f"{len(explained)} hit(s) the source itself explains; showing {len(summary['r7_explained_examples'])}.", ""]
    for v in summary["r7_explained_examples"]:
        out.append(f"- **{v['company']}** | key `{v['key']}` | source {v['source']} | {v['why']} | explained: {v['explained']}")
    return "\n".join(out) + "\n"


def load_context(conn, baseline_table=None):
    """Read every table the rules need. The connection must already be read-only."""
    import psycopg2.extras
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        baseline = []
        if baseline_table:
            if not re.fullmatch(r"[a-z_][a-z0-9_]*", baseline_table):
                raise SystemExit("refusing to run: the baseline table name is not a plain identifier")
            cur.execute("select to_regclass(%s) as t", (baseline_table,))
            if cur.fetchone()["t"]:
                cur.execute(f"select * from {baseline_table} order by company_id, id")
                baseline = [dict(r) for r in cur.fetchall()]
        cur.execute("select * from buyer_interest order by company_id, id")
        lines = [dict(r) for r in cur.fetchall()]
        cur.execute("select id, company_id, summary, status, closed_reason, spec, note, source_quote from crm_bulk_listings where kind = 'demand'")
        demands = {r["id"]: dict(r) for r in cur.fetchall()}
        cur.execute("select id, bulk_listing_id, company_id, stage, declined_reason from crm_bulk_offers")
        offers = {r["id"]: dict(r) for r in cur.fetchall()}
        suppressed_by_demand = collections.defaultdict(list)
        cur.execute("select to_regclass('buyer_interest_suppressed') as t")
        if cur.fetchone()["t"]:
            cur.execute("select product_key, source_ref from buyer_interest_suppressed where source_ref like 'crm:%'")
            for r in cur.fetchall():
                suppressed_by_demand[r["source_ref"][4:]].append(r["product_key"])
        cur.execute("select id, name, buyer_profile, buyer_dossier from crm_companies "
                    "where id in (select company_id from buyer_interest)")
        companies = {}
        for r in cur.fetchall():
            products = []
            if r["buyer_dossier"]:
                frontmatter, _ = buyer_dossier.parse(r["buyer_dossier"])
                products = [p for p in (frontmatter.get("products") or []) if isinstance(p, dict)]
            companies[r["id"]] = {"name": r["name"], "buyer_profile": r["buyer_profile"] or {}, "dossier_products": products}
    return {"lines": lines, "demands": demands, "offers": offers, "companies": companies, "baseline_lines": baseline,
            "suppressed_by_demand": dict(suppressed_by_demand)}


def connect_read_only(dsn):
    import psycopg2
    conn = psycopg2.connect(dsn, options="-c default_transaction_read_only=on")
    conn.set_session(readonly=True, autocommit=False)
    with conn.cursor() as cur:
        cur.execute("show default_transaction_read_only")
        if cur.fetchone()[0] != "on":
            raise SystemExit("refusing to run: the session is not read-only")
    return conn


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--dsn", required=True)
    parser.add_argument("--out", help="Markdown report path")
    parser.add_argument("--json", dest="json_out", help="JSON summary path")
    parser.add_argument("--findings-jsonl", help="write every finding, one JSON object per line, with a stable key")
    parser.add_argument("--limit", type=int, default=EXAMPLES_PER_RULE,
                        help="hits listed per rule in the report and JSON (default 20, 0 = all)")
    parser.add_argument("--baseline-table", default="buyer_interest_pre_rebuild",
                        help="table of the lines before the change, for R7 (R7 is skipped when it does not exist)")
    args = parser.parse_args(argv)
    conn = connect_read_only(args.dsn)
    try:
        ctx = load_context(conn, args.baseline_table)
    finally:
        conn.rollback()
        conn.close()
    results = check(ctx)
    label = re.sub(r"password=\S+", "password=***", args.dsn)
    report = render_markdown(ctx, results, label, args.limit)
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(report, encoding="utf-8")
    else:
        print(report)
    if args.json_out:
        Path(args.json_out).write_text(json.dumps(summarise(ctx, results, args.limit), indent=2, default=str), encoding="utf-8")
    if args.findings_jsonl:
        Path(args.findings_jsonl).parent.mkdir(parents=True, exist_ok=True)
        Path(args.findings_jsonl).write_text(
            "".join(json.dumps(r, ensure_ascii=False, default=str) + "\n" for r in finding_records(results)), encoding="utf-8")
    print(json.dumps({"lines": len(ctx["lines"]), "counts": {r: len(v) for r, v in results.items()}}))


if __name__ == "__main__":
    main()
