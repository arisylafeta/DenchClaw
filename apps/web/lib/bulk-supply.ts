import type { Basis, DemandKind } from "./bulk-demand";
import type { CompanyContextNote } from "./crm-postgres/company-context";

export type SupplyFeedRow = {
  id: string;
  kind: "supply" | "trade" | "auction";
  title: string;
  seller: string | null;
  size: string | null;
  location: string | null;
  seen: string | null;
  status: string;
  href: string;
  suppliers: string[];
  verified: boolean | null;
  count: number | null;
};

/** Why a batch left the Supply list. */
export const SUPPLY_CLOSED_REASONS = ["sold", "became_trade", "gone", "not_a_fit", "other"] as const;
export type SupplyClosedReason = (typeof SUPPLY_CLOSED_REASONS)[number];

export const SUPPLY_CLOSED_LABEL: Record<SupplyClosedReason, string> = {
  sold: "Sold",
  became_trade: "Became a trade",
  gone: "No longer available",
  not_a_fit: "Not for us",
  other: "Other",
};

/** A buyer whose open demand fits a batch, as judged by the matching. */
export type SupplyFit = {
  demand_id: string;
  buyer: string;
  contact: string | null;
  email: string | null;
  wants: string;
  kind: DemandKind;
  basis: Basis | null;
  strength: "strong" | "partial";
  reason: string;
};

/**
 * A reuse batch offered to ReBattery that is below the card bar (about 8 tonnes or $10k) or of unknown size. The
 * inbox check adds these; matching finds buyers for them among open demand.
 */
export type Supply = {
  id: string;
  seller: string;
  company_id: string | null;
  person_id: string | null;
  contact: string | null;
  email: string | null;
  offers: string;
  trade_kind: "packs" | "cells" | "systems" | null;
  quantity: string | null;
  location: string | null;
  est_tonnes: number | null;
  est_value_usd: number | null;
  size_note: string | null;
  source_kind: "email" | "call" | "manual" | null;
  source_label: string | null;
  source_url: string | null;
  source_quote: string | null;
  observed_on: string | null;
  status: "open" | "closed";
  closed_reason: SupplyClosedReason | null;
  updated_at: string;
  fits: SupplyFit[];
  context_notes: CompanyContextNote[];
};

/** "~2.4 t · ~$6k", or null when the size is unknown. */
export function sizeLabel(row: Pick<Supply, "est_tonnes" | "est_value_usd">): string | null {
  const parts: string[] = [];
  if (row.est_tonnes != null) parts.push(`~${row.est_tonnes < 10 ? Number(row.est_tonnes.toFixed(1)) : Math.round(row.est_tonnes)} t`);
  if (row.est_value_usd != null) {
    const value = row.est_value_usd;
    parts.push(`~$${value >= 1000 ? `${Math.round(value / 1000)}k` : Math.round(value)}`);
  }
  return parts.length ? parts.join(" · ") : null;
}
