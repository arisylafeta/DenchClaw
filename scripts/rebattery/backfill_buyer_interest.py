#!/usr/bin/env python3
"""Backfill buyer_interest from the rows that already hold a buyer's wishes (foundation step 1b).

Migration 112 adds the table, its keys and the sync triggers, but triggers only look forwards. This script
replays the write paths that already exist over the existing data, so nothing has to be typed by hand:

  demand    every crm_bulk_listings row of kind demand, through buyer_interest_sync_demand_row(): open asks,
            closed asks that lapsed, and bought/declined outcomes. Rows that state no buying fact clear their
            lines, exactly as the trigger does.
  offer     every crm_bulk_offers row, through buyer_interest_sync_offer_row(): a counterparty that signed or
            paid is a bought line, a declined or lost one is a declined line with its reason.
  profile   closed research_profile and moved_to_profile demand rows, through the importer's own
            upsert_profile_interest(): researched facts are inferred lines, stated facts are standing ones.
            A row that states no product fact falls back to the company's buy box, cited as crm:<company id>.
  search    saved searches from the evidence the CRM still holds: saved_search context notes and demand rows
            whose source is a saved search. The live saved searches are on the platform and are NOT read here.
  dossier   the pilot dossiers' frontmatter products, as mastered lines (asked -> standing, said_interested ->
            interest) and as bought/declined history when no offer or demand row already says the same thing.
            A product that names several makes is one line per make; a prose model falls back to its make-level
            key with the wording kept on the line. The dossier text is not touched.
  buy box   the buy boxes no other batch reaches: no dossier, no line, no closed profile row. Inferred lines from
            the profile's own facts, first seen when the profile was made (buyer_profiled_at, else the earliest
            recorded profile change). This is the coverage floor, not a guess about what the buyer wants.

A source that states no product fact at all is not turned into a broad:any-batteries line: it is recorded in
buyer_interest_sync_errors as operation 'no_product_facts' (with the source id) so a person can fix the source.

Dry run by default: every batch (200 rows) runs in its own transaction and is rolled back, so no lock outlives a
batch. A batch does not see what the one before it would have written, so the dry run's end total is the start plus
the batches' own changes, a close estimate rather than the exact apply result. --apply writes one transaction per
batch. Any run, dry or apply, against a connection whose current_database() is denchclaw needs --i-have-approval.
The session runs with lock_timeout 3s and statement_timeout 60s; a row that hits a timeout or a deadlock is retried
once, then recorded in buyer_interest_sync_errors (operation 'backfill_timeout'), reported, and the run continues.
Re-running is safe: every path upserts on its own unique key, and the dossier lines carry a deterministic id.

  backfill_buyer_interest.py --dsn <dsn>                      # dry run (production needs --i-have-approval)
  backfill_buyer_interest.py --dsn <dsn> --apply              # write (production needs --i-have-approval)
  backfill_buyer_interest.py --dsn <dsn> --preview FILE.md    # write the approval preview, writes nothing
"""
import argparse
import datetime as dt
import hashlib
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from demand_lifecycle import upsert_profile_interest, upsert_saved_search_interest  # noqa: E402
import buyer_dossier  # noqa: E402

DEFAULT_DSN = "host=/var/run/postgresql dbname=denchclaw"
PROFILE_REASONS = ("research_profile", "moved_to_profile")
# Dossier product status -> the line kind it becomes. `asked` is a want the buyer stated to us, not a live ask:
# asks are synced demand rows and must not be invented here.
DOSSIER_KINDS = {
    "asked": ("standing", "mastered"),
    "said_interested": ("interest", "mastered"),
    "bought": ("bought", "synced"),
    "declined": ("declined", "synced"),
}
BATCH = 200


# ---------------------------------------------------------------------------
# Safety: never write the live database by accident
# ---------------------------------------------------------------------------
def _dsn_params(dsn):
    from psycopg2.extensions import parse_dsn
    params = parse_dsn(dsn or "")
    return params


def is_production_dsn(dsn):
    """True for the live CRM database: the local socket database, or denchclaw on the default local port.

    The rehearsal copy listens on another port, so a disposable container never matches.
    """
    try:
        params = _dsn_params(dsn)
    except Exception:
        return False
    dbname = (params.get("dbname") or params.get("database") or "").strip()
    if dbname != "denchclaw":
        return False
    host = (params.get("host") or params.get("hostaddr") or "").strip()
    port = str(params.get("port") or "5432").strip()
    if host in ("", "/var/run/postgresql", "/tmp"):
        return True
    return host in ("localhost", "127.0.0.1", "::1") and port == "5432"


PRODUCTION_DATABASE = "denchclaw"


def refusal_for_database(db_name, approved):
    """Why a run (dry or apply) must not start, from the name the server reports for the connection (None when it may).

    The DSN is only what the caller typed: a tunnel, an alias or a changed port still lands on the live database, and
    only current_database() says which one that is. Anything named denchclaw needs --i-have-approval, on any host.
    """
    if (db_name or "").strip().lower() == PRODUCTION_DATABASE and not approved:
        return (f"the connection is to the database '{db_name}', the live CRM name; refusing to run without "
                "--i-have-approval (a disposable copy should be restored under another name)")
    return None


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------
def _record_error(cur, source_table, source_id, operation, message):
    """A failed row is recorded and skipped; it never aborts the batch."""
    cur.execute("savepoint bi_error")
    try:
        cur.execute("""insert into buyer_interest_sync_errors (source_table, source_id, operation, message)
                       values (%s, %s, %s, %s)""", (source_table, source_id, operation, str(message)[:500]))
        cur.execute("release savepoint bi_error")
    except Exception:
        cur.execute("rollback to savepoint bi_error")


def _in_batches(ids, size):
    for i in range(0, len(ids), size):
        yield ids[i:i + size]


def _clear_truncations(cur, source_ids):
    """A truncation note describes a source row's current fan-out, so a re-run rewrites it, never piles it up.

    The same holds for the no-product note: a row that now states a product must not keep the old complaint.
    """
    ids = [str(value) for value in source_ids if value]
    if ids:
        cur.execute("""delete from buyer_interest_sync_errors
                        where operation in ('truncated', 'no_product_facts') and source_id = any(%s)""", (ids,))


def _clear_notes(cur, source_id):
    """One source id keeps one note per operation: a re-run rewrites what it says, never appends a second."""
    cur.execute("""delete from buyer_interest_sync_errors
                    where source_id = %s and operation in ('truncated', 'no_product_facts')""", (str(source_id),))


def _ids(cur, sql, params=()):
    cur.execute(sql, params)
    return [row["id"] for row in cur.fetchall()]


# ---------------------------------------------------------------------------
# (a) Demand rows and offers: run the two sync functions the triggers call
# ---------------------------------------------------------------------------
LOCK_TIMEOUT = "3s"
STATEMENT_TIMEOUT = "60s"
# lock_not_available, deadlock_detected, query_canceled (statement_timeout)
RETRYABLE = {"55P03", "40P01", "57014"}


