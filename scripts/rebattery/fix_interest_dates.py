#!/usr/bin/env python3
"""Correct the dates on buyer_interest lines (foundation step 1c-0).

Lines the backfill wrote can carry the day they were made instead of the day the buyer was actually seen. This
script moves them back to the real source date and recomputes the expiry from it, with the kind rules of
apps/web/lib/crm-postgres/buyer-interest.ts (standing 90 days, interest 180, inferred 180).

Which lines: every mastered line of kind inferred, and any standing or interest line whose first_seen equals the day it
was created while an older source date exists.

The real source date, first one found (inferred lines are matched through their source_refs and demand_id):
  1. the source demand row's observed_on (crm_bulk_listings kind demand, found by demand_id, a crm:<id> ref, or a
     ref equal to the row's source_id);
  2. else the company's earliest crm_buyer_profile_changes date for the field buyer_profile;
  3. else crm_companies.buyer_profiled_at.
Only inferred lines (a copy of the buy box) use steps 2 and 3; a standing or interest line moves only to its own
source row's date. A line only ever moves earlier: the new first_seen is never later than the current one. For an inferred line
last_seen becomes the same date (it was seen once); for a standing or interest line last_seen moves only when it
equalled the old first_seen. expires_on is recomputed from the new last_seen for inferred lines, and for the other
kinds only when it was the default derived from the old last_seen (an expiry someone chose is kept).

Writes only buyer_interest (first_seen, last_seen, expires_on, updated_at). Dry run by default: it reads and plans in a
read-only transaction and writes nothing. --apply needs an explicit --dsn and writes 200 lines per transaction with
lock_timeout 3s and statement_timeout 60s. Any run against a connection whose current_database() is denchclaw needs
--i-have-approval. Re-running is safe: a corrected line has nothing older to move to.

  fix_interest_dates.py --dsn <dsn> [--preview FILE.md]
  fix_interest_dates.py --dsn <dsn> --apply
"""
import argparse
import collections
import datetime as dt
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# The guards are the backfill's, so the two scripts can never disagree on what production is.
from backfill_buyer_interest import (  # noqa: E402
    DEFAULT_DSN, _dsn_params, is_production_dsn, refusal_for_database)

# Mirrors DEFAULT_EXPIRY_DAYS in apps/web/lib/crm-postgres/buyer-interest.ts.
EXPIRY_DAYS = {"standing": 90, "interest": 180, "inferred": 180}
BATCH = 200
LOCK_TIMEOUT = "3s"
STATEMENT_TIMEOUT = "60s"

# One row per mastered line with every candidate source date next to it. Dates are London days, like todayInLondon().
CANDIDATES_SQL = """
select i.id, i.company_id, i.kind, i.first_seen, i.last_seen, i.expires_on,
       (i.created_at at time zone 'Europe/London')::date as created_on,
       demand.observed_on as demand_date, demand.ref as demand_ref,
       (select min((ch.changed_at at time zone 'Europe/London')::date)
          from crm_buyer_profile_changes ch where ch.company_id = i.company_id and ch.field = 'buyer_profile') as change_date,
       c.buyer_profiled_at as profiled_date
  from buyer_interest i
  left join crm_companies c on c.id = i.company_id
  left join lateral (
    select min(d.observed_on) as observed_on, min(d.id) as ref
      from crm_bulk_listings d
     where d.kind = 'demand' and d.observed_on is not null
       and (d.id = i.demand_id
            or d.id = any(select regexp_replace(r, '^crm:', '') from unnest(i.source_refs) r where r like 'crm:%%')
            or d.source_id = any(i.source_refs))
  ) demand on true
 where i.ownership = 'mastered'
 order by i.id
"""


def plus_days(day, days):
    return day + dt.timedelta(days=days)


def plan_line(row):
    """What one line becomes: (update dict or None, reason). Pure, so the tests can call it without a database."""
    kind = row["kind"]
    first, last, expires = row["first_seen"], row["last_seen"], row["expires_on"]
    if kind not in EXPIRY_DAYS:
        return None, "not a mastered kind"
    if kind != "inferred" and first != row["created_on"]:
        return None, "first_seen is already not the creation day"
    if row["demand_date"] is not None:
        source, found = "demand observed_on", row["demand_date"]
    elif kind != "inferred":
        return None, "no source date found"  # the company-level dates describe its buy box, not a stated want
    elif row["change_date"] is not None:
        source, found = "earliest buyer_profile change", row["change_date"]
    elif row["profiled_date"] is not None:
        source, found = "buyer_profiled_at", row["profiled_date"]
    else:
        return None, "no source date found"
    if found >= first:
        return None, f"no older date (source {source}: not before first_seen)"
    new_first = found
    if kind == "inferred":
        new_last = new_first
    elif last == first:
        new_last = new_first
    else:
        new_last = max(last, new_first)
    days = EXPIRY_DAYS[kind]
    if kind == "inferred" or expires is None or expires == plus_days(last, days):
        new_expires = plus_days(new_last, days)
    else:
        new_expires = expires
    return {"id": row["id"], "kind": kind, "company_id": row["company_id"], "source": source,
            "old_first": first, "new_first": new_first, "old_last": last, "new_last": new_last,
            "old_expires": expires, "new_expires": new_expires}, "moves"


