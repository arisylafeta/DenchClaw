#!/usr/bin/env python3
"""Read-only conformance checker for the Wants (buyer_interest) lines.

Reports every violation of six rules, from the lines against the sources that produced them:

  R1  invented combination: a make/chemistry/format pairing the source does not state together.
  R2  declined line whose only source is a closed request (no declined offer, no dossier declined product).
  R3  model key slug that is not the canonical slug of model_aliases.model_slug().
  R4  duplicate lines (company + kind + product_key) and a less specific line next to a more specific one
      from the same source.
  R5  vehicle make carrying the systems format.
  R6  lost detail: cell makers, cell formats, part numbers, kWh or voltage the source states and no line of
      that source carries.

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


def line_blob(line):
    return fold(" ".join(str(line.get(k) or "") for k in ("product_key", "raw_product", "make", "model")))


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
            profile = (ctx["companies"].get(line.get("company_id")) or {}).get("buyer_profile") or {}
            lists = {"make": as_list(profile.get("makes")), "chemistry": as_list(profile.get("chemistries")),
                     "format": as_list(profile.get("formats"))}
            segs = segments(profile.get("wants"))
            source = f"buyer_profile of {line.get('company_id')}"
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
    return True


def r4(ctx):
    found = []
    groups = collections.defaultdict(list)
    for line in ctx["lines"]:
        groups[(line.get("company_id"), line.get("kind"), line.get("product_key"))].append(line)
    for (_, kind, key), items in groups.items():
        if len(items) > 1:
            ids = ", ".join(i["id"] for i in items)
            for item in items[1:]:
                found.append(_violation(ctx, "R4", item, f"duplicate of {items[0]['id']} (same company, kind {kind}, key {key}); lines: {ids}"))
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


def _lost(blob, numbers, items):
    return [f"{label} {value}" for label, kind, value in items if value not in (None, "") and not _carried(blob, numbers, kind, value)]


def _voltages(*texts):
    return [f"{m}V" for text in texts for m in re.findall(r"(?<![\w.])(\d{2,4})\s?V\b", str(text or ""))]


def r6(ctx):
    found = []
    by_demand = collections.defaultdict(list)
    by_company_dossier = collections.defaultdict(list)
    for line in ctx["lines"]:
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
        numbers = set().union(*(kwh_numbers(line) for line in lines))
        lost = _lost(blob, numbers, items)
        if lost:
            found.append(_violation(ctx, "R6", lines[0], f"source states {'; '.join(lost)} but none of its {len(lines)} line(s) carries it", f"demand {demand_id}", key=f"{len(lines)} line(s): {lines[0]['product_key']}"))
    for company_id, lines in by_company_dossier.items():
        company = ctx["companies"].get(company_id) or {}
        blob = "".join(line_blob(line) for line in lines)
        numbers = set().union(*(kwh_numbers(line) for line in lines))
        for product in company.get("dossier_products") or []:
            items = [("part number", "text", v) for v in as_list(product.get("part_number"))]
            items += [("cell format", "text", v) for v in as_list(product.get("cell_format"))]
            items += [("kWh", "kwh", num(v)) for v in as_list(product.get("kwh")) + as_list(product.get("kwh_min")) + as_list(product.get("kwh_max"))]
            maker = product.get("make")
            if maker and fold(maker) in {fold(n) for n in buyer_dossier.CELL_MAKERS + buyer_dossier.EXTRA_CELL_MAKERS}:
                items.append(("cell maker", "text", maker))
            lost = _lost(blob, numbers, [i for i in items if i[2] is not None])
            if lost:
                label = " ".join(str(product.get(k)) for k in ("make", "model") if product.get(k)) or "product"
                found.append(_violation(ctx, "R6", lines[0], f"dossier product {label} states {'; '.join(lost)} but no dossier line carries it", f"dossier of {company_id}", key=f"dossier product {label}"))
    return found


# ---------------------------------------------------------------------------------------------- run and report

RULE_FUNCTIONS = {"R1": r1, "R2": r2, "R3": r3, "R4": r4, "R5": r5, "R6": r6}


def check(ctx):
    """ctx = {"lines": [dict], "demands": {id: dict}, "offers": {id: dict}, "companies": {id: dict}}; returns violations by rule."""
    return {rule: fn(ctx) for rule, fn in RULE_FUNCTIONS.items()}


def source_kind(source):
    first = str(source).split()[0]
    return first if first in ("demand", "buyer_profile", "dossier", "offer", "saved") else "other"


def summarise(ctx, results):
    return {"lines": len(ctx["lines"]),
            "counts": {rule: len(items) for rule, items in results.items()},
            "companies": {rule: len({v["company_id"] for v in items}) for rule, items in results.items()},
            "by_source": {rule: dict(collections.Counter(source_kind(v["source"]) for v in items)) for rule, items in results.items()},
            "examples": {rule: top_examples(items) for rule, items in results.items()}}


def top_examples(items, limit=EXAMPLES_PER_RULE):
    """The companies with the most violations first, so the worst offenders show."""
    per_company = collections.Counter(v["company_id"] for v in items)
    return sorted(items, key=lambda v: (-per_company[v["company_id"]], str(v["company_id"]), str(v["line_id"])))[:limit]


def render_markdown(ctx, results, dsn_label=""):
    summary = summarise(ctx, results)
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
    return "\n".join(out) + "\n"


def load_context(conn):
    """Read every table the rules need. The connection must already be read-only."""
    import psycopg2.extras
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
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
    return {"lines": lines, "demands": demands, "offers": offers, "companies": companies}


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
    args = parser.parse_args(argv)
    conn = connect_read_only(args.dsn)
    try:
        ctx = load_context(conn)
    finally:
        conn.rollback()
        conn.close()
    results = check(ctx)
    label = re.sub(r"password=\S+", "password=***", args.dsn)
    report = render_markdown(ctx, results, label)
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(report, encoding="utf-8")
    else:
        print(report)
    if args.json_out:
        Path(args.json_out).write_text(json.dumps(summarise(ctx, results), indent=2, default=str), encoding="utf-8")
    print(json.dumps({"lines": len(ctx["lines"]), "counts": {r: len(v) for r, v in results.items()}}))


if __name__ == "__main__":
    main()