def _set_timeouts(cur):
    """Per transaction batch: a rollback undoes a plain SET, so each batch sets them again."""
    cur.execute(f"set lock_timeout = '{LOCK_TIMEOUT}'")
    cur.execute(f"set statement_timeout = '{STATEMENT_TIMEOUT}'")


def _run_row(cur, sql, params):
    """Run one row's statement in its own savepoint. A timeout or deadlock is retried once.

    Returns (ok, error). A non-retryable error comes back as (False, exc, False); a second timeout as
    (False, exc, True), so the caller can tell a timeout from a failure.
    """
    last = None
    for attempt in (1, 2):
        cur.execute("savepoint bi_row")
        try:
            cur.execute(sql, params)
            cur.execute("release savepoint bi_row")
            return True, None, False
        except Exception as exc:  # noqa: BLE001
            cur.execute("rollback to savepoint bi_row")
            last = exc
            if getattr(exc, "pgcode", None) not in RETRYABLE:
                return False, exc, False
    return False, last, True


def sync_source_rows(cur, source_table, ids):
    """One sync function per source row, in a savepoint, so one bad row cannot fail the batch.

    The functions are the same ones the triggers call, so a backfilled line and a triggered line are identical.
    """
    function = {"crm_bulk_listings": "buyer_interest_sync_demand_row",
                "crm_bulk_offers": "buyer_interest_sync_offer_row"}[source_table]
    _clear_truncations(cur, ids)
    synced, errors, timeouts = 0, 0, 0
    for row_id in ids:
        ok, exc, timed_out = _run_row(cur, f"select {function}(%s)", (row_id,))
        if ok:
            synced += 1
            continue
        # Recorded, then the batch continues.
        _record_error(cur, source_table, row_id, "backfill_timeout" if timed_out else "backfill", exc)
        errors += 1
        timeouts += 1 if timed_out else 0
    return {"rows": len(ids), "synced": synced, "errors": errors, "timeouts": timeouts}


def demand_ids(cur):
    return _ids(cur, "select id from crm_bulk_listings where kind = 'demand' order by id")


def offer_ids(cur):
    return _ids(cur, "select id from crm_bulk_offers order by id")


# ---------------------------------------------------------------------------
# (b) The importer profile path for researched and lapsed demand
# ---------------------------------------------------------------------------
def profile_rows(cur, ids=None):
    """Closed research_profile / moved_to_profile rows with the company's buy box alongside."""
    sql = """select l.id, l.company_id, l.person_id, l.observed_on, l.spec, l.source_id, l.source_kind,
                    c.buyer_profile, c.buyer_dossier
               from crm_bulk_listings l join crm_companies c on c.id = l.company_id
              where l.kind = 'demand' and l.status = 'closed' and l.closed_reason = any(%s)"""
    params = [list(PROFILE_REASONS)]
    if ids:
        sql += " and l.id = any(%s)"
        params.append(list(ids))
    cur.execute(sql + " order by l.id", params)
    return cur.fetchall()


BUY_BOX_KEYS = ("makes", "chemistries", "formats", "cell_makers", "part_numbers", "kwh_min", "kwh_max", "model")


def _states_product(spec):
    """True when the spec names a product fact; a timing-only spec does not."""
    return any(spec.get(key) not in (None, "", [], {}) for key in BUY_BOX_KEYS)


def sync_profile_rows(cur, rows):
    """Basis comes from the row: a stated want is standing, an estimated or researched one is inferred.

    A company with a buyer dossier is not written here, exactly as merge_profile refuses one: the dossier owns
    that buyer's lines and a research run must not add an unapproved want beside them.
    """
    written, skipped, from_buy_box, errors, dossier = 0, 0, 0, 0, 0
    _clear_truncations(cur, [row.get("source_id") for row in rows])
    for row in rows:
        if row.get("buyer_dossier"):
            dossier += 1
            continue
        spec = dict(row.get("spec") or {})
        buy_box = row.get("buyer_profile") or {}
        source_refs = [row["source_id"]] if row.get("source_id") else []
        box_spec = False
        if not _states_product(spec):
            filled = {key: buy_box[key] for key in BUY_BOX_KEYS if buy_box.get(key) not in (None, "", [], {})}
            if not filled:
                skipped += 1  # nothing states a product: no line is invented
                continue
            spec = {**filled, **spec}
            source_refs = [f"crm:{row['company_id']}"]
            from_buy_box += 1
            box_spec = True
        basis = "stated" if str(spec.get("basis") or "").lower() == "stated" else "researched"
        payload = {
            "company_id": row["company_id"], "person_id": row.get("person_id"), "spec": spec,
            "observed_on": row.get("observed_on"), "source_id": row.get("source_id"),
            "volume": spec.get("volume"), "volume_unit": spec.get("volume_unit"),
            "max_price": spec.get("max_price"), "price_currency": spec.get("price_currency"),
            "price_unit": spec.get("price_unit"), "source_refs": source_refs,
        }
        cur.execute("savepoint bi_row")
        try:
            upsert_profile_interest(cur, payload, basis, independent=box_spec)
            cur.execute("release savepoint bi_row")
            written += 1
        except Exception as exc:  # noqa: BLE001
            cur.execute("rollback to savepoint bi_row")
            _record_error(cur, "crm_bulk_listings", row["id"], "profile", exc)
            errors += 1
    return {"rows": len(rows), "written": written, "skipped": skipped, "from_buy_box": from_buy_box,
            "dossier_skipped": dossier, "errors": errors}


# ---------------------------------------------------------------------------
# (c) Saved searches the CRM already holds (the platform's own list is out of reach)
# ---------------------------------------------------------------------------
NOTE_FIELDS = {"makes": "makes", "make": "makes", "chemistry": "chemistries", "chemistries": "chemistries",
               "format": "formats", "formats": "formats", "kwh": "kwh", "cell maker": "cell_makers"}


def spec_from_note(note):
    """A saved_search context note is `Label - Makes: Tesla - Formats: Packs`; read its facts back."""
    spec = {}
    text = str(note or "")
    body = text.split(" - ", 1)[1] if " - " in text else ""
    for part in body.split(" - "):
        if ":" not in part:
            continue
        key, value = part.split(":", 1)
        field = NOTE_FIELDS.get(key.strip().lower())
        if not field:
            continue
        values = [item.strip() for item in value.split(",") if item.strip()]
        if field in ("kwh_min", "kwh_max"):
            spec[field] = values[0]
        elif field == "kwh":
            spec["kwh"] = values[0]
        else:
            spec[field] = values
    return spec


def saved_search_rows(cur):
    """Two stores hold saved-search evidence: context notes, and demand rows imported from a saved search."""
    cur.execute("""select id, company_id, note, source_ref, observed_on
                     from crm_company_context_notes
                    where category = 'saved_search' and company_id is not null order by id""")
    rows = [{"id": r["id"], "company_id": r["company_id"], "person_id": None,
             "spec": spec_from_note(r["note"]), "observed_on": r["observed_on"],
             "source_id": r["source_ref"] or "",
             "source_kind": "saved_search", "source": "context_note"} for r in cur.fetchall()]
    cur.execute("""select id, company_id, person_id, spec, source_id, observed_on
                     from crm_bulk_listings
                    where kind = 'demand' and company_id is not null
                      and (source_id like 'saved_search:%%' or source_kind = 'saved_search')
                    order by id""")
    rows += [{"id": r["id"], "company_id": r["company_id"], "person_id": r["person_id"],
              "spec": dict(r.get("spec") or {}), "observed_on": r["observed_on"],
              "source_id": r["source_id"] or "", "source_kind": "saved_search", "source": "demand_row"}
             for r in cur.fetchall()]
    return rows


