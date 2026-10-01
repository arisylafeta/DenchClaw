"use client";

import type { RegisteredEntryDetail } from "@/lib/crm-postgres/registered-entry-detail";
import { BulkTradeDetailPreview } from "./bulk-trade-detail-preview";

type Props = {
  detail?: RegisteredEntryDetail;
  onNavigateEntry?: (objectName: string, entryId: string, relatedObjectId?: string) => void;
};

export function RegisteredEntryDetailPreview(props: Props) {
  if (!props.detail) { return null; }
  return <BulkTradeDetailPreview detail={props.detail} onNavigateEntry={props.onNavigateEntry} />;
}
