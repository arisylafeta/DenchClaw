#!/usr/bin/env python3
"""Read-only conformance checker for the Wants (buyer_interest) lines.

Reports every violation of seven rules, from the lines against the sources that produced them:

  R1  invented combination: a make/chemistry/format pairing the source does not state together (demand rows, offers,
      dossier products, parsed text; not buy-box lists, whose cross product is independent criteria).
  R2  declined line whose only source is a closed request (no declined offer, no dossier declined product).
  R3  model key slug that is not the canonical slug of model_aliases.model_slug().
  R4  duplicate lines (company + kind + product_key) and a less specific line next to a more specific one
      from the same source.
  R5  vehicle make carrying the systems format.
  R6  lost detail: cell makers, cell formats, part numbers, kWh or voltage the source states and no line of
      that source carries. Cell maker, part number and kWh count only in product_key, raw_product, make, model or the
      kWh columns (matching reads those, not `stated`); cell format and voltage may sit in `stated`.
  R7  regression against a baseline table (default buyer_interest_pre_rebuild): per source and kind the best key level
      dropped (part > pack > model > cell > broad), a part number, cell maker, cell key or model key of the old keys is
      in none of the source's new keys, or a company lost all lines of a kind. A hit whose detail the source (demand
      row text, dossier products) no longer states, or a decline removed by R2, is listed as explained.

The rule functions take plain dicts (see `check`), so they need no database. `main` reads one database in a
read-only session and writes nothing to it.

  wants_conformance.py --dsn "dbname=denchclaw" --out report.md --json summary.json
"""
import argparse
import collections
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


def r2(ctx):
    found = []
    declined_offer_ids = {o["id"] for o in ctx["offers"].values() if o.get("stage") in ("declined", "lost")}
    declined_listings = {(o.get("company_id"), o.get("bulk_listing_id")) for o in ctx["offers"].values()
                         if o.get("stage") in ("declined", "lost")}
    for line in ctx["lines"]:
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
    by_source = collections.defaultdict(list)
    for line in ctx["lines"]:
        by_source[(_source_key(line), line.get("kind"))].append(line)
    for items in by_source.values():
        for a in items:
            for b in items:
                if a is not b and _less_specific(a, b):
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
        if norm_format(line.get("format")) == "system" and line.get("make") and make_folds(line["make"]) & VEHICLE_MAKES:
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
            items += [("cell format", "text", v) for v in as_list(product.get("cell_format"))]
            items += [("kWh", "kwh", num(v)) for v in as_list(product.get("kwh")) + as_list(product.get("kwh_min")) + as_list(product.get("kwh_max"))]
            maker = product.get("make")
            if maker and fold(maker) in {fold(n) for n in buyer_dossier.CELL_MAKERS + buyer_dossier.EXTRA_CELL_MAKERS}:
                items.append(("cell maker", "text", maker))
            lost = _lost(blob, numbers, [i for i in items if i[2] is not None], stated_blob)
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

# ---------------------------------------------------------------------------------------------- run and report

RULE_FUNCTIONS = {"R1": r1, "R2": r2, "R3": r3, "R4": r4, "R5": r5, "R6": r6, "R7": r7}


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
            "r7_explained": len(ctx.get("r7_explained") or []),
            "r7_explained_examples": top_examples(ctx.get("r7_explained") or [], limit)}


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
        cur.execute("select id, name, buyer_profile, buyer_dossier from crm_companies "
                    "where id in (select company_id from buyer_interest)")
        companies = {}
        for r in cur.fetchall():
            products = []
            if r["buyer_dossier"]:
                frontmatter, _ = buyer_dossier.parse(r["buyer_dossier"])
                products = [p for p in (frontmatter.get("products") or []) if isinstance(p, dict)]
            companies[r["id"]] = {"name": r["name"], "buyer_profile": r["buyer_profile"] or {}, "dossier_products": products}
    return {"lines": lines, "demands": demands, "offers": offers, "companies": companies, "baseline_lines": baseline}


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
    print(json.dumps({"lines": len(ctx["lines"]), "counts": {r: len(v) for r, v in results.items()}}))


if __name__ == "__main__":
    main()
