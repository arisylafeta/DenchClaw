"use client";

import { useRef, useState } from "react";
import type { BulkTrade, TradePatch } from "@/lib/bulk-trades";
import {
  FIELD_STATUSES,
  FIELD_TEMPLATES,
  FILE_TYPES,
  REQUIRED_FILES,
  VISIBILITIES,
  VISIBILITY_LABEL,
  shortDate,
  type FieldSource,
  type FieldStatus,
  type FileType,
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
  inputClass,
  inputStyle,
  request,
  tradeUrl,
  useForm,
} from "./trade-ui";

const FIELD_COLUMNS = "grid-cols-[200px_minmax(0,1fr)_250px_110px_110px]";
const FILE_COLUMNS = "grid-cols-[minmax(0,1fr)_130px_250px_170px]";

const STATUS_LABEL: Record<FieldStatus, string> = {
  confirmed: "Confirmed", unverified: "Unverified", conflict: "Conflict", missing: "Missing",
};
const STATUS_STYLE: Record<FieldStatus, React.CSSProperties> = {
  confirmed: { background: "var(--bt-green-bg)", color: "var(--bt-green)" },
  unverified: { background: "var(--bt-divider)", color: "var(--bt-text-2)" },
  conflict: { background: "var(--bt-amber-bg)", color: "var(--bt-amber)" },
  missing: { background: "var(--bt-red-bg)", color: "var(--bt-red)" },
};

type Props = {
  detail: TradeDetail;
  onField: (field: TradeField) => void;
  onFile: (file: TradeFile) => void;
  onTradePatch: (patch: TradePatch) => Promise<void>;
};

const tableHead = { color: "var(--bt-muted)", background: "var(--bt-table-head)", borderColor: "var(--bt-column)" };

function sourceText(source: Pick<FieldSource, "source_label" | "source_date">) {
  return [source.source_label, source.source_date && shortDate(source.source_date)].filter(Boolean).join(" · ");
}

function Source({ source }: { source: FieldSource }) {
  const text = sourceText(source);
  if (!text) return <span style={{ color: "var(--bt-muted)" }}>—</span>;
  return source.source_url
    ? <a href={source.source_url} target="_blank" rel="noreferrer" className="hover:underline" style={{ color: "var(--bt-link)" }}>{text}</a>
    : <span style={{ color: "var(--bt-link)" }}>{text}</span>;
}

const clip = (text: string, length = 28) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

