"use client";

import { Fragment, useRef, useState } from "react";
import type { BulkTrade, TradePatch } from "@/lib/bulk-trades";
import tableStyles from "../ui/data-table.module.css";
import { TableCellContent } from "../ui/table-cell";
import {
  FIELD_STATUSES,
  FIELD_TEMPLATES,
  FILE_TYPES,
  REQUIRED_FILES,
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
import { ProposalRow } from "./proposal-row";
import { FileLink, FileThumb, fileUrl } from "./file-preview";

const FIELD_COLUMNS = "grid-cols-[200px_minmax(0,1fr)_250px_110px_110px]";
const FILE_COLUMNS = "grid-cols-[minmax(0,1fr)_130px_250px_170px]";

const STATUS_LABEL: Record<FieldStatus, string> = {
  confirmed: "Confirmed", unverified: "Unverified", conflict: "Conflict", missing: "Missing",
};
const STATUS_STYLE: Record<FieldStatus, React.CSSProperties> = {
  confirmed: { background: "var(--bt-green-bg)", color: "var(--bt-green)", border: "1px solid var(--bt-green-border)" },
  unverified: { background: "var(--bt-divider)", color: "var(--bt-text-2)", border: "1px solid var(--bt-grey-border)" },
  conflict: { background: "var(--bt-amber-bg)", color: "var(--bt-amber)", border: "1px solid var(--bt-amber-border)" },
  missing: { background: "var(--bt-red-bg)", color: "var(--bt-red)", border: "1px solid var(--bt-red-border)" },
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

function Source({ source }: { source: FieldSource }) {
  const text = sourceText(source);
  if (!text) return <span style={{ color: "var(--bt-muted)" }}>—</span>;
  return source.source_url
    ? <a href={source.source_url} target="_blank" rel="noreferrer" className="hover:underline" style={{ color: "var(--bt-link)" }}>{text}</a>
    : <span style={{ color: "var(--bt-link)" }}>{text}</span>;
}

const clip = (text: string, length = 28) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

export function TradeData({ detail, onField, onFile, onTradePatch, onProposalDecided }: Props) {
  const proposals = detail.proposals ?? [];
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
      <FieldsCard trade={trade} kind={trade.trade_kind} fields={detail.fields} onField={onField}
        proposals={proposals.filter((proposal) => proposal.kind === "field")} onProposalDecided={onProposalDecided} />
      <FilesCard trade={trade} files={detail.files} onFile={onFile}
        proposals={proposals.filter((proposal) => proposal.kind === "file")} onProposalDecided={onProposalDecided} />
    </div>
  );
}

function FieldsCard({ trade, kind, fields, onField, proposals, onProposalDecided }: {
  trade: BulkTrade;
  kind: NonNullable<BulkTrade["trade_kind"]>;
  fields: TradeField[];
  onField: (field: TradeField) => void;
  proposals: Proposal[];
  onProposalDecided: () => void;
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
    <Card label="Data" className={`bulk-trades ${tableStyles.surface} overflow-hidden`}>
      <header data-table-part="toolbar" className="flex flex-wrap items-center gap-3 border-b px-5 py-4" style={{ borderColor: "var(--bt-column)" }}>
        <h2 className="text-base font-semibold">Data</h2>
        <span className="text-[13px]" style={{ color: "var(--bt-muted)" }}>Click a row to fill it in or change who sees it</span>
        <span className="flex-1" />
        <span className="text-[13px]" style={{ color: "var(--bt-muted)" }}>Private to ReBattery unless marked</span>
      </header>
      <div className="overflow-x-auto">
        <div className="min-w-[860px]">
          <div data-table-part="grid-header" className={`grid ${FIELD_COLUMNS} gap-4 border-b px-3 py-2 font-medium`} style={tableHead}>
            <span>Field</span><span>Value</span><span>Source</span><span>Status</span><span>Buyers see at</span>
          </div>
          {templates.map((template) => {
            const row = byKey.get(template.key);
            const status: FieldStatus = row && row.value?.trim() ? row.status : row?.status === "conflict" ? "conflict" : "missing";
            const claims: FieldSource[] = row ? [row, ...row.alternatives] : [];
            return (
              <Fragment key={template.key}>
              <div
                data-table-part="grid-row"
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
                    event.preventDefault();
                    setEditing(template);
                  }
                }}
                onClick={() => setEditing(template)}
                aria-label={`Edit ${template.label}`}
                className={`grid w-full ${FIELD_COLUMNS} items-start gap-4 border-b px-3 py-2 text-left text-xs hover:bg-[var(--bt-row-hover)]`}
                style={{ borderColor: "var(--bt-divider)", background: status === "conflict" ? "var(--bt-amber-tint)" : undefined }}
              >
                <TableCellContent><span style={{ color: "var(--bt-text-2)" }}>{template.label}</span></TableCellContent>
                <TableCellContent>
                <span className="flex flex-col font-medium leading-[1.4]">
                  {claims.length ? claims.map((claim, index) => <span key={index}>{claim.value || "—"}</span>) : <span>—</span>}
                </span>
                </TableCellContent>
                <TableCellContent>
                <span className="flex flex-col text-xs leading-[1.4]">
                  {claims.length ? claims.map((claim, index) => <Source key={index} source={claim} />) : <Source source={{ value: "", source_label: null, source_url: null, source_date: null }} />}
                </span>
                </TableCellContent>
                <TableCellContent><span><span className="rounded-none px-2 py-0.5 text-xs font-semibold" style={STATUS_STYLE[status]}>{STATUS_LABEL[status]}</span></span></TableCellContent>
                <TableCellContent><span className="text-xs" style={{ color: "var(--bt-text-2)" }}>{VISIBILITY_LABEL[row?.visibility ?? template.visibility]}</span></TableCellContent>
              </div>
              {proposals.filter((proposal) => proposal.target === template.key).map((proposal) => (
                <div key={proposal.id} className="border-b" style={{ borderColor: "var(--bt-divider)" }}>
                  <ProposalRow proposal={{ ...proposal, summary: `${template.label}: ${String(proposal.proposed.value)}` }} onDecided={onProposalDecided} />
                </div>
              ))}
              </Fragment>
            );
          })}
        </div>
      </div>
      {conflicts.map(({ template, row }) => (
        <div key={template.key} className="flex flex-wrap items-center gap-2.5 border-t px-5 py-3" style={{ background: "var(--bt-table-head)", borderColor: "var(--bt-divider)" }}>
          <span className="rounded-none px-[7px] py-0.5 text-[11px] font-semibold uppercase" style={STATUS_STYLE.conflict}>Conflict</span>
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

function FilesCard({ trade, files, onFile, proposals, onProposalDecided }: {
  trade: BulkTrade;
  files: TradeFile[];
  onFile: (file: TradeFile) => void;
  proposals: Proposal[];
  onProposalDecided: () => void;
}) {
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
      <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>Buyers see it at Never until you change it.</p>
      <ErrorText error={form.error} />
    </Modal>
  );
}
