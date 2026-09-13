#!/usr/bin/env python3
"""Load a local, evidence-linked bulk-trade manifest into DenchClaw CRM."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

LOT_KINDS = {"supply", "demand"}
CONFIDENCE_LEVELS = {"confirmed", "probable", "uncertain"}
PARTY_ROLES = {"supplier", "buyer", "intermediary", "advisor"}
EVIDENCE_KINDS = {
    "whatsapp_message", "whatsapp_attachment", "gmail_thread", "gmail_message",
    "crm_opportunity", "marketplace_listing", "marketplace_offer", "marketplace_deal",
}
FORBIDDEN_TRANSACTION_KEYS = {"marketplace_status", "offer_status", "deal_status"}


def validate_manifest(manifest: dict) -> None:
    lots = manifest.get("lots", [])
    parties = manifest.get("parties", [])
    links = manifest.get("evidence_links", [])
    lot_ids = {lot.get("id") for lot in lots}
    if None in lot_ids or len(lot_ids) != len(lots):
        raise ValueError("lot ids must be present and unique")

    for lot in lots:
        if lot.get("lot_kind") not in LOT_KINDS:
            raise ValueError(f"invalid lot kind for {lot.get('id')}")
        if lot.get("confidence") not in CONFIDENCE_LEVELS:
            raise ValueError(f"invalid confidence for {lot.get('id')}")
        if not lot.get("title") or not lot.get("summary") or not lot.get("observed_outcome"):
            raise ValueError(f"lot {lot.get('id')} is missing required evidence summary fields")
        source_manifest = lot.get("source_manifest") or {}
        if FORBIDDEN_TRANSACTION_KEYS.intersection(source_manifest):
            raise ValueError("marketplace transaction state must stay in the marketplace")

    party_ids = {party.get("id") for party in parties}
    if None in party_ids or len(party_ids) != len(parties):
        raise ValueError("party ids must be present and unique")
    for party in parties:
        if party.get("lot_id") not in lot_ids:
            raise ValueError(f"party references unknown lot {party.get('lot_id')}")
        if party.get("role") not in PARTY_ROLES:
            raise ValueError(f"invalid party role for {party.get('id')}")
        if not party.get("display_name"):
            raise ValueError(f"party {party.get('id')} needs a display name")

    for link in links:
        if link.get("lot_id") not in lot_ids:
            raise ValueError(f"evidence link references unknown lot {link.get('lot_id')}")
        if link.get("evidence_kind") not in EVIDENCE_KINDS:
            raise ValueError(f"invalid evidence kind for {link.get('lot_id')}")
        if not link.get("evidence_id"):
            raise ValueError(f"evidence link for {link.get('lot_id')} needs an id")


def load_manifest(path: Path) -> dict[str, int]:
    try:
        import psycopg2
        from psycopg2.extras import Json, execute_values
    except ImportError as error:
        raise SystemExit("psycopg2 is required to load the manifest") from error

    manifest = json.loads(path.read_text())
    validate_manifest(manifest)
    lots = manifest.get("lots", [])
    parties = manifest.get("parties", [])
    links = manifest.get("evidence_links", [])

    connection = psycopg2.connect(host="/var/run/postgresql", dbname="denchclaw")
    try:
        with connection:
            with connection.cursor() as cursor:
                if lots:
                    execute_values(
                        cursor,
                        """INSERT INTO crm_bulk_trade_lots
                           (id, title, lot_kind, summary, observed_quantity, quantity_unit,
                            observed_outcome, latest_activity_at, needs_attention, confidence,
                            reconciliation_note, source_manifest)
                           VALUES %s
                           ON CONFLICT (id) DO UPDATE SET
                             title = excluded.title,
                             lot_kind = excluded.lot_kind,
                             summary = excluded.summary,
                             observed_quantity = excluded.observed_quantity,
                             quantity_unit = excluded.quantity_unit,
                             observed_outcome = excluded.observed_outcome,
                             latest_activity_at = excluded.latest_activity_at,
                             needs_attention = excluded.needs_attention,
                             confidence = excluded.confidence,
                             reconciliation_note = excluded.reconciliation_note,
                             source_manifest = excluded.source_manifest,
                             updated_at = now()""",
                        [(
                            lot["id"], lot["title"], lot["lot_kind"], lot["summary"],
                            lot.get("observed_quantity"), lot.get("quantity_unit"),
                            lot["observed_outcome"], lot.get("latest_activity_at"),
                            lot.get("needs_attention", False), lot["confidence"],
                            lot.get("reconciliation_note"), Json(lot.get("source_manifest", {})),
                        ) for lot in lots],
                    )
                if parties:
                    execute_values(
                        cursor,
                        """INSERT INTO crm_bulk_trade_parties
                           (id, lot_id, role, display_name, company_id, channel, observed_outcome,
                            first_evidence_at, latest_evidence_at, notes)
                           VALUES %s
                           ON CONFLICT (id) DO UPDATE SET
                             lot_id = excluded.lot_id,
                             role = excluded.role,
                             display_name = excluded.display_name,
                             company_id = excluded.company_id,
                             channel = excluded.channel,
                             observed_outcome = excluded.observed_outcome,
                             first_evidence_at = excluded.first_evidence_at,
                             latest_evidence_at = excluded.latest_evidence_at,
                             notes = excluded.notes""",
                        [(
                            party["id"], party["lot_id"], party["role"], party["display_name"],
                            party.get("company_id"), party.get("channel"), party.get("observed_outcome"),
                            party.get("first_evidence_at"), party.get("latest_evidence_at"),
                            party.get("notes"),
                        ) for party in parties],
                    )
                if links:
                    execute_values(
                        cursor,
                        """INSERT INTO crm_bulk_trade_evidence_links
                           (lot_id, evidence_kind, evidence_id, relationship, note)
                           VALUES %s
                           ON CONFLICT (lot_id, evidence_kind, evidence_id) DO UPDATE SET
                             relationship = excluded.relationship,
                             note = excluded.note""",
                        [(
                            link["lot_id"], link["evidence_kind"], link["evidence_id"],
                            link.get("relationship", "supports"), link.get("note"),
                        ) for link in links],
                    )
                cursor.execute("select count(*) from crm_bulk_trade_overview")
                overview_count = cursor.fetchone()[0]
    finally:
        connection.close()

    return {
        "lots": len(lots),
        "parties": len(parties),
        "evidence_links": len(links),
        "overview_rows": overview_count,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    result = load_manifest(args.manifest)
    print(json.dumps(result, sort_keys=True) if args.json else result)


if __name__ == "__main__":
    main()