def month(day):
    return day.strftime("%Y-%m")


def build_plan(rows, today):
    """Plan every candidate line and summarise before and after."""
    updates, untouched = [], []
    for row in rows:
        update, reason = plan_line(row)
        if update:
            updates.append(update)
        else:
            untouched.append({"id": row["id"], "kind": row["kind"], "company_id": row["company_id"],
                              "first_seen": row["first_seen"], "reason": reason})
    by_kind = collections.Counter(row["kind"] for row in rows)
    moved_by_kind = collections.Counter(u["kind"] for u in updates)
    before_months = collections.Counter(month(row["first_seen"]) for row in rows)
    moved_ids = {u["id"]: u for u in updates}
    after_months = collections.Counter(month(moved_ids[row["id"]]["new_first"] if row["id"] in moved_ids else row["first_seen"])
                                       for row in rows)
    became_expired = collections.Counter()
    expired_before, expired_after = collections.Counter(), collections.Counter()
    for row in rows:
        update = moved_ids.get(row["id"])
        was = row["expires_on"] is not None and row["expires_on"] <= today
        now_expires = update["new_expires"] if update else row["expires_on"]
        now = now_expires is not None and now_expires <= today
        expired_before[row["kind"]] += was
        expired_after[row["kind"]] += now
        if now and not was:
            became_expired[row["kind"]] += 1
    ages = sorted((u["old_first"] - u["new_first"]).days for u in updates)
    return {"lines": len(rows), "by_kind": dict(by_kind), "moved": len(updates), "moved_by_kind": dict(moved_by_kind),
            "months_before": dict(sorted(before_months.items())), "months_after": dict(sorted(after_months.items())),
            "expired_before": dict(expired_before), "expired_after": dict(expired_after),
            "became_expired": dict(became_expired),
            "age_days": {"min": ages[0], "median": ages[len(ages) // 2], "max": ages[-1]} if ages else None,
            "updates": updates, "untouched": untouched,
            "untouched_reasons": dict(collections.Counter(u["reason"] for u in untouched))}


def fetch_candidates(conn):
    import psycopg2.extras
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(CANDIDATES_SQL)
        return cur.fetchall()


def london_today(conn):
    with conn.cursor() as cur:
        cur.execute("select (now() at time zone 'Europe/London')::date")
        return cur.fetchone()[0]


def apply_updates(conn, updates, batch_size=BATCH):
    """One transaction per batch. A line changed since it was read (first_seen or last_seen differs) is skipped."""
    written, skipped = 0, 0
    for start in range(0, len(updates), batch_size):
        with conn.cursor() as cur:
            cur.execute(f"set local lock_timeout = '{LOCK_TIMEOUT}'")
            cur.execute(f"set local statement_timeout = '{STATEMENT_TIMEOUT}'")
            for u in updates[start:start + batch_size]:
                cur.execute("""update buyer_interest
                                  set first_seen = %s, last_seen = %s, expires_on = %s, updated_at = now()
                                where id = %s and first_seen = %s and last_seen = %s and ownership = 'mastered'""",
                            (u["new_first"], u["new_last"], u["new_expires"], u["id"], u["old_first"], u["old_last"]))
                if cur.rowcount == 1:
                    written += 1
                else:
                    skipped += 1
        conn.commit()
        print(f"  batch {start // batch_size + 1}: {min(start + batch_size, len(updates))}/{len(updates)} lines")
    return written, skipped


def read_back(conn, updates):
    """The corrected lines as stored now; any mismatch is reported."""
    import psycopg2.extras
    wrong = []
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("select id, first_seen, last_seen, expires_on from buyer_interest where id = any(%s)",
                    ([u["id"] for u in updates],))
        stored = {r["id"]: r for r in cur.fetchall()}
    conn.rollback()
    for u in updates:
        got = stored.get(u["id"])
        if not got or (got["first_seen"], got["last_seen"], got["expires_on"]) != (u["new_first"], u["new_last"], u["new_expires"]):
            wrong.append(u["id"])
    return wrong


def md_table(headers, rows):
    out = ["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"]
    out += ["| " + " | ".join(str(cell) for cell in row) + " |" for row in rows]
    return "\n".join(out)


def preview_text(plan, today, source_note, applied=None):
    kinds = sorted(plan["by_kind"])
    lines = ["# buyer_interest date correction: preview", "",
             f"Generated {dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%d %H:%M UTC')} from {source_note}. "
             f"Expiry is judged as of {today}.", ""]
    if applied is not None:
        lines += [f"Applied on this copy: {applied['written']} lines written, {applied['skipped']} skipped, "
                  f"read-back mismatches {applied['mismatches']}.", ""]
    lines += [f"Lines examined (all mastered lines): {plan['lines']}. Lines that move: **{plan['moved']}**.", ""]
    lines += [md_table(["kind", "examined", "moved", "expired before", "expired after", "newly expired"],
                       [[k, plan["by_kind"][k], plan["moved_by_kind"].get(k, 0), plan["expired_before"].get(k, 0),
                         plan["expired_after"].get(k, 0), plan["became_expired"].get(k, 0)] for k in kinds]), ""]
    if plan["age_days"]:
        a = plan["age_days"]
        lines += [f"How far lines move back: median {a['median']} days, min {a['min']}, max {a['max']}.", ""]
    months = sorted(set(plan["months_before"]) | set(plan["months_after"]))
    lines += ["## first_seen by month (mastered lines)", "",
              md_table(["month", "before", "after"], [[m, plan["months_before"].get(m, 0), plan["months_after"].get(m, 0)] for m in months]), ""]
    lines += ["## Sample lines that move", ""]
    if plan["updates"]:
        step = max(1, len(plan["updates"]) // 10)
        sample = plan["updates"][::step][:10]
        lines += [md_table(["line", "kind", "first_seen old -> new", "last_seen old -> new", "expires old -> new", "source"],
                           [[u["id"], u["kind"], f"{u['old_first']} -> {u['new_first']}", f"{u['old_last']} -> {u['new_last']}",
                             f"{u['old_expires']} -> {u['new_expires']}", u["source"]] for u in sample]), ""]
    else:
        lines += ["None: no line has an older source date than its current first_seen.", ""]
    lines += ["## Lines where no older date was found", "",
              md_table(["reason", "lines"], sorted(plan["untouched_reasons"].items(), key=lambda kv: -kv[1])), "",
              "Lines listed as no older date already carry their source date: a research line's first_seen equals its "
              "demand row's observed_on. A demand row's observed_on is the date of the research batch, so lines from "
              "one batch share one date.", ""]
    return "\n".join(lines)


def print_summary(plan):
    print(f"lines examined {plan['lines']} {plan['by_kind']}")
    print(f"lines that move {plan['moved']} {plan['moved_by_kind']}")
    print(f"first_seen by month before {plan['months_before']}")
    print(f"first_seen by month after  {plan['months_after']}")
    print(f"expired before {plan['expired_before']} after {plan['expired_after']} newly expired {plan['became_expired']}")
    print(f"not moved: {plan['untouched_reasons']}")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Correct buyer_interest first_seen/last_seen to the real source date.")
    parser.add_argument("--dsn", help="connection string (required with --apply)")
    parser.add_argument("--apply", action="store_true", help="write; without it nothing is written")
    parser.add_argument("--i-have-approval", action="store_true", help="allow a run against the production database")
    parser.add_argument("--batch-size", type=int, default=BATCH)
    parser.add_argument("--today", help="judge expiry as of this date (default: today in London)")
    parser.add_argument("--preview", help="write the before/after preview markdown to this path")
    args = parser.parse_args(argv)

    dsn = args.dsn or DEFAULT_DSN
    production = is_production_dsn(dsn)
    if args.apply and not args.dsn:
        parser.error("--apply needs an explicit --dsn")
    if production and not args.i_have_approval:
        parser.error("refusing to run against the production database; pass --i-have-approval to override")

    import psycopg2
    params = _dsn_params(dsn)
    conn = psycopg2.connect(dsn)
    conn.autocommit = False
    with conn.cursor() as cur:
        cur.execute("select current_database()")
        db = cur.fetchone()[0]
    conn.rollback()
    target = f"{params.get('host') or params.get('hostaddr') or 'local socket'}:{params.get('port') or '5432'}"
    print(f"database {db} via {target}{' (PRODUCTION)' if production else ''}: {'apply' if args.apply else 'dry run'}")
    why = refusal_for_database(db, args.i_have_approval)
    if why:
        conn.close()
        parser.error(why)
    try:
        with conn.cursor() as cur:
            cur.execute("set transaction read only")
            cur.execute(f"set local statement_timeout = '{STATEMENT_TIMEOUT}'")
            cur.execute(f"set local lock_timeout = '{LOCK_TIMEOUT}'")
        today = dt.date.fromisoformat(args.today) if args.today else london_today(conn)
        plan = build_plan(fetch_candidates(conn), today)
        conn.rollback()
        print_summary(plan)
        applied = None
        if args.apply and plan["updates"]:
            written, skipped = apply_updates(conn, plan["updates"], args.batch_size)
            mismatches = read_back(conn, plan["updates"])
            applied = {"written": written, "skipped": skipped, "mismatches": len(mismatches)}
            print(f"applied: written {written}, skipped {skipped}, read-back mismatches {len(mismatches)}")
            if mismatches:
                return 1
        elif not args.apply:
            print("dry run: nothing written")
        if args.preview:
            Path(args.preview).write_text(preview_text(plan, today, f"database {db} on {target}", applied), encoding="utf-8")
            print(f"preview written to {args.preview}")
    finally:
        conn.rollback()
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