def sync_saved_search_rows(cur, rows):
    """Open while nothing says the buyer unsubscribed; the platform's own status is not readable here."""
    written, skipped, errors = 0, 0, 0
    _clear_truncations(cur, [row.get("source_id") for row in rows])
    for row in rows:
        search_id = str(row.get("source_id") or "")
        if not search_id.startswith("saved_search:"):
            search_id = f"saved_search:{search_id}" if search_id else ""
        if not search_id or not row.get("spec"):
            skipped += 1
            continue
        payload = {"company_id": row["company_id"], "person_id": row.get("person_id"),
                   "spec": row["spec"], "observed_on": row.get("observed_on"),
                   "source_id": search_id, "source_kind": "saved_search"}
        cur.execute("savepoint bi_row")
        try:
            upsert_saved_search_interest(cur, payload)
            cur.execute("release savepoint bi_row")
            written += 1
        except Exception as exc:  # noqa: BLE001
            cur.execute("rollback to savepoint bi_row")
            _record_error(cur, "crm_company_context_notes", row["id"], "saved_search", exc)
            errors += 1
    return {"rows": len(rows), "written": written, "skipped": skipped, "errors": errors}


# ---------------------------------------------------------------------------
# (d) The pilot dossiers' frontmatter products
# ---------------------------------------------------------------------------
def dossier_rows(cur):
    cur.execute("""select id, name, buyer_dossier from crm_companies
                    where buyer_dossier is not null order by id""")
    return cur.fetchall()


_KWH_FIGURE = re.compile(r"(\d+(?:[.,]\d+)?)\s*kwh\b", re.IGNORECASE)
_TRIM_WORDS = re.compile(r"\b(?:long\s+range|standard\s+range|dual\s+motor|awd|rwd|fwd|van|truck)\b", re.IGNORECASE)
_FORMAT_WORD = re.compile(r"\b(cells?|modules?|packs?)\b", re.IGNORECASE)
_BRANDS = ("volkswagen|vw|audi|mini|skoda|cupra|porsche|bmw|mercedes-benz|mercedes|tesla|stellantis|nissan|renault|dacia|"
           "peugeot|citroen|opel|vauxhall|fiat|jeep|ford|hyundai|kia|genesis|toyota|lexus|honda|mazda|mitsubishi|suzuki|"
           "subaru|volvo|polestar|jaguar|land rover|mg|byd|lotus|lucid|rivian|nio|xpeng|zeekr|leapmotor|maxus")
_BRAND_START = re.compile(rf"^(?:{_BRANDS})\b", re.IGNORECASE)
# One dossier product fans out to at most this many lines, as a demand row's fact sets are capped.
FAN_OUT_CAP = 12


def _is_prose(model):
    """Mirrors buyer_interest_prose_model(): a model that lists vehicles or years rather than naming one."""
    text = (model or "").strip()
    return bool(text) and bool(re.search(r"[(),;/:]", text) or len(text.split()) >= 4
                               or re.search(r"\b(19|20)[0-9]{2}\b", text))


def clean_model(model):
    """(model, kwh, changed): the model without a capacity, an aside or a trim word, when what remains is a
    model the key builder accepts. The kWh figure is returned for the caller to use only when kwh is missing."""
    text = " ".join((model or "").split())
    figure = _KWH_FIGURE.search(text)
    kwh = float(figure.group(1).replace(",", ".")) if figure else None
    cleaned = _KWH_FIGURE.sub(" ", text)
    cleaned = re.sub(r"\([^)]*\)|\[[^\]]*\]", " ", cleaned)
    cleaned = " ".join(cleaned.split()).strip(" :-,;/")
    trimmed = " ".join(_TRIM_WORDS.sub(" ", cleaned).split()).strip(" :-,;/")
    for candidate in (trimmed, cleaned):
        if candidate and not _is_prose(candidate):
            return candidate, kwh, candidate != text
    return text, kwh, False


def _known_model_piece(part, own):
    """A piece of a slash list stands for a model: a brand with something left, or a name of two or more characters.
    "Model S/X" is one model, not "Model S" and a bare "X"."""
    part = " ".join(part.split())
    for name in sorted((make for make in own if make), key=len, reverse=True):
        if re.match(rf"{re.escape(name)}\b", part, re.IGNORECASE):
            part = part[len(name):].strip()
            break
    else:
        brand = _BRAND_START.match(part)
        if brand:
            part = part[brand.end():].strip()
    return len(re.sub(r"[^0-9A-Za-z]", "", _FORMAT_WORD.sub(" ", part))) >= 2


def _model_pieces(model, makes):
    """A list of models split into (make, format, model_text) pieces; a single model is one piece.

    A "/" splits only when every piece is a model of its own ("ID.3/ID.4"); otherwise it belongs to the model."""
    text = re.sub(r"\([^)]*\)|\[[^\]]*\]", " ", model or "")
    parts = [part for part in re.split(r"\s*(?:,|;|/|\band\b)\s*", text, flags=re.IGNORECASE) if part and part.strip()]
    if "/" in text and not all(_known_model_piece(part, makes) for part in parts):
        parts = [part for part in re.split(r"\s*(?:,|;|\band\b)\s*", text, flags=re.IGNORECASE) if part and part.strip()]
    if len(parts) < 2:
        return None
    own = sorted((make for make in makes if make), key=len, reverse=True)
    pieces = []
    for part in parts:
        part = " ".join(part.split())
        make = None
        for name in own:
            if re.match(rf"{re.escape(name)}\b", part, re.IGNORECASE):
                make, part = name, part[len(name):].strip()
                break
        else:
            brand = _BRAND_START.match(part)
            if brand:
                make, part = brand.group(0), part[brand.end():].strip()
        fmt = _FORMAT_WORD.search(part)
        if fmt:
            part = " ".join(_FORMAT_WORD.sub(" ", part).split())
        pieces.append((make, fmt.group(1).lower().rstrip("s") + "s" if fmt else None, part))
    return pieces


