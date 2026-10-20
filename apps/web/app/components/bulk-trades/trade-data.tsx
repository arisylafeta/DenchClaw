"use client";

import { useRef, useState } from "react";
import type { BulkTrade, TradePatch } from "@/lib/bulk-trades";
import tableStyles from "../ui/data-table.module.css";
import { TableCellContent } from "../ui/table-cell";
import {
  FIELD_STATUSES,
  FILE_TYPES,
  VISIBILITIES,
  VISIBILITY_LABEL,
  previewType,
  shortDate,
  type FieldSource,
  type FieldStatus,
  type Proposal,
  type TemplateField,
  type TradeDetail,
  type TradeField,
  type TradeFile,
  type Visibility,
} from "@/lib/bulk-trade-details";
import {
  Card,
  ErrorText,
  FormField,
  KindPicker,
  Modal,
  buttonClass,
  buttonStyle,
  darkButtonClass,
  darkButtonStyle,
  inputStyle,
  request,
  tradeUrl,
  useForm,
} from "./trade-ui";
import type { Registry } from "@/lib/bulk-registry";
import { supplyFacts, type Fact } from "@/lib/listing-facts";
import { ListingDetails } from "./listing-details";
import { ProposalRow } from "./proposal-row";
import { useRegistry } from "./use-registry";
import { FileLink, FileThumb, fileUrl } from "./file-preview";

const FILE_COLUMNS = "grid-cols-[minmax(0,1fr)_130px_250px_170px]";

const STATUS_LABEL: Record<FieldStatus, string> = {
  confirmed: "Confirmed", unverified: "Unverified", conflict: "Conflict", missing: "Missing",
};
type Props = {
  detail: TradeDetail;
  onProposalDecided: () => void;
  onField: (field: TradeField) => void;
  onFile: (file: TradeFile) => void;
  onTradePatch: (patch: TradePatch) => Promise<void>;
};

const tableHead = { background: "var(--bt-table-head)", borderColor: "var(--bt-divider)" };

function sourceText(source: Pick<FieldSource, "source_label" | "source_date">) {
  return [source.source_label, source.source_date && shortDate(source.source_date)].filter(Boolean).join(" · ");
}

