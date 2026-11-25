#!/usr/bin/env python3
"""Copy marketplace sourcing requests and saved searches into crm_platform_enquiries; dry run unless --apply.

Reads production `sourcing_requests` and `saved_searches` (GET only: id, email, created_at) and upserts them locally, keyed by
(kind, platform_id) with a lower-cased email. They feed First Contact and Last Heard From (migration 142). Never deletes.
Output is aggregate counts only.
"""
import argparse
import json
import sys

import psycopg2

from platform_account_sync import PlatformReader, platform_credentials

UPSERT = """
insert into crm_platform_enquiries (kind, platform_id, email, created_at)
select %s, x.id, lower(btrim(x.email)), x.created_at::timestamptz
from jsonb_to_recordset(%s::jsonb) as x(id text, email text, created_at text)
where coalesce(btrim(x.email), '') <> '' and x.created_at is not null
on conflict (kind, platform_id) do update set email = excluded.email, created_at = excluded.created_at
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Write the rows (default: dry run)')
    args = parser.parse_args()
    try:
        reader = PlatformReader(*platform_credentials())
        tables = {'sourcing_request': 'sourcing_requests', 'saved_search': 'saved_searches'}
        counts = {}
        with psycopg2.connect(dbname='denchclaw') as conn, conn.cursor() as cur:
            for kind, table in tables.items():
                rows = reader.table(table, 'id,email,created_at', 'created_at.asc')
                cur.execute(UPSERT, (kind, json.dumps([{**r, 'id': str(r['id'])} for r in rows])))
                counts[kind] = {'platform_rows': len(rows), 'written': cur.rowcount}
            if not args.apply:
                conn.rollback()
        print(json.dumps({'mode': 'apply' if args.apply else 'dry-run', **counts}, sort_keys=True))
    except Exception as exc:
        print(f'Platform enquiry sync failed ({type(exc).__name__}); no CRM changes applied.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