def product_facts(product):
    """One dossier product as a list of fact dicts in the shape the key builder reads. Missing stays missing.

    The model is cleaned first: a capacity in it moves to kwh when kwh is missing (never invented), an aside
    in brackets and words like Long Range or AWD go when a known model remains, and a list of models
    ("ID.3, ID.4, Cupra Born") becomes one fact dict per model. The original text goes to `raw_model`.
    """
    base = {}
    if isinstance(product.get("part_number"), str) and product["part_number"].strip():
        base["part_numbers"] = [product["part_number"].strip()]
    for key in ("make", "model", "chemistry"):
        if isinstance(product.get(key), str) and product[key].strip():
            base[key] = product[key].strip()
    if isinstance(product.get("format"), str) and product["format"].strip():
        base["format"] = product["format"].strip()
    # R6: the cell format a dossier product states stays on its line (buyer_interest.stated), as a demand row's does.
    cell_formats = product.get("cell_format")
    cell_formats = cell_formats if isinstance(cell_formats, list) else [cell_formats]
    cell_formats = [f.strip() for f in cell_formats if isinstance(f, str) and f.strip()]
    if cell_formats:
        base["cell_formats"] = cell_formats
    kwh = product.get("kwh")
    if isinstance(kwh, list) and kwh:
        values = [value for value in kwh if isinstance(value, (int, float))]
        if len(values) == 1:
            base["kwh"] = values[0]
        elif len(values) >= 2:
            base["kwh_min"], base["kwh_max"] = min(values), max(values)
    elif isinstance(kwh, (int, float)):
        base["kwh"] = kwh
    elif product.get("kwh_min") is not None or product.get("kwh_max") is not None:
        base["kwh_min"] = product.get("kwh_min")
        base["kwh_max"] = product.get("kwh_max")
    model = base.get("model")
    if not model:
        return [base]
    states_kwh = any(base.get(key) is not None for key in ("kwh", "kwh_min", "kwh_max"))
    makes = [make.strip() for make in re.split(r"\s*(?:,|/|&|\band\b)\s*", base.get("make", ""), flags=re.IGNORECASE)]

    pieces = _model_pieces(model, makes)
    if pieces is None:
        cleaned, found, changed = clean_model(model)
        if found is not None and not states_kwh:
            base["kwh"] = found
        if changed:
            base["model"], base["raw_model"] = cleaned, model
        return [base]

    variants = []
    for make, fmt, part in pieces:
        fact = {key: value for key, value in base.items() if key != "model"}
        cleaned, found, _changed = clean_model(part) if part else (None, None, False)
        if make:
            fact["make"] = make
        if fmt and not fact.get("format"):
            fact["format"] = fmt
        if found is not None and not states_kwh:
            fact["kwh"] = found
        if cleaned and not _is_prose(cleaned):
            fact["model"] = cleaned
        # A piece with no usable model and nothing of its own (no format) adds only a make-only line; when the
        # product already states a make, that line is the product's own and the piece must not widen it.
        if "model" not in fact and not fmt and base.get("make"):
            continue
        fact["raw_model"] = model
        if fact not in variants:
            variants.append(fact)
    if not variants:
        return [{key: value for key, value in base.items() if key != "model"}]
    return variants


def _fact_sets(cur, facts, independent=False):
    """The fact sets the SQL builder fans one source row into, plus how many combinations it states.
    independent: a buy box's lists multiply out (make x chemistry x format), as before 115."""
    cur.execute("""select fs.facts as fact_sets, fs.stated_total as stated
                     from buyer_interest_fact_sets(%s::jsonb, '{}'::jsonb, '{}'::jsonb, 12, null, %s) fs""",
                (json.dumps(facts or {}), bool(independent)))
    row = cur.fetchone()
    return list(row["fact_sets"] or []), int(row["stated"] or 0)


def _drop_redundant(cur, fact_sets):
    """The fact sets with every one that a more specific set of the same source already says removed (R4), in SQL."""
    if len(fact_sets) < 2:
        return list(fact_sets)
    cur.execute("select buyer_interest_drop_redundant(array(select jsonb_array_elements(%s::jsonb))) as sets",
                (json.dumps(fact_sets),))
    return list(cur.fetchone()["sets"] or [])


def _keyed(cur, facts):
    """The product key and its facts, from the same SQL builder the triggers use."""
    payload = json.dumps(facts or {})
    cur.execute("""with facts as (select %s::jsonb as facts),
                        keyed as (select facts, buyer_interest_product_key(facts) as key from facts)
                   select key, buyer_interest_key_level(key) as level, buyer_interest_states_product(facts) as stated,
                          buyer_interest_raw_product(facts) as raw_product,
                          facts->>'make' as make, facts->>'model' as model, facts->'stated' as stated_facts,
                          buyer_interest_format(facts->>'format') as format,
                          buyer_interest_chemistry(facts->>'chemistry') as chemistry,
                          buyer_interest_number(facts->'kwh_min') as kwh_min,
                          buyer_interest_number(facts->'kwh_max') as kwh_max
                     from keyed""", (payload,))
    return cur.fetchone()


def _dossier_line_id(company_id, kind, key):
    digest = hashlib.sha1(f"{company_id}|{kind}|{key}".encode("utf-8")).hexdigest()[:24]
    return f"bi_dossier_{digest}"


def _already_says(cur, company_id, key, kind):
    """A bought or declined fact already sourced from an offer or a demand row is not repeated."""
    cur.execute("""select 1 from buyer_interest
                    where company_id = %s and product_key = %s and kind = %s
                      and (offer_id is not null or demand_id is not null) limit 1""", (company_id, key, kind))
    return cur.fetchone() is not None


def _write_line(cur, company_id, kind, ownership, keyed, seen, refs, reason=None):
    """One mastered line per product and make; a synced line per purchase or decline, keyed by its source."""
    stated_json = json.dumps(keyed["stated_facts"]) if keyed.get("stated_facts") else None  # R6
    if ownership == "mastered":
        cur.execute("""insert into buyer_interest (id, company_id, kind, ownership, product_key,
                         product_key_level, make, model, raw_product, format, chemistry, kwh_min, kwh_max,
                         first_seen, last_seen, quantity_basis, source_refs, expires_on, stated)
                       values (%s, %s, %s, 'mastered', %s, %s, %s, %s, %s, %s, %s, %s, %s,
                         coalesce(%s::date, current_date), coalesce(%s::date, current_date), 'not_stated',
                         %s::text[], coalesce(%s::date, current_date) + case when %s = 'standing'
                           then 90 else 180 end, %s::jsonb)
                       on conflict (company_id, product_key, kind) where ownership = 'mastered'
                       do update set first_seen = least(buyer_interest.first_seen, excluded.first_seen),
                         last_seen = greatest(buyer_interest.last_seen, excluded.last_seen),
                         expires_on = greatest(buyer_interest.expires_on, excluded.expires_on),
                         model = coalesce(buyer_interest.model, excluded.model),
                         raw_product = coalesce(buyer_interest.raw_product, excluded.raw_product),
                         stated = coalesce(excluded.stated, buyer_interest.stated),
                         source_refs = (select array_agg(distinct ref order by ref)
                           from unnest(buyer_interest.source_refs || excluded.source_refs) ref),
                         updated_at = now()""",
                    (_dossier_line_id(company_id, kind, keyed["key"]), company_id, kind,
                     keyed["key"], keyed["level"], keyed["make"], keyed["model"], keyed["raw_product"],
                     keyed["format"], keyed["chemistry"], keyed["kwh_min"], keyed["kwh_max"], seen, seen, refs,
                     seen, kind, stated_json))
    else:
        cur.execute("""insert into buyer_interest (id, company_id, kind, ownership, product_key,
                         product_key_level, make, model, raw_product, format, chemistry, kwh_min, kwh_max,
                         first_seen, last_seen, quantity_basis, source_refs, decline_reason, stated)
                       values (%s, %s, %s, 'synced', %s, %s, %s, %s, %s, %s, %s, %s, %s,
                         coalesce(%s::date, current_date), coalesce(%s::date, current_date), 'not_stated',
                         %s::text[], %s, %s::jsonb)
                       on conflict (id) do update set last_seen = greatest(buyer_interest.last_seen,
                         excluded.last_seen), decline_reason = excluded.decline_reason,
                         stated = coalesce(excluded.stated, buyer_interest.stated),
                         source_refs = (select array_agg(distinct ref order by ref)
                           from unnest(buyer_interest.source_refs || excluded.source_refs) ref),
                         updated_at = now()""",
                    (_dossier_line_id(company_id, kind, keyed["key"]), company_id, kind,
                     keyed["key"], keyed["level"], keyed["make"], keyed["model"], keyed["raw_product"],
                     keyed["format"], keyed["chemistry"], keyed["kwh_min"], keyed["kwh_max"], seen, seen, refs,
                     reason, stated_json))


