"""Write the read-only candidate pool snapshot for the Matches replay.

Usage:
  /usr/bin/python3 scripts/rebattery/match_replay/build_pool.py \
      --out /root/.hermes/workspace/buyer-dossiers-pilot/replay/pool-v2.json \
      --include-dossier-dir /root/.hermes/workspace/buyer-dossiers-pilot

Reads local DenchClaw Postgres only. No writes. The snapshot holds the fields
the rules layer and caseworker are allowed to see: id, name, buyer_profile,
stage, tier, basis and the last email touch from mail_message.

``--include-dossier-dir`` adds companies that have a pilot dossier but an empty
``buyer_profile`` (Volta Robotics). That simulates the phase 0 pool fix so a
case whose only expected buyer has no profile can still be replayed.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import psycopg2
import psycopg2.extras
import yaml

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

DOSSIER_IDS_SQL = """
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
 where c.id = any(%s)
 order by c.name, c.id
"""


def dossier_company_ids(folder: Path) -> set[str]:
    ids: set[str] = set()
    for path in sorted(folder.glob("*.md")):
        if path.name.upper() in {"TEMPLATE.MD", "README.MD"}:
            continue
        text = path.read_text(encoding="utf-8")
        if not text.startswith("---"):
            continue
        parts = text.split("---", 2)
        if len(parts) < 3:
            continue
        front = yaml.safe_load(parts[1]) or {}
        if isinstance(front, dict) and front.get("company_id"):
            ids.add(str(front["company_id"]))
    return ids


def row_to_buyer(row: dict, dossier_only: bool = False) -> dict:
    buyer = {
        "id": row["id"],
        "name": row["name"],
        "profile": row["profile"] or {},
        "stage": row["stage"],
        "tier": row["tier"],
        "basis": row["basis"],
        "last_touch": row["last_touch"].isoformat() if row["last_touch"] else None,
    }
    if dossier_only:
        buyer["dossier_only"] = True
    return buyer


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--dsn", default="dbname=denchclaw")
    parser.add_argument("--include-dossier-dir", default=None)
    args = parser.parse_args()

    conn = psycopg2.connect(args.dsn)
    conn.set_session(readonly=True)
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(POOL_SQL)
            rows = cur.fetchall()
            buyers = [row_to_buyer(row) for row in rows]
            added: list[dict] = []
            if args.include_dossier_dir:
                wanted = dossier_company_ids(Path(args.include_dossier_dir))
                present = {buyer["id"] for buyer in buyers}
                missing = sorted(wanted - present)
                if missing:
                    cur.execute(DOSSIER_IDS_SQL, (missing,))
                    added = [row_to_buyer(row, dossier_only=True) for row in cur.fetchall()]
                    buyers.extend(added)
    finally:
        conn.close()

    buyers.sort(key=lambda buyer: (buyer["name"], buyer["id"]))
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"count": len(buyers), "buyers": buyers}, indent=1), encoding="utf-8")
    print(json.dumps({
        "out": str(out),
        "count": len(buyers),
        "dossier_only": [buyer["name"] for buyer in added],
    }))


if __name__ == "__main__":
    main()
