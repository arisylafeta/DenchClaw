"use client";

import type { RegisteredEntryDetail } from "@/lib/crm-postgres/registered-entry-detail";
import { BulkTradeDetailPreview } from "./bulk-trade-detail-preview";
import { CampaignDetailPreview } from "./campaign-detail-preview";

type Props = {
  detail?: RegisteredEntryDetail;
  onNavigateEntry?: (objectName: string, entryId: string, relatedObjectId?: string) => void;
};

type RegisteredDetailRenderer = (props: Props) => React.ReactNode;

const renderers: Record<RegisteredEntryDetail["kind"], RegisteredDetailRenderer> = {
  bulk_trade: ({ detail, onNavigateEntry }) => detail?.kind === "bulk_trade"
    ? <BulkTradeDetailPreview detail={detail} onNavigateEntry={onNavigateEntry} />
    : null,
  campaign: ({ detail, onNavigateEntry }) => detail?.kind === "campaign"
    ? <CampaignDetailPreview recipients={detail.recipients} onNavigateEntry={onNavigateEntry} />
    : null,
};

export function RegisteredEntryDetailPreview(props: Props) {
  if (!props.detail) return null;
  return renderers[props.detail.kind](props);
}