ARCHIVE_TABLE = "buyer_interest_removed_20261115"


def drop_covered_lines(cur):
    """R4 across writers: a line is removed when another line of the same company, kind and source says more (the
    same test wants_conformance applies). Archived like a removed dossier line. Idempotent."""
    import wants_conformance as wc
    cur.execute("select * from buyer_interest order by company_id, id")
    lines = [dict(r) for r in cur.fetchall()]
    groups = {}
    for line in lines:
        groups.setdefault((wc._source_key(line), line.get("kind")), []).append(line)
    def same_product(a, b):
        # Only the same product is covered: a broad line the source states on its own (packs, modules and cells) stays
        # next to model lines of another make or format.
        fa, fb = wc.make_folds(a.get("make")), wc.make_folds(b.get("make"))
        if not ((not fa and not fb) or fa & fb):
            return False
        return a.get("product_key_level") not in ("broad", "cell") or wc.norm_format(a.get("format")) == wc.norm_format(b.get("format"))

    doomed = sorted({a["id"] for items in groups.values() for a in items
                     if any(a is not b and wc._less_specific(a, b) and same_product(a, b) for b in items)})
    if doomed:
        cur.execute("select to_regclass(%s) as name", (f"public.{ARCHIVE_TABLE}",))
        if (cur.fetchone() or {}).get("name"):
            cur.execute("select column_name from information_schema.columns where table_schema = 'public' "
                        "and table_name = %s intersect select column_name from information_schema.columns "
                        "where table_schema = 'public' and table_name = 'buyer_interest'", (ARCHIVE_TABLE,))
            cols = ", ".join(f'"{r["column_name"]}"' for r in cur.fetchall())
            cur.execute(f"insert into {ARCHIVE_TABLE} ({cols}) select {cols} from buyer_interest where id = any(%s)", (doomed,))
        cur.execute("delete from buyer_interest where id = any(%s)", (doomed,))
    return len(doomed)


def _remove_dossier_lines(cur, company_id):
    """Drop this company's earlier dossier lines before they are rewritten, so a key the dossier no longer produces
    (an old raw-model key, a product since removed) never lingers beside the new ones. Archived first when the
    archive table exists; otherwise skipped."""
    cur.execute("select to_regclass(%s) as name", (f"public.{ARCHIVE_TABLE}",))
    if (cur.fetchone() or {}).get("name"):
        # Columns both tables have: the archive predates later additions (price_max, stated).
        cur.execute("select column_name from information_schema.columns where table_schema = 'public' "
                    "and table_name = %s intersect select column_name from information_schema.columns "
                    "where table_schema = 'public' and table_name = 'buyer_interest'", (ARCHIVE_TABLE,))
        cols = ", ".join(f'"{r["column_name"]}"' for r in cur.fetchall())
        cur.execute(f"insert into {ARCHIVE_TABLE} ({cols}) select {cols} from buyer_interest "
                    "where company_id = %s and id like 'bi_dossier_%%'", (company_id,))
    cur.execute("delete from buyer_interest where company_id = %s and id like 'bi_dossier_%%'", (company_id,))
    return cur.rowcount


def sync_dossier_rows(cur, companies):
    """One mastered line per dossier product and per make it states; the frontmatter itself is left as it is."""
    written, skipped, from_source, no_facts, truncated, errors, superseded, removed = 0, 0, 0, 0, 0, 0, 0, 0
    for company in companies:
        frontmatter, _body = buyer_dossier.parse(company.get("buyer_dossier") or "")
        products = frontmatter.get("products") or []
        if isinstance(products, dict):  # a mapping instead of a list: one product
            products = [products]
        last_verified = frontmatter.get("last_verified")
        removed += _remove_dossier_lines(cur, company["id"])
        for index, product in enumerate(products):
            if not isinstance(product, dict):
                skipped += 1
                continue
            mapping = DOSSIER_KINDS.get(str(product.get("status") or "").strip().lower())
            if not mapping:
                skipped += 1  # no status: nothing to own the fact with
                continue
            kind, ownership = mapping
            cur.execute("savepoint bi_row")
            try:
                _clear_notes(cur, f"{company['id']}:{index}")
                # One line per stated combination, exactly as a demand row fans out: "BMW, Volvo" is two makes.
                keyed_lines, stated = [], 0
                raw_models = {}
                all_sets = []
                for variant in product_facts(product):
                    raw_model = variant.pop("raw_model", None)
                    fact_sets, count = _fact_sets(cur, variant)
                    stated += max(count - len(fact_sets), 0)
                    for fact in fact_sets:
                        raw_models[json.dumps(fact, sort_keys=True)] = raw_model
                        all_sets.append(fact)
                # R4: a product's variants never leave a less specific line next to a more specific one.
                for fact in _drop_redundant(cur, all_sets):
                    keyed = _keyed(cur, fact)
                    if keyed and keyed["stated"]:
                        # The original wording stays on the line when cleaning changed the model.
                        keyed["raw_product"] = raw_models.get(json.dumps(fact, sort_keys=True)) or keyed["raw_product"]
                        keyed_lines.append(keyed)
                keyed_lines = list({keyed["key"]: keyed for keyed in keyed_lines}.values())
                stated += len(keyed_lines)
                keyed_lines = keyed_lines[:FAN_OUT_CAP]
                if not keyed_lines:
                    cur.execute("release savepoint bi_row")
                    no_facts += 1
                    _record_error(cur, "crm_companies", f"{company['id']}:{index}", "no_product_facts",
                                  "dossier product states no product fact (make, chemistry, format, part or kWh): "
                                  + json.dumps(product, ensure_ascii=False)[:160])
                    continue
                if stated > len(keyed_lines):
                    truncated += 1
                    _record_error(cur, "crm_companies", f"{company['id']}:{index}", "truncated",
                                  f"kept {len(keyed_lines)} of {stated} stated combinations")
                seen = str(product.get("seen") or last_verified or "")[:10] or None
                refs = [str(product["src"])] if product.get("src") else [f"crm:dossier:{company['id']}"]
                reason = str(product["reason"]).strip() or None if isinstance(product.get("reason"), str) else None
                for keyed in keyed_lines:
                    if kind in ("bought", "declined") and _already_says(cur, company["id"], keyed["key"], kind):
                        from_source += 1
                        continue
                    _write_line(cur, company["id"], kind, ownership, keyed, seen, refs, reason)
                    written += 1
                cur.execute("release savepoint bi_row")
            except Exception as exc:  # noqa: BLE001
                cur.execute("rollback to savepoint bi_row")
                _record_error(cur, "crm_companies", company["id"], "dossier", exc)
                errors += 1
        # Newer evidence wins: a want the dossier later declined on the same key is history, not a live want
        # (ELG asked for NCR2170M on 16 Oct and declined it on 24 Oct).
        cur.execute("""delete from buyer_interest w
                        where w.company_id = %s and w.id like 'bi_dossier_%%' and w.kind <> 'declined'
                          and exists (select 1 from buyer_interest d
                                       where d.company_id = w.company_id and d.id like 'bi_dossier_%%'
                                         and d.kind = 'declined' and d.product_key = w.product_key
                                         and d.last_seen >= w.last_seen)""", (company["id"],))
        superseded += cur.rowcount
    return {"companies": len(companies), "written": written, "skipped": skipped, "superseded_by_decline": superseded, "removed_before_rewrite": removed,
            "already_from_source": from_source, "no_facts": no_facts, "truncated": truncated, "errors": errors}


