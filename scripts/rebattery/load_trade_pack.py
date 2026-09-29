#!/usr/bin/env python3
"""Load a Bulk Trades v3 data pack into one trade: trade fields, contacts, buyers with bids,
per-field data with sources, and files.

Dry run by default: prints what it would add and writes nothing. It only fills what is empty and
adds rows that are not there yet (contacts and buyers by name, files by file name), so hand edits
in the app survive a re-run. Every write gets its crm_bulk_trade_events row, as the app does.

  load_trade_pack.py pack.json                      # dry run
  load_trade_pack.py pack.json --apply --files-dir "$BULK_TRADE_FILES_DIR"

Run --apply only after the dry-run output is approved. Packs hold production data: keep them
outside git.
"""

import argparse
import json
import shutil
import sys
import uuid
from pathlib import Path

import psycopg2
import psycopg2.extras

TRADE_TEXT = ["title", "trade_stage", "trade_kind", "fact_line", "next_step", "value", "transport_class", "listing_id"]
TRADE_DATES = ["next_step_due", "clear_by", "ship_by"]
TRADE_KEEP_IF_SET = TRADE_TEXT + TRADE_DATES + ["tfs_needed", "waiting_on"]
FIELD_KEYS = ["value", "status", "visibility", "source_label", "source_url", "source_date", "alternatives"]


def log(cur, lot_id, kind, changes, actor, buyer_id=None):
    cur.execute(
        "insert into crm_bulk_trade_events (lot_id, kind, changes, actor_user_id, buyer_id) values (%s, %s, %s, %s, %s)",
        (lot_id, kind, json.dumps(changes, default=str), actor, buyer_id),
    )


def default_for(column):
    return {"waiting_on": "us", "tfs_needed": "unknown", "trade_stage": "Needs info"}.get(column)


def plan(cur, pack):
    lot_id = pack["lot_id"]
    cur.execute("select * from crm_bulk_trade_lots where id = %s", (lot_id,))
    lot = cur.fetchone()
    if not lot:
        raise SystemExit(f"No trade {lot_id}")

    out = {"lot_id": lot_id, "title": lot["title"], "trade": {}, "kept": {}, "contacts": [], "buyers": [], "fields": [], "files": []}
    for column, value in pack.get("trade", {}).items():
        if column not in TRADE_KEEP_IF_SET:
            raise SystemExit(f"Unknown trade column {column}")
        current = lot[column]
        current = current.isoformat() if hasattr(current, "isoformat") else current
        # Fill empty or still-default values; "title" and "rename" are explicit overrides.
        if current in (None, "", default_for(column)) or column in pack.get("override", []):
            if current != value:
                out["trade"][column] = [current, value]
        elif current != value:
            out["kept"][column] = current

    cur.execute("select lower(name) as name from crm_bulk_trade_contacts where lot_id = %s", (lot_id,))
    have = {row["name"] for row in cur.fetchall()}
    out["contacts"] = [c for c in pack.get("contacts", []) if c["name"].lower() not in have]

    cur.execute("select lower(name) as name from crm_bulk_trade_buyers where lot_id = %s", (lot_id,))
    have = {row["name"] for row in cur.fetchall()}
    out["buyers"] = [b for b in pack.get("buyers", []) if b["name"].lower() not in have]

    cur.execute("select field_key from crm_bulk_trade_fields where lot_id = %s", (lot_id,))
    have = {row["field_key"] for row in cur.fetchall()}
    out["fields"] = [dict(key=k, **v) for k, v in pack.get("fields", {}).items() if k not in have]

    cur.execute("select lower(file_name) as name from crm_bulk_trade_files where lot_id = %s", (lot_id,))
    have = {row["name"] for row in cur.fetchall()}
    for f in pack.get("files", []):
        if f["file_name"].lower() in have:
            continue
        path = Path(f["path"])
        if not path.is_file():
            raise SystemExit(f"Missing file {path}")
        out["files"].append({**f, "byte_size": path.stat().st_size})
    return out


