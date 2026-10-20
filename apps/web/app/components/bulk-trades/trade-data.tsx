"use client";

import { useState } from "react";
import type { BulkTrade, TradePatch } from "@/lib/bulk-trades";
import {
  FIELD_STATUSES,
  VISIBILITIES,
  VISIBILITY_LABEL,
  type FieldStatus,
  type TemplateField,
  type TradeDetail,
  type TradeField,
  type Visibility,
} from "@/lib/bulk-trade-details";
import {
  Card,
  ErrorText,
  FormField,
  KindPicker,
  Modal,
  darkButtonClass,
  darkButtonStyle,
  request,
  tradeUrl,
  useForm,
} from "./trade-ui";
import type { Registry } from "@/lib/bulk-registry";
import { supplyFacts, type Fact } from "@/lib/listing-facts";
import { ListingDetails } from "./listing-details";
import { useRegistry } from "./use-registry";

const STATUS_LABEL: Record<FieldStatus, string> = {
  confirmed: "Confirmed", unverified: "Unverified", conflict: "Conflict", missing: "Missing",
};
type Props = {
  detail: TradeDetail;
  onField: (field: TradeField) => void;
  onTradePatch: (patch: TradePatch) => Promise<void>;
};

export function TradeData({ detail, onField, onTradePatch }: Props) {
  const { trade } = detail;
  const registry = useRegistry();
  if (!registry) return <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>Loading…</p>;
  return (
    <div className="flex flex-col gap-6">
      {trade.trade_kind ? <FieldsCard registry={registry} trade={trade} kind={trade.trade_kind} fields={detail.fields} onField={onField} />
        : <Card label="Data" className="px-5 py-4"><KindPicker label="Trade kind" onPick={(kind) => void onTradePatch({ trade_kind: kind })} /></Card>}
    </div>
  );
}

function FieldsCard({ registry, trade, kind, fields, onField }: {
  registry: Registry;
  trade: BulkTrade;
  kind: NonNullable<BulkTrade["trade_kind"]>;
  fields: TradeField[];
  onField: (field: TradeField) => void;
}) {
  const [editing, setEditing] = useState<TemplateField | null>(null);
  const [error, setError] = useState<string | null>(null);
  const facts = supplyFacts(registry, kind, fields);

  async function resolve(fact: Fact, choice: number) {
    setError(null);
    try {
      const { field } = await request<{ field: TradeField }>(tradeUrl(trade.id, `/fields/${fact.key}/resolve`), {
        method: "POST",
        body: JSON.stringify({ choice }),
      });
      onField(field);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not settle the conflict.");
    }
  }

  return (
    <section aria-label="Data" className="flex flex-col gap-3">
      <ListingDetails
        facts={facts}
        onEdit={(fact) => setEditing(registry.fields[kind].find((template) => template.key === fact.key) ?? null)}
        onResolve={resolve}
      />
      <ErrorText error={error} />
      {editing && (
        <FieldDialog
          trade={trade}
          template={editing}
          field={fields.find((field) => field.field_key === editing.key)}
          onClose={() => setEditing(null)}
          onSaved={(field) => { onField(field); setEditing(null); }}
        />
      )}
    </section>
  );
}

function FieldDialog({ trade, template, field, onClose, onSaved }: {
  trade: BulkTrade;
  template: TemplateField;
  field: TradeField | undefined;
  onClose: () => void;
  onSaved: (field: TradeField) => void;
}) {
  const form = useForm({
    value: field?.value ?? "",
    status: field?.status ?? "unverified",
    visibility: field?.visibility ?? template.visibility,
    source_label: field?.source_label ?? "",
    source_url: field?.source_url ?? "",
    source_date: field?.source_date ?? "",
  }, async (draft) => {
    onSaved((await request<{ field: TradeField }>(tradeUrl(trade.id, `/fields/${template.key}`), {
      method: "PUT",
      body: JSON.stringify(draft),
    })).field);
  });

  return (
    <Modal
      title={template.label}
      onClose={onClose}
      onSubmit={form.submit}
      footer={<button type="submit" disabled={form.saving} className={darkButtonClass} style={darkButtonStyle}>Save</button>}
    >
      <FormField label="Value">{form.input("value", { autoFocus: true })}</FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Status">{form.select("status", FIELD_STATUSES, STATUS_LABEL)}</FormField>
        <FormField label="Buyers see at">{form.select("visibility", VISIBILITIES, VISIBILITY_LABEL)}</FormField>
      </div>
      <div className="grid grid-cols-[1fr_150px] gap-3">
        <FormField label="Source">{form.input("source_label", { placeholder: "Gmail · Fabio Papa" })}</FormField>
        <FormField label="Source date">{form.input("source_date", { type: "date" })}</FormField>
      </div>
      <FormField label="Source link">{form.input("source_url", { type: "url", placeholder: "https://mail.google.com/…" })}</FormField>
      {template.key === "seller_price" && form.draft.visibility !== "never" && (
        <p className="text-[13px]" style={{ color: "var(--bt-amber)" }}>Seller price is normally Never. Teasers leave it out either way.</p>
      )}
      <ErrorText error={form.error} />
    </Modal>
  );
}