# ---------------------------------------------------------------------------
# (e) Buy boxes nothing else reaches: the profile itself is the evidence
# ---------------------------------------------------------------------------
def buy_box_rows(cur):
    """Buy boxes with no dossier, no line and no closed profile row: the profile is the only thing stating them."""
    cur.execute("""select c.id, c.name, c.buyer_profile,
                          coalesce(c.buyer_profiled_at,
                            (select min(ch.changed_at)::date from crm_buyer_profile_changes ch
                              where ch.company_id = c.id)) as since
                     from crm_companies c
                    where c.buyer_profile is not null and c.buyer_profile <> '{}'::jsonb
                      and c.buyer_dossier is null
                      and not exists (select 1 from buyer_interest b where b.company_id = c.id)
                      and not exists (select 1 from crm_bulk_listings l
                                       where l.company_id = c.id and l.kind = 'demand' and l.status = 'closed'
                                         and l.closed_reason = any(%s))
                    order by c.id""", (list(PROFILE_REASONS),))
    return cur.fetchall()


def buy_box_spec(profile):
    """The product facts a buy box states, in the shape the fact-set builder reads."""
    profile = profile or {}
    return {key: profile[key] for key in BUY_BOX_KEYS if profile.get(key) not in (None, "", [], {})}


def wants_text_facts(profile):
    """Fact dicts for what the buy box's free `wants` text names and its lists miss: a make, a model with its make, a cell
    format (18650/21700). Bare Bolt names nothing. Returns (fact dicts, minimum Ah or None)."""
    import model_aliases as ma
    text = (profile or {}).get("wants")
    if not isinstance(text, str) or not text.strip():
        return [], None
    listed = {ma.make_fold(m) for key in ("makes", "cell_makers") for m in (profile.get(key) or [])
              if isinstance(m, str) for m in re.split(r"\s*(?:,|/|&|\band\b)\s*", m) if m}
    facts = []
    models = ma.text_stated_models(text, profile.get("makes") or ())
    for row in models:
        facts.append({"make": row["make"], "model": row["model"]})
    for make in ma.text_makes(text):
        if ma.make_fold(make) not in listed and not any(ma.make_fold(f["make"]) == ma.make_fold(make) for f in facts):
            facts.append({"make": make})
    for cell_format in ma.text_cell_formats(text):
        facts.append({"format": "cell", "cell_format": cell_format})
    return facts, ma.text_min_ah(text)


def sync_buy_box_rows(cur, companies):
    """An inferred line per stated fact, first seen when the profile was made.

    This is the coverage floor: a buyer with a buy box and no source row still gets the wants their profile states,
    and a profile that states no product is recorded rather than turned into an empty bucket.
    """
    written, skipped, truncated, errors = 0, 0, 0, 0
    for company in companies:
        profile = company["buyer_profile"] or {}
        cur.execute("savepoint bi_row")
        try:
            _clear_notes(cur, company["id"])
            fact_sets, stated = _fact_sets(cur, buy_box_spec(profile), independent=True)
            keyed_lines = [keyed for keyed in (_keyed(cur, fact) for fact in fact_sets) if keyed and keyed["stated"]]
            text_facts, min_ah = wants_text_facts(profile)
            have = {keyed["key"] for keyed in keyed_lines}
            for fact in text_facts:
                keyed = _keyed(cur, fact)
                if keyed and keyed["stated"] and keyed["key"] not in have:
                    keyed = dict(keyed)
                    if fact.get("cell_format"):
                        keyed["stated_facts"] = {"cell_formats": [fact["cell_format"]]}
                    keyed_lines.append(keyed)
                    have.add(keyed["key"])
            if min_ah is not None:
                label = f"min {min_ah:g} Ah"
                keyed_lines = [{**keyed, "raw_product": f"{keyed['raw_product']}; {label}" if keyed["raw_product"] else label}
                               for keyed in keyed_lines]
            if not keyed_lines:
                cur.execute("release savepoint bi_row")
                skipped += 1
                _record_error(cur, "crm_companies", company["id"], "no_product_facts",
                              "buy box states no product fact (make, chemistry, format, part or kWh): " + json.dumps(profile, ensure_ascii=False)[:160])
                continue
            if stated > len(keyed_lines):
                truncated += 1
                _record_error(cur, "crm_companies", company["id"], "truncated",
                              f"kept {len(keyed_lines)} of {stated} stated combinations")
            since = str(company["since"] or dt.date.today().isoformat())[:10]
            for keyed in keyed_lines:
                _write_line(cur, company["id"], "inferred", "mastered", keyed, since,
                            [f"crm:{company['id']}", "crm:buyer_profile"])
                written += 1
            cur.execute("release savepoint bi_row")
        except Exception as exc:  # noqa: BLE001
            cur.execute("rollback to savepoint bi_row")
            _record_error(cur, "crm_companies", company["id"], "buy_box", exc)
            errors += 1
    return {"companies": len(companies), "written": written, "skipped": skipped, "truncated": truncated,
            "errors": errors}


# ---------------------------------------------------------------------------
# The run
# ---------------------------------------------------------------------------
def count_lines(cur):
    cur.execute("select kind, ownership, count(*) as n from buyer_interest group by 1, 2 order by 1, 2")
    return {f"{row['kind']}:{row['ownership']}": row["n"] for row in cur.fetchall()}