def apply(cur, out, actor, files_dir):
    lot_id = out["lot_id"]
    if out["trade"]:
        sets = ", ".join(f"{column} = %s" for column in out["trade"])
        cur.execute(f"update crm_bulk_trade_lots set {sets}, updated_at = now() where id = %s",
                    [after for _, after in out["trade"].values()] + [lot_id])
        log(cur, lot_id, "trade_updated", out["trade"], actor)

    cur.execute("select coalesce(max(sort_order), -1) + 1 as next from crm_bulk_trade_contacts where lot_id = %s", (lot_id,))
    order = cur.fetchone()["next"]
    for c in out["contacts"]:
        row = {"id": f"btc_{uuid.uuid4()}", "name": c["name"], "company": c.get("company"),
               "email": c.get("email"), "phone": c.get("phone")}
        cur.execute("insert into crm_bulk_trade_contacts (id, lot_id, name, company, email, phone, sort_order) "
                    "values (%(id)s, %(lot)s, %(name)s, %(company)s, %(email)s, %(phone)s, %(order)s)",
                    {**row, "lot": lot_id, "order": order})
        order += 1
        log(cur, lot_id, "contact_added", row, actor)

    for b in out["buyers"]:
        buyer_id = f"btb_{uuid.uuid4()}"
        row = {k: b.get(k) for k in ["name", "person_id", "contact", "wants", "status", "last_touch_on", "last_touch_via", "chase_on"]}
        row["status"] = row["status"] or "To contact"
        cur.execute("insert into crm_bulk_trade_buyers (id, lot_id, name, person_id, contact, wants, status, "
                    "last_touch_on, last_touch_via, chase_on) values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                    [buyer_id, lot_id] + list(row.values()))
        log(cur, lot_id, "buyer_added", {k: v for k, v in row.items() if v is not None}, actor, buyer_id)
        for bid in b.get("bids", []):
            cur.execute("insert into crm_bulk_trade_bids (lot_id, buyer_id, amount, unit, currency, firmness, "
                        "delivery_terms, payment_terms, expires_on, actor_user_id) "
                        "values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                        (lot_id, buyer_id, bid["amount"], bid["unit"], bid["currency"], bid["firmness"],
                         bid.get("delivery_terms"), bid.get("payment_terms"), bid.get("expires_on"), actor))
            log(cur, lot_id, "bid_added", bid, actor, buyer_id)

    for f in out["fields"]:
        row = {k: f.get(k) for k in FIELD_KEYS}
        row["alternatives"] = json.dumps(row["alternatives"] or [])
        cur.execute("insert into crm_bulk_trade_fields (lot_id, field_key, value, status, visibility, source_label, "
                    "source_url, source_date, alternatives) values (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
                    [lot_id, f["key"]] + list(row.values()))
        log(cur, lot_id, "field_updated", {"field": f["key"], **{k: [None, v] for k, v in f.items() if k != "key" and v is not None}}, actor)

    for f in out["files"]:
        file_id = f"btf_{uuid.uuid4()}"
        target = Path(files_dir) / file_id
        shutil.copyfile(f["path"], target)
        target.chmod(0o600)
        cur.execute("insert into crm_bulk_trade_files (id, lot_id, file_name, file_type, content_type, byte_size, "
                    "storage_key, source_label, source_date, visibility, uploaded_by) "
                    "values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                    (file_id, lot_id, f["file_name"], f["file_type"], f.get("content_type"), f["byte_size"], file_id,
                     f.get("source_label"), f.get("source_date"), f.get("visibility", "never"), actor))
        log(cur, lot_id, "file_added", {"id": file_id, "file_name": f["file_name"], "file_type": f["file_type"],
                                        "byte_size": f["byte_size"], "visibility": f.get("visibility", "never"),
                                        "source_label": f.get("source_label"), "source_date": f.get("source_date")}, actor)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("pack")
    parser.add_argument("--apply", action="store_true", help="write the changes (default is a dry run)")
    parser.add_argument("--dsn", default="host=/var/run/postgresql dbname=denchclaw")
    parser.add_argument("--actor-email", default="alex@rebattery.io", help="CRM user recorded in the change log")
    parser.add_argument("--files-dir", help="BULK_TRADE_FILES_DIR of the running app; required to add files")
    args = parser.parse_args()

    pack = json.loads(Path(args.pack).read_text())
    connection = psycopg2.connect(args.dsn)
    try:
        with connection, connection.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("select id from crm_users where lower(email) = lower(%s)", (args.actor_email,))
            actor = cur.fetchone()
            if not actor:
                raise SystemExit(f"No CRM user {args.actor_email}")
            cur.execute("select id from crm_bulk_trade_lots where id = %s for update", (pack["lot_id"],))
            out = plan(cur, pack)
            if args.apply:
                if out["files"] and not (args.files_dir and Path(args.files_dir).is_dir()):
                    raise SystemExit("--files-dir must be an existing folder to add files")
                apply(cur, out, actor["id"], args.files_dir)
            else:
                connection.rollback()
    finally:
        connection.close()

    summary = {**out, "mode": "applied" if args.apply else "dry run",
               "files": [{k: v for k, v in f.items() if k != "path"} for f in out["files"]]}
    json.dump(summary, sys.stdout, indent=2, ensure_ascii=False, default=str)
    print()


if __name__ == "__main__":
    main()
