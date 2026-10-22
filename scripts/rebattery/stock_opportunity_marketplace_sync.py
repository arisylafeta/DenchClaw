#!/usr/bin/env python3
"""Keeps crm_stock_opportunities' listed/opportunity status in step with the ReBattery marketplace.

Each stock opportunity linked to a marketplace listing (marketplace_listing_id) gets that listing's current
status: `published` means status `listed`; anything else (draft, completed, withdrawn, deleted) means
`opportunity`, with the marketplace status kept in marketplace_status. A listing that has gone from the
marketplace is marked `missing`. Read-only on the platform; writes only crm_stock_opportunities.

    stock_opportunity_marketplace_sync.py            # dry run: prints what would change
    stock_opportunity_marketplace_sync.py --apply    # writes the changes
"""
import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import psycopg2
import psycopg2.extras

PLATFORM_ENV = Path("/root/.hermes/workspace/secrets/dench-platform-admin.env")
BATCH = 150


def read_env_value(path, name):
    try:
        for line in path.read_text().splitlines():
            if line.startswith(name + "="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return None


def fetch_statuses(ids, env_path=PLATFORM_ENV):
    """{listing id: status} for the given marketplace listing ids (missing ids are absent)."""
    url = read_env_value(env_path, "NEXT_PUBLIC_SUPABASE_URL")
    key = read_env_value(env_path, "SUPABASE_SECRET_KEY")
    if not url or not key:
        raise SystemExit(f"platform URL or key missing in {env_path}")
    found = {}
    ids = sorted(ids)
    for start in range(0, len(ids), BATCH):
        chunk = ids[start:start + BATCH]
        query = urllib.parse.urlencode({"select": "id,listing_status", "id": f"in.({','.join(chunk)})"}, safe="(),.")
        request = urllib.request.Request(f"{url}/rest/v1/listings?{query}", headers={
            "apikey": key, "Authorization": f"Bearer {key}", "Accept": "application/json"})
        with urllib.request.urlopen(request, timeout=60) as response:
            for row in json.loads(response.read()):
                found[row["id"]] = row["listing_status"]
    return found


def plan(rows, statuses):
    """Changes as (id, new status, new marketplace_status) for rows whose marketplace state moved."""
    changes = []
    for row in rows:
        market = statuses.get(row["marketplace_listing_id"], "missing")
        status = "listed" if market == "published" else "opportunity"
        if (status, market) != (row["status"], row["marketplace_status"]):
            changes.append((row["id"], status, market, row["status"], row["marketplace_status"]))
    return changes


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--dsn", default=os.environ.get("DENCH_STOCK_DSN", "dbname=denchclaw"))
    args = parser.parse_args(argv)
    conn = psycopg2.connect(args.dsn)
    with conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("""select id, status, marketplace_status, marketplace_listing_id from crm_stock_opportunities
                       where marketplace_listing_id is not null""")
        rows = cur.fetchall()
        statuses = fetch_statuses({row["marketplace_listing_id"] for row in rows})
        changes = plan(rows, statuses)
        for row_id, status, market, old_status, old_market in changes:
            print(f"{row_id}: {old_status}/{old_market} -> {status}/{market}")
        if args.apply:
            for row_id, status, market, old_status, old_market in changes:
                cur.execute(
                    """update crm_stock_opportunities set status = %s, marketplace_status = %s, updated_at = now(),
                         details = details || jsonb_build_object('marketplace_sync', jsonb_build_object(
                           'on', now()::date, 'from_status', %s::text, 'from_marketplace_status', %s::text))
                       where id = %s""", (status, market, old_status, old_market, row_id))
        print(f"{len(rows)} linked rows, {len(changes)} changed{'' if args.apply else ' (dry run)'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