def _batch(cur, name, payload_ids, work, apply_writes, dry_run=False):
    """One transaction per batch: applied batches commit, a dry run's batches roll back, so no lock outlives a batch."""
    _set_timeouts(cur)
    cur.execute("savepoint bi_batch")
    before = count_lines(cur)
    result = work(cur)
    after = count_lines(cur)
    result["batch"] = name
    result["lines_before"] = sum(before.values())
    result["lines_after"] = sum(after.values())
    if apply_writes:
        cur.execute("release savepoint bi_batch")
        cur.connection.commit()
    else:
        cur.execute("rollback to savepoint bi_batch")
        cur.connection.rollback()
    return result


def run(conn, apply_writes=False, batch_size=BATCH):
    """Every source batch, in order. Returns a summary of each batch and the line totals."""
    import psycopg2.extras
    summary = {"batches": [], "apply": bool(apply_writes)}
    dry_run = not apply_writes
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("select to_regclass('public.buyer_interest') as name")
        if not cur.fetchone()["name"]:
            raise SystemExit("buyer_interest does not exist: apply migration 112 first")
        summary["lines_at_start"] = count_lines(cur)
        conn.rollback()

        def batch(name, work):
            summary["batches"].append(_batch(cur, name, None, work, apply_writes, dry_run))

        for name, sql, work in (
            ("demand", "select id from crm_bulk_listings where kind = 'demand' order by id",
             lambda ids: (lambda c: sync_source_rows(c, "crm_bulk_listings", ids))),
            ("offer", "select id from crm_bulk_offers order by id",
             lambda ids: (lambda c: sync_source_rows(c, "crm_bulk_offers", ids))),
        ):
            ids = _ids(cur, sql)
            for n, chunk in enumerate(_in_batches(ids, batch_size), start=1):
                batch(f"{name}-{n}", work(chunk))

        rows = profile_rows(cur)
        for n, chunk in enumerate(_in_batches(rows, batch_size), start=1):
            batch(f"profile-{n}", lambda c, chunk=chunk: sync_profile_rows(c, chunk))

        searches = saved_search_rows(cur)
        batch("saved-search-1", lambda c: sync_saved_search_rows(c, searches))

        companies = dossier_rows(cur)
        batch("dossier-1", lambda c: sync_dossier_rows(c, companies))

        # Last, so the buy boxes that other batches just covered are already excluded.
        batch("buy-box-1", lambda c: sync_buy_box_rows(c, buy_box_rows(c)))

        # R4 across writers, last: a line a more specific line of the same source already says goes.
        summary["covered_removed"] = drop_covered_lines(cur)

        start_total = sum(summary["lines_at_start"].values())
        if dry_run:
            # Every batch was rolled back: the end is the start plus what each batch changed.
            summary["lines_at_end"] = start_total + sum(b["lines_after"] - b["lines_before"] for b in summary["batches"])
            summary["sync_errors"] = sum(b.get("errors", 0) for b in summary["batches"])
        else:
            summary["lines_at_end"] = sum(count_lines(cur).values())
            cur.execute("select count(*) as n from buyer_interest_sync_errors")
            summary["sync_errors"] = cur.fetchone()["n"]
            conn.commit()
        summary["lines_at_start"] = start_total
        summary["timeouts"] = sum(b.get("timeouts", 0) for b in summary["batches"])
    return summary


# ---------------------------------------------------------------------------
# Preview: what an approval would accept
# ---------------------------------------------------------------------------
def _md_table(headers, rows):
    out = ["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"]
    for row in rows:
        out.append("| " + " | ".join("" if value is None else str(value) for value in row) + " |")
    return "\n".join(out)