export function TradeData({ detail, onField, onFile, onTradePatch }: Props) {
  const { trade } = detail;
  if (!trade.trade_kind) {
    return (
      <Card label="Data" className="max-w-[480px] px-5 py-5">
        <KindPicker label="Pick the trade kind. Each kind has its own fixed list of fields." onPick={(kind) => void onTradePatch({ trade_kind: kind })} />
      </Card>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <FieldsCard trade={trade} kind={trade.trade_kind} fields={detail.fields} onField={onField} />
      <FilesCard trade={trade} files={detail.files} onFile={onFile} />
    </div>
  );
}

function FieldsCard({ trade, kind, fields, onField }: {
  trade: BulkTrade;
  kind: NonNullable<BulkTrade["trade_kind"]>;
  fields: TradeField[];
  onField: (field: TradeField) => void;
}) {
  const [editing, setEditing] = useState<TemplateField | null>(null);
  const [error, setError] = useState<string | null>(null);
  const byKey = new Map(fields.map((field) => [field.field_key, field]));
  const templates = FIELD_TEMPLATES[kind];
  const conflicts = templates
    .map((template) => ({ template, row: byKey.get(template.key) }))
    .filter(({ row }) => row?.status === "conflict" && row.alternatives.length);

  async function resolve(key: string, choice: number) {
    setError(null);
    try {
      const { field } = await request<{ field: TradeField }>(tradeUrl(trade.id, `/fields/${key}/resolve`), {
        method: "POST",
        body: JSON.stringify({ choice }),
      });
      onField(field);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not settle the conflict.");
    }
  }

  return (
    <Card label="Data" className="overflow-hidden">
      <header className="flex flex-wrap items-center gap-3 border-b px-5 py-4" style={{ borderColor: "var(--bt-column)" }}>
        <h2 className="text-base font-semibold">Data</h2>
        <span className="text-[13px]" style={{ color: "var(--bt-muted)" }}>Click a row to fill it in or change who sees it</span>
        <span className="flex-1" />
        <span className="text-[13px]" style={{ color: "var(--bt-muted)" }}>Private to ReBattery unless marked</span>
      </header>
      <div className="overflow-x-auto">
        <div className="min-w-[860px]">
          <div className={`grid ${FIELD_COLUMNS} gap-4 border-b px-5 py-2.5 text-xs font-semibold`} style={tableHead}>
            <span>Field</span><span>Value</span><span>Source</span><span>Status</span><span>Buyers see at</span>
          </div>
          {templates.map((template) => {
            const row = byKey.get(template.key);
            const status: FieldStatus = row && row.value?.trim() ? row.status : row?.status === "conflict" ? "conflict" : "missing";
            const claims: FieldSource[] = row ? [row, ...row.alternatives] : [];
            return (
              <button
                key={template.key}
                type="button"
                onClick={() => setEditing(template)}
                aria-label={`Edit ${template.label}`}
                className={`grid w-full ${FIELD_COLUMNS} items-start gap-4 border-b px-5 py-2.5 text-left text-sm hover:bg-[var(--bt-row-hover)]`}
                style={{ borderColor: "var(--bt-divider)", background: status === "conflict" ? "var(--bt-amber-tint)" : undefined }}
              >
                <span style={{ color: "var(--bt-text-2)" }}>{template.label}</span>
                <span className="flex flex-col font-medium leading-[1.4]">
                  {claims.length ? claims.map((claim, index) => <span key={index}>{claim.value || "—"}</span>) : <span>—</span>}
                </span>
                <span className="flex flex-col text-[13px] leading-[1.4]">
                  {claims.length ? claims.map((claim, index) => <Source key={index} source={claim} />) : <Source source={{ value: "", source_label: null, source_url: null, source_date: null }} />}
                </span>
                <span><span className="rounded-[5px] px-2 py-0.5 text-xs font-semibold" style={STATUS_STYLE[status]}>{STATUS_LABEL[status]}</span></span>
                <span className="text-[13px]" style={{ color: "var(--bt-text-2)" }}>{VISIBILITY_LABEL[row?.visibility ?? template.visibility]}</span>
              </button>
            );
          })}
        </div>
      </div>
      {conflicts.map(({ template, row }) => (
        <div key={template.key} className="flex flex-wrap items-center gap-2.5 border-t px-5 py-3" style={{ background: "var(--bt-table-head)", borderColor: "var(--bt-divider)" }}>
          <span className="rounded-[5px] px-[7px] py-0.5 text-[11px] font-semibold uppercase" style={STATUS_STYLE.conflict}>Conflict</span>
          <span className="min-w-[240px] flex-1 text-sm">
            {template.label}: {[row!, ...row!.alternatives].map((claim) => `${claim.value}${sourceText(claim) ? ` (${sourceText(claim)})` : ""}`).join(" or ")}?
          </span>
          <button type="button" className={`${buttonClass} h-8`} style={buttonStyle} onClick={() => resolve(template.key, -1)}>
            Keep {clip(row!.value)}
          </button>
          {row!.alternatives.map((claim, index) => (
            <button key={index} type="button" className={`${buttonClass} h-8`} style={buttonStyle} onClick={() => resolve(template.key, index)}>
              Use {clip(claim.value)}
            </button>
          ))}
        </div>
      ))}
      <div className="px-5"><ErrorText error={error} /></div>
      {editing && (
        <FieldDialog
          trade={trade}
          template={editing}
          field={byKey.get(editing.key)}
          onClose={() => setEditing(null)}
          onSaved={(field) => { onField(field); setEditing(null); }}
        />
      )}
    </Card>
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

function extension(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1, dot + 5).toUpperCase() : "FILE";
}

function FilesCard({ trade, files, onFile }: { trade: BulkTrade; files: TradeFile[]; onFile: (file: TradeFile) => void }) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uploaded = new Set(files.map((file) => file.file_type));
  const stillNeeded = REQUIRED_FILES.filter((file) => !uploaded.has(file.type)).map((file) => file.label.toLowerCase());

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
    <Card label="Files" className="overflow-hidden">
      <header className="flex flex-wrap items-center gap-3 border-b px-5 py-4" style={{ borderColor: "var(--bt-column)" }}>
        <h2 className="text-base font-semibold">Files</h2>
        <span className="text-[13px]" style={{ color: "var(--bt-muted)" }}>Stored privately. Buyers see a new file at Never until you change it.</span>
        <span className="flex-1" />
        <button type="button" className={buttonClass} style={buttonStyle} onClick={() => setUploading(true)}>Upload</button>
      </header>
      <div className="overflow-x-auto">
        <div className="min-w-[760px]">
          <div className={`grid ${FILE_COLUMNS} gap-4 border-b px-5 py-2.5 text-xs font-semibold`} style={tableHead}>
            <span>File</span><span>Type</span><span>Source</span><span>Buyers see at</span>
          </div>
          {files.map((file) => (
            <div key={file.id} className={`grid ${FILE_COLUMNS} items-center gap-4 border-b px-5 py-3`} style={{ borderColor: "var(--bt-divider)" }}>
              <div className="flex min-w-0 items-center gap-3">
                <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold"
                  style={{ background: "var(--bt-divider)", color: "var(--bt-text-2)" }}>
                  {extension(file.file_name)}
                </span>
                <a href={tradeUrl(trade.id, `/files/${file.id}`)} className="truncate text-sm font-semibold hover:underline">{file.file_name}</a>
              </div>
              <span className="text-[13px]" style={{ color: "var(--bt-text-2)" }}>{file.file_type}</span>
              <span className="text-[13px]" style={{ color: "var(--bt-text-2)" }}>{sourceText(file) || "Uploaded"}</span>
              <select
                aria-label={`Who sees ${file.file_name}`}
                value={file.visibility}
                onChange={(event) => changeVisibility(file, event.target.value as Visibility)}
                className="h-[34px] rounded-lg border px-1.5 text-[13px]"
                style={inputStyle}
              >
                {VISIBILITIES.map((visibility) => <option key={visibility} value={visibility}>{VISIBILITY_LABEL[visibility]}</option>)}
              </select>
            </div>
          ))}
          {!files.length && <p className="px-5 py-5 text-sm" style={{ color: "var(--bt-muted)" }}>No files yet.</p>}
        </div>
      </div>
      <div className="px-5 py-3 text-[13px]" style={{ color: "var(--bt-muted)" }}>
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
      <FormField label="File (up to 50 MB)"><input ref={picker} type="file" required className="text-sm" /></FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Type">{form.select("file_type", FILE_TYPES)}</FormField>
        <FormField label="Source">{form.input("source_label", { placeholder: "Gmail · Fabio Papa" })}</FormField>
      </div>
      <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>Buyers see it at Never until you change it.</p>
      <ErrorText error={form.error} />
    </Modal>
  );
}