export function TradeData({ detail, onField, onFile, onTradePatch, onProposalDecided }: Props) {
  const { trade } = detail;
  const registry = useRegistry();
  if (!registry) return <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>Loading…</p>;
  return (
    <div className="flex flex-col gap-6">
      {trade.trade_kind ? <FieldsCard registry={registry} trade={trade} kind={trade.trade_kind} fields={detail.fields} onField={onField} />
        : <Card label="Data" className="px-5 py-4"><KindPicker label="Trade kind" onPick={(kind) => void onTradePatch({ trade_kind: kind })} /></Card>}
      <FilesCard registry={registry} trade={trade} files={detail.files} onFile={onFile}
        proposals={[]} onProposalDecided={onProposalDecided} />
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

function FilesCard({ registry, trade, files, onFile, proposals, onProposalDecided }: {
  registry: Registry;
  trade: BulkTrade;
  files: TradeFile[];
  onFile: (file: TradeFile) => void;
  proposals: Proposal[];
  onProposalDecided: () => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uploaded = new Set(files.map((file) => file.file_type));
  const stillNeeded = registry.requiredFiles.filter((file) => !uploaded.has(file.type)).map((file) => file.label.toLowerCase());

  async function changeVisibility(file: TradeFile, visibility: Visibility) {
    setError(null);
    onFile({ ...file, visibility });
    try {
      const saved = await request<{ file: TradeFile }>(tradeUrl(trade.id, `/files/${file.id}`), {
        method: "PATCH",
        body: JSON.stringify({ visibility }),
      });
      onFile(saved.file);
    } catch (err) {
      onFile(file);
      setError(err instanceof Error ? err.message : "Could not save.");
    }
  }

  return (
    <Card label="Files" className={`bulk-trades ${tableStyles.surface} overflow-hidden`}>
      <header data-table-part="toolbar" className="flex flex-wrap items-center gap-3 border-b px-5 py-4" style={{ borderColor: "var(--bt-column)" }}>
        <h2 className="text-base font-semibold">Files</h2>
        <span className="text-[13px]" style={{ color: "var(--bt-muted)" }}>Stored privately. Buyers see a new file at Never until you change it.</span>
        <span className="flex-1" />
        <button type="button" className={`${buttonClass} !h-8`} style={buttonStyle} onClick={() => setUploading(true)}>Upload</button>
      </header>
      <div className="overflow-x-auto">
        <div className="min-w-[760px]">
          <div data-table-part="grid-header" className={`grid ${FILE_COLUMNS} gap-4 border-b px-3 py-2 font-medium`} style={tableHead}>
            <span>File</span><span>Type</span><span>Source</span><span>Buyers see at</span>
          </div>
          {files.map((file) => (
            <div key={file.id} data-table-part="grid-row" className={`grid ${FILE_COLUMNS} items-center gap-4 border-b px-3 py-2 text-xs`} style={{ borderColor: "var(--bt-divider)" }}>
              <TableCellContent>
              <div className="flex min-w-0 items-center gap-3">
                <FileLink trade={trade} file={file} className="flex min-w-0 items-center gap-3 hover:underline">
                  <FileThumb trade={trade} file={file} />
                  <span className="truncate text-xs font-semibold">{file.file_name}</span>
                </FileLink>
                {previewType(file.file_name) && (
                  <a href={fileUrl(trade, file)} className="shrink-0 text-xs" style={{ color: "var(--bt-muted)" }}>Download</a>
                )}
              </div>
              </TableCellContent>
              <TableCellContent><span className="text-xs" style={{ color: "var(--bt-text-2)" }}>{file.file_type}</span></TableCellContent>
              <TableCellContent><span className="text-xs" style={{ color: "var(--bt-text-2)" }}>{sourceText(file) || "Uploaded"}</span></TableCellContent>
              <TableCellContent>
              <select
                aria-label={`Who sees ${file.file_name}`}
                value={file.visibility}
                onChange={(event) => changeVisibility(file, event.target.value as Visibility)}
                className="h-8 rounded-none border px-1.5 text-xs"
                style={inputStyle}
              >
                {VISIBILITIES.map((visibility) => <option key={visibility} value={visibility}>{VISIBILITY_LABEL[visibility]}</option>)}
              </select>
              </TableCellContent>
            </div>
          ))}
          {proposals.map((proposal) => (
            <div key={proposal.id} className="border-b" style={{ borderColor: "var(--bt-divider)" }}>
              <ProposalRow proposal={proposal} onDecided={onProposalDecided} />
            </div>
          ))}
          {!files.length && !proposals.length && <p className="px-5 py-5 text-sm" style={{ color: "var(--bt-muted)" }}>No files yet.</p>}
        </div>
      </div>
      <div data-table-part="footer" className="px-5 py-3 text-xs" style={{ color: "var(--bt-muted)" }}>
        {stillNeeded.length ? `Still needed: ${stillNeeded.join(", ")}` : "All required files are in."}
        <ErrorText error={error} />
      </div>
      {uploading && (
        <UploadDialog trade={trade} onClose={() => setUploading(false)} onSaved={(file) => { onFile(file); setUploading(false); }} />
      )}
    </Card>
  );
}

function UploadDialog({ trade, onClose, onSaved }: { trade: BulkTrade; onClose: () => void; onSaved: (file: TradeFile) => void }) {
  const picker = useRef<HTMLInputElement>(null);
  const form = useForm({ file_type: "Photos", source_label: "" }, async (draft) => {
    const file = picker.current?.files?.[0];
    if (!file) throw new Error("Choose a file.");
    const body = new FormData();
    body.set("file", file);
    body.set("file_type", draft.file_type);
    if (draft.source_label.trim()) body.set("source_label", draft.source_label.trim());
    onSaved((await request<{ file: TradeFile }>(tradeUrl(trade.id, "/files"), { method: "POST", body })).file);
  });

  return (
    <Modal
      title="Upload a file"
      onClose={onClose}
      onSubmit={form.submit}
      footer={<button type="submit" disabled={form.saving} className={darkButtonClass} style={darkButtonStyle}>{form.saving ? "Uploading" : "Upload"}</button>}
    >
      <FormField label="File (up to 25 MB)"><input ref={picker} type="file" required className="text-sm" /></FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Type">{form.select("file_type", FILE_TYPES)}</FormField>
        <FormField label="Source">{form.input("source_label", { placeholder: "Gmail · Fabio Papa" })}</FormField>
      </div>
      <ErrorText error={form.error} />
    </Modal>
  );
}
