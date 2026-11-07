"""Write the read-only candidate pool snapshot for the Matches replay.

Usage:
  /usr/bin/python3 scripts/rebattery/match_replay/build_pool.py \
      --out /root/.hermes/workspace/buyer-dossiers-pilot/replay/pool.json

Reads local DenchClaw Postgres only. No writes. The snapshot holds the fields
the rules layer and caseworker are allowed to see: id, name, buyer_profile,
stage, tier, basis and the last email touch from mail_message.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import psycopg2
import psycopg2.extras

POOL_SQL = """
select c.id,
       c.name,
       c.buyer_profile as profile,
       c.buyer_stage as stage,
       c.buyer_tier as tier,
       c.buyer_profile_basis as basis,
       (select max(coalesce(m.sent_at, m.created_at))
          from crm_people p
          join mail_message m on m.person_id = p.id
         where p.company_id = c.id) as last_touch
  from crm_companies c
 where c.buyer_profile <> '{}'::jsonb
   and c.buyer_exclusion_reason is null
 order by c.name, c.id
"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--dsn", default="dbname=denchclaw")
    args = parser.parse_args()

    conn = psycopg2.connect(args.dsn)
    conn.set_session(readonly=True)
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(POOL_SQL)
            rows = cur.fetchall()
    finally:
        conn.close()

    buyers = []
    for row in rows:
        buyers.append({
            "id": row["id"],
            "name": row["name"],
            "profile": row["profile"] or {},
            "stage": row["stage"],
            "tier": row["tier"],
            "basis": row["basis"],
            "last_touch": row["last_touch"].isoformat() if row["last_touch"] else None,
        })

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"count": len(buyers), "buyers": buyers}, indent=1), encoding="utf-8")
    print(json.dumps({"out": str(out), "count": len(buyers)}))


if __name__ == "__main__":
    main()
