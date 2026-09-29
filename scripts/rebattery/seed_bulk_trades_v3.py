#!/usr/bin/env python3
"""Set up the Iveco eBS37 and Oklahoma trades for Bulk Trades v3 after migration 008.

Dry run by default: prints what it would do and writes nothing. An existing lot is
reused rather than duplicated; only empty v3 fields are filled, so hand edits survive.
Run with --apply only after Alex approves the dry-run output.
"""
from __future__ import annotations

import argparse
import json
import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

# Values from Alex's email and Granola as of 28 Sep 2026, per the design brief.
TRADES = [
    {
        "key": "ebs37",
        "match": ["%eBS37%"],
        "title": "Iveco FPT eBS37",
        "trade_stage": "With buyers",
        "trade_kind": "packs",
        "fact_line": "161 packs + 9 incomplete · NMC · 36.9 kWh · clear warehouse by mid-Nov",
        "value": "€119–149k",
        "next_step": "Follow up Fabio: share auction interest and ask for the 5 missing items",
        "waiting_on": "us",
    },
    {
        "key": "oklahoma",
        "match": ["%Oklahoma%", "%LG Chem%"],
        "title": "Oklahoma LG Chem cells",
        "trade_stage": "Closing",
        "trade_kind": "cells",
        "fact_line": "WHS Energy → Ashish · LC received",
        "value": "$500–600k",
        "next_step": "Send letter of credit to supplier, then inspect",
        "waiting_on": "us",
    },
]

V3_FIELDS = ["trade_stage", "trade_kind", "fact_line", "value", "next_step", "next_step_due", "waiting_on"]
# Column defaults from migration 008 count as empty.
DEFAULTS = {"trade_stage": "Needs info", "waiting_on": "us"}


def plan_trade(cursor, spec: dict, lot_override: str | None, due: str) -> dict:
    wanted = {field: spec[field] for field in V3_FIELDS if field in spec}
    wanted["next_step_due"] = due

    if lot_override:
        cursor.execute("select id, title from crm_bulk_trade_lots where id = %s", (lot_override,))
        matches = cursor.fetchall()
        if not matches:
            return {"key": spec["key"], "action": "error", "reason": f"lot {lot_override} not found"}
    else:
        clauses = " or ".join(["title ilike %s"] * len(spec["match"]))
        cursor.execute(f"select id, title from crm_bulk_trade_lots where {clauses} order by title", spec["match"])
        matches = cursor.fetchall()

    if len(matches) > 1:
        return {
            "key": spec["key"],
            "action": "ambiguous",
            "candidates": [{"id": row[0], "title": row[1]} for row in matches],
            "reason": f"pass --lot {spec['key']}=<id> to choose one",
        }
    if not matches:
        return {"key": spec["key"], "action": "create", "title": spec["title"], "fields": wanted}

    lot_id, title = matches[0]
    cursor.execute(f"select {', '.join(V3_FIELDS)} from crm_bulk_trade_lots where id = %s", (lot_id,))
    current = dict(zip(V3_FIELDS, cursor.fetchone()))
    fill = {
        field: value for field, value in wanted.items()
        if str(current[field]) != value and (current[field] is None or current[field] == DEFAULTS.get(field))
    }
    if current["trade_stage"] != DEFAULTS["trade_stage"]:
        fill.pop("trade_stage", None)
    kept = {field: str(current[field]) for field in wanted if field not in fill}
    return {"key": spec["key"], "action": "update", "lot_id": lot_id, "title": title, "fill": fill, "kept": kept}


def apply_plan(cursor, plan: dict, actor_id: str | None) -> None:
    if plan["action"] == "create":
        lot_id = f"bt_{uuid.uuid4()}"
        fields = {"title": plan["title"], **plan["fields"]}
        columns = ", ".join(fields)
        cursor.execute(
            f"""insert into crm_bulk_trade_lots (id, lot_kind, summary, observed_outcome, confidence, {columns})
                values (%s, 'supply', '', '', 'confirmed', {', '.join(['%s'] * len(fields))})""",
            [lot_id, *fields.values()],
        )
        cursor.execute(
            "insert into crm_bulk_trade_events (lot_id, kind, changes, actor_user_id) values (%s, 'trade_created', %s, %s)",
            (lot_id, json.dumps(fields, ensure_ascii=False), actor_id),
        )
        plan["lot_id"] = lot_id
    elif plan["action"] == "update" and plan["fill"]:
        cursor.execute("select " + ", ".join(plan["fill"]) + " from crm_bulk_trade_lots where id = %s", (plan["lot_id"],))
        before = dict(zip(plan["fill"], cursor.fetchone()))
        assignments = ", ".join(f"{field} = %s" for field in plan["fill"])
        cursor.execute(
            f"update crm_bulk_trade_lots set {assignments}, updated_at = now() where id = %s",
            [*plan["fill"].values(), plan["lot_id"]],
        )
        changes = {field: [None if before[field] is None else str(before[field]), value] for field, value in plan["fill"].items()}
        cursor.execute(
            "insert into crm_bulk_trade_events (lot_id, kind, changes, actor_user_id) values (%s, 'trade_updated', %s, %s)",
            (plan["lot_id"], json.dumps(changes, ensure_ascii=False), actor_id),
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="write the changes (default is a dry run)")
    parser.add_argument("--dsn", default="host=/var/run/postgresql dbname=denchclaw")
    parser.add_argument("--actor-email", default="alex@rebattery.io", help="CRM user recorded in the change log")
    parser.add_argument("--due", default=datetime.now(ZoneInfo("Europe/London")).date().isoformat(),
                        help="next step due date, YYYY-MM-DD (default: today in the UK)")
    parser.add_argument("--lot", action="append", default=[], metavar="KEY=LOT_ID",
                        help="use this existing lot for ebs37 or oklahoma")
    args = parser.parse_args()
    overrides = dict(item.split("=", 1) for item in args.lot)

    import psycopg2

    connection = psycopg2.connect(args.dsn)
    try:
        with connection:
            with connection.cursor() as cursor:
                cursor.execute("select id from crm_users where lower(email) = lower(%s)", (args.actor_email,))
                actor = cursor.fetchone()
                plans = [plan_trade(cursor, spec, overrides.get(spec["key"]), args.due) for spec in TRADES]
                blocked = [plan for plan in plans if plan["action"] in ("ambiguous", "error")]
                if args.apply and not blocked:
                    for plan in plans:
                        apply_plan(cursor, plan, actor[0] if actor else None)
                else:
                    connection.rollback()
    finally:
        connection.close()

    print(json.dumps({
        "mode": "applied" if args.apply and not blocked else "dry run",
        "actor": args.actor_email if actor else f"{args.actor_email} (not found; events have no actor)",
        "trades": plans,
    }, indent=2, ensure_ascii=False, default=str))
    if blocked:
        raise SystemExit("Nothing written: resolve the ambiguous or missing lots first.")


if __name__ == "__main__":
    main()
