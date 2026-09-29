#!/usr/bin/env python3
"""Idempotently import normalized supplier stock into DenchClaw.

The REB-330 combined disposition is the first supported input contract. The
script defaults to dry-run and requires --apply for a database write.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
from collections import Counter
from decimal import Decimal, InvalidOperation
from pathlib import Path

import psycopg2
from psycopg2.extras import Json, execute_values


UPSERT = """
insert into crm_stock_items (
  id, supplier, stock_id, stock_status, make, model, model_detail, year,
  powertrain, part_number, description, quantity, price, location, condition,
  comments, aged_12m, in_august, in_september_aged, chemistry, scope,
  commercial_bucket, evidence, attributes
) values %s
on conflict (supplier, stock_id) do update set
  make = coalesce(excluded.make, crm_stock_items.make),
  model = coalesce(excluded.model, crm_stock_items.model),
  model_detail = coalesce(excluded.model_detail, crm_stock_items.model_detail),
  year = coalesce(excluded.year, crm_stock_items.year),
  powertrain = coalesce(excluded.powertrain, crm_stock_items.powertrain),
  part_number = coalesce(excluded.part_number, crm_stock_items.part_number),
  description = coalesce(excluded.description, crm_stock_items.description),
  quantity = excluded.quantity,
  price = coalesce(excluded.price, crm_stock_items.price),
  location = coalesce(excluded.location, crm_stock_items.location),
  condition = coalesce(excluded.condition, crm_stock_items.condition),
  comments = coalesce(excluded.comments, crm_stock_items.comments),
  aged_12m = crm_stock_items.aged_12m or excluded.aged_12m,
  in_august = crm_stock_items.in_august or excluded.in_august,
  in_september_aged = crm_stock_items.in_september_aged or excluded.in_september_aged,
  chemistry = case when crm_stock_items.enrich_status = 'enriched'
    then crm_stock_items.chemistry else coalesce(excluded.chemistry, crm_stock_items.chemistry) end,
  scope = case when crm_stock_items.enrich_status = 'enriched'
    then crm_stock_items.scope else coalesce(excluded.scope, crm_stock_items.scope) end,
  commercial_bucket = case when crm_stock_items.enrich_status = 'enriched'
    then crm_stock_items.commercial_bucket else coalesce(excluded.commercial_bucket, crm_stock_items.commercial_bucket) end,
  evidence = jsonb_set(
    coalesce(crm_stock_items.evidence, '{}'::jsonb) - array[
      'commercial_action', 'scope_decision', 'match_basis',
      'prior_nmc_screen', 'lfp_screen', 'chemistry_basis',
      'next_discriminator', 'source_row'
    ],
    '{reb330_import}', excluded.evidence->'reb330_import', true
  ),
  attributes = coalesce(crm_stock_items.attributes, '{}'::jsonb) || excluded.attributes,
  updated_at = now()
"""


def text(value: str | None) -> str | None:
    value = (value or "").strip()
    return value or None


def truth(value: str | None) -> bool:
    return (value or "").strip().lower() in {"true", "1", "yes", "y"}


def number(value: str | None) -> Decimal | None:
    value = (value or "").strip()
    if not value:
        return None
    try:
        return Decimal(value)
    except InvalidOperation as exc:
        raise ValueError(f"Invalid numeric value: {value!r}") from exc


def stable_id(supplier: str, stock_id: str) -> str:
    digest = hashlib.sha256(f"{supplier}\0{stock_id}".encode()).hexdigest()[:24]
    return f"stock-{digest}"


def row_values(row: dict[str, str]) -> tuple[object, ...]:
    supplier = text(row.get("supplier"))
    stock_id = text(row.get("stock_id"))
    if not supplier or not stock_id:
        raise ValueError("Every row requires supplier and stock_id")
    import_evidence = {
        key: value
        for key in (
            "commercial_action", "scope_decision", "match_basis",
            "prior_nmc_screen", "lfp_screen", "chemistry_basis",
            "next_discriminator", "source_row",
        )
        if (value := text(row.get(key))) is not None
    }
    evidence = {"reb330_import": import_evidence}
    attributes = {"import_source": "REB-330 commercial handoff"}
    quantity = number(row.get("quantity"))
    return (
        stable_id(supplier, stock_id), supplier, stock_id, "unverified",
        text(row.get("make")), text(row.get("model")), text(row.get("model_detail")),
        text(row.get("year")), text(row.get("powertrain")), text(row.get("part_number")),
        text(row.get("description")), Decimal(1) if quantity is None else quantity,
        number(row.get("price")), text(row.get("location")), text(row.get("condition")),
        text(row.get("comments")), truth(row.get("aged_12m")), truth(row.get("in_august")),
        truth(row.get("in_september_aged")), text(row.get("chemistry_labels")),
        text(row.get("scope")), text(row.get("commercial_bucket")), Json(evidence),
        Json(attributes),
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("csv_path", type=Path)
    parser.add_argument("--database", default="denchclaw")
    parser.add_argument("--only-august", action="store_true")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    raw = args.csv_path.read_bytes()
    with args.csv_path.open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    if args.only_august:
        rows = [row for row in rows if truth(row.get("in_august"))]
    identities = [(text(row.get("supplier")), text(row.get("stock_id"))) for row in rows]
    if None in {item for pair in identities for item in pair}:
        raise SystemExit("supplier and stock_id are required")
    if len(set(identities)) != len(identities):
        raise SystemExit("input contains duplicate (supplier, stock_id) identities")
    values = [row_values(row) for row in rows]
    summary = {
        "source_sha256": hashlib.sha256(raw).hexdigest(),
        "rows": len(rows),
        "suppliers": dict(sorted(Counter(pair[0] for pair in identities).items())),
        "mode": "apply" if args.apply else "dry-run",
    }
    if args.apply:
        with psycopg2.connect(dbname=args.database) as connection:
            with connection.cursor() as cursor:
                execute_values(cursor, UPSERT, values, page_size=250)
        summary["written"] = len(rows)
    print(json.dumps(summary, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