def preview(conn, source_note=""):
    """The approval preview, read from the database after the backfill."""
    import psycopg2.extras
    lines = ["# Buyer interest backfill: preview", ""]
    lines.append(f"Generated {dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%d %H:%M UTC')} from "
                 f"{source_note or 'the restored copy'}.")
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("select count(*) as n from buyer_interest")
        total = cur.fetchone()["n"]
        cur.execute("""select kind, ownership, count(*) as n from buyer_interest group by 1, 2 order by 1, 2""")
        by_kind = cur.fetchall()
        lines += ["", f"Total lines: {total}", "",
                  _md_table(["kind", "ownership", "lines"],
                            [(r["kind"], r["ownership"], r["n"]) for r in by_kind])]

        # Coverage against the buyer universe.
        cur.execute("""select count(*) filter (where buyer_profile is not null and buyer_profile <> '{}'::jsonb) as universe,
                              count(*) filter (where buyer_dossier is not null) as dossiers
                         from crm_companies""")
        universe = cur.fetchone()
        cur.execute("select count(distinct company_id) as covered from buyer_interest")
        covered = cur.fetchone()["covered"]
        cur.execute("""select count(distinct c.id) as n from crm_companies c
                        where c.buyer_profile is not null and c.buyer_profile <> '{}'::jsonb
                          and not exists (select 1 from buyer_interest b where b.company_id = c.id)""")
        uncovered = cur.fetchone()["n"]
        lines += ["", "## Coverage", "",
                  _md_table(["measure", "value"], [
                      ("Companies with a buy box", universe["universe"]),
                      ("Companies with a buyer dossier", universe["dossiers"]),
                      ("Companies with at least one line", covered),
                      ("Buy box companies with no line", uncovered)])]

        cur.execute("""select n, count(*) as companies from (
                         select company_id, count(*) as n from buyer_interest group by 1) lines
                       group by 1 order by 1""")
        dist = cur.fetchall()
        lines += ["", "## Lines per company", "",
                  _md_table(["lines", "companies"], [(r["n"], r["companies"]) for r in dist])]

        cur.execute("""select product_key_level as level, count(*) as n from buyer_interest group by 1
                        order by 2 desc""")
        levels = cur.fetchall()
        lines += ["", "## Product key level", "",
                  _md_table(["level", "lines"], [(r["level"] or "unset", r["n"]) for r in levels])]

        cur.execute("select count(*) as n from buyer_interest_sync_errors")
        errors = cur.fetchone()["n"]
        cur.execute("""select source_table, operation, message, count(*) as n from buyer_interest_sync_errors
                        group by 1, 2, 3 order by 4 desc limit 20""")
        samples = cur.fetchall()
        lines += ["", "## Sync errors and truncations", "", f"Rows in buyer_interest_sync_errors: {errors}"]
        if samples:
            lines += ["", _md_table(["source", "operation", "message", "count"],
                                    [(r["source_table"], r["operation"], (r["message"] or "")[:120], r["n"])
                                     for r in samples])]

        cur.execute("""select source_table, source_id, message from buyer_interest_sync_errors
                        where operation = 'truncated' order by source_table, source_id limit 50""")
        truncated = cur.fetchall()
        lines += ["", f"Sources truncated at the 12-line cap: {len(truncated)}"]
        if truncated:
            lines += ["", _md_table(["source", "id", "message"],
                                    [(r["source_table"], r["source_id"], r["message"]) for r in truncated])]

        # The pilot buyers, in full.
        cur.execute("""select id, name from crm_companies where buyer_dossier is not null order by name""")
        pilots = cur.fetchall()
        lines += ["", "## Pilot buyers", ""]
        for company in pilots:
            cur.execute("""select kind, product_key, quantity, quantity_unit, price, price_basis, first_seen,
                                  last_seen, expires_on, coalesce(demand_id, offer_id, saved_search_id) as source_id,
                                  source_refs
                             from buyer_interest where company_id = %s
                            order by kind, product_key""", (company["id"],))
            rows = cur.fetchall()
            lines += [f"### {company['name']} ({len(rows)} lines)", ""]
            lines.append(_md_table(
                ["kind", "key", "qty", "price", "first", "last", "expires", "source", "refs"],
                [(r["kind"], r["product_key"], _num(r["quantity"], r["quantity_unit"]), _num(r["price"], r["price_basis"]),
                  r["first_seen"], r["last_seen"], r["expires_on"], r["source_id"] or "dossier",
                  ", ".join(r["source_refs"] or [])[:80]) for r in rows]))
            lines.append("")

        # A stable random sample of everyone else.
        cur.execute("""select c.id, c.name, count(b.id) as n from crm_companies c join buyer_interest b
                         on b.company_id = c.id where c.buyer_dossier is null
                        group by 1, 2 order by md5(c.id || 'backfill-preview') limit 10""")
        others = cur.fetchall()
        lines += ["", "## Ten other companies", ""]
        for company in others:
            cur.execute("""select kind, product_key, quantity, quantity_unit, price, price_basis, first_seen, last_seen,
                                  coalesce(demand_id, offer_id, saved_search_id) as source_id, source_refs
                             from buyer_interest where company_id = %s order by kind, product_key""",
                        (company["id"],))
            rows = cur.fetchall()
            lines += [f"### {company['name']} ({len(rows)} lines)", ""]
            lines.append(_md_table(
                ["kind", "key", "qty", "price", "first", "last", "source", "refs"],
                [(r["kind"], r["product_key"], _num(r["quantity"], r["quantity_unit"]), _num(r["price"], r["price_basis"]),
                  r["first_seen"], r["last_seen"], r["source_id"] or "dossier",
                  ", ".join(r["source_refs"] or [])[:60]) for r in rows]))
            lines.append("")

        # What a person should look at before approving.
        cur.execute("""select count(*) as n from buyer_interest
                        where product_key = 'broad:any-batteries' or product_key_level is null""")
        no_facts = cur.fetchone()["n"]
        cur.execute("""select company_id, product_key, kind, count(*) as n from buyer_interest
                        group by 1, 2, 3 having count(*) > 1 order by 4 desc limit 20""")
        duplicates = cur.fetchall()
        cur.execute("""select company_id, count(*) as n from buyer_interest group by 1 having count(*) >= 12
                        order by 2 desc limit 20""")
        busy = cur.fetchall()
        cur.execute("""select count(*) as n from buyer_interest where price is not null and price_currency is null""")
        no_currency = cur.fetchone()["n"]
        cur.execute("""select count(*) as n from buyer_interest
                        where quantity is not null and quantity_unit is null""")
        no_unit = cur.fetchone()["n"]
        cur.execute("""select count(*) filter (where expires_on is null) as none,
                              count(*) filter (where expires_on < current_date) as past
                         from buyer_interest""")
        expiry = cur.fetchone()
        lines += ["", "## Worth a look", "",
                  _md_table(["check", "value"], [
                      ("Lines with no product facts (broad:any-batteries or no level)", no_facts),
                      ("Lines priced with no currency", no_currency),
                      ("Lines with a quantity but no unit", no_unit),
                      ("Lines with no expiry (bought, declined, open asks)", expiry["none"]),
                      ("Lines past their expiry (lapsed asks kept as history)", expiry["past"])])]
        if duplicates:
            lines += ["", "Same company, key and kind from more than one source row: " + str(len(duplicates)), "",
                      "Asks, purchases and declines are one row per event, so a repeat is expected there. "
                      "A repeat in a mastered kind would mean two writers disagree.", "",
                      _md_table(["company", "key", "kind", "rows"],
                                [(r["company_id"], r["product_key"], r["kind"], r["n"]) for r in duplicates])]
        if busy:
            lines += ["", "Companies at or above 12 lines: " + str(len(busy)), "",
                      _md_table(["company", "lines"], [(r["company_id"], r["n"]) for r in busy])]
    return "\n".join(lines) + "\n"


def _num(value, unit=None):
    if value is None:
        return ""
    text = f"{float(value):g}"
    return f"{text} {unit}" if unit else text


# ---------------------------------------------------------------------------
def main(argv=None):
    parser = argparse.ArgumentParser(description="Backfill buyer_interest from the existing demand rows, offers, "
                                                 "profiles, saved searches and pilot dossiers (foundation step 1b).")
    parser.add_argument("--dsn", help="connection string (required with --apply)")
    parser.add_argument("--apply", action="store_true", help="write; without it every batch is rolled back")
    parser.add_argument("--i-have-approval", action="store_true",
                        help="allow a run (dry or apply) against the production database")
    parser.add_argument("--batch-size", type=int, default=BATCH)
    parser.add_argument("--preview", help="write the approval preview markdown to this path; writes nothing")
    args = parser.parse_args(argv)

    dsn = args.dsn or DEFAULT_DSN
    production = is_production_dsn(dsn)
    if args.apply and not args.dsn:
        parser.error("--apply needs an explicit --dsn")
    if production and not args.i_have_approval:
        parser.error("refusing to run against the production database (even a dry run holds locks); "
                     "pass --i-have-approval to override")
    if args.apply and args.preview:
        parser.error("--preview writes nothing; run it without --apply")

    import psycopg2
    import psycopg2.extras
    params = _dsn_params(dsn)
    conn = psycopg2.connect(dsn)
    conn.autocommit = False
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("select current_database() as db")
        where = cur.fetchone() or {"db": params.get("dbname") or "denchclaw"}
    conn.rollback()
    target = f"{params.get('host') or params.get('hostaddr') or 'local socket'}:{params.get('port') or '5432'}"

    print(f"database {where['db']} via {target}"
          f"{' (PRODUCTION)' if production else ''}: {'apply' if args.apply else 'dry run'}")
    why = refusal_for_database(where["db"], args.i_have_approval)
    if why:
        conn.close()
        parser.error(why)
    try:
        summary = run(conn, apply_writes=args.apply, batch_size=args.batch_size)
        for batch in summary["batches"]:
            print(f"  {batch['batch']:<14} {json.dumps({k: v for k, v in batch.items() if k != 'batch'})}")
        print(f"lines at start {summary['lines_at_start']} -> at end {summary['lines_at_end']}")
        print(f"sync errors {'in this dry run' if not args.apply else 'recorded'}: {summary['sync_errors']}")
        print(f"rows that hit a lock or statement timeout twice (recorded as backfill_timeout): {summary['timeouts']}")
        if args.preview:
            text = preview(conn, source_note=f"database {where['db']} on {target}")
            Path(args.preview).write_text(text, encoding="utf-8")
            print(f"preview written to {args.preview}")
    finally:
        conn.rollback()
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
