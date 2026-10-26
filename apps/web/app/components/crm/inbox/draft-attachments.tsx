"use client";

import { useState } from "react";
import { Download, File, FileSpreadsheet, FileText, Paperclip } from "lucide-react";
import type { DraftAttachment } from "@/lib/mail-types";
import { formatBytes } from "./attachment-strip";

const GMAIL_LIMIT = 25 * 1024 * 1024;
const COLLAPSED = 12;
const IMAGE = /^image\/(jpeg|png|webp|gif)$/;

/** Problems that would stop or change the send, shown with the files and again in the confirmation. */
export function attachmentIssues(files: DraftAttachment[], transport: string | null): string[] {
  if (!files.length) { return []; }
  const issues: string[] = [];
  if (transport?.startsWith("postmark")) { issues.push("This mail goes through Postmark, which refuses attachments."); }
  const total = files.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0);
  if (total > GMAIL_LIMIT) { issues.push(`The files add up to ${formatBytes(total)}, over Gmail's 25 MB limit.`); }
  return issues;
}

const fileUrl = (draftId: string, file: DraftAttachment) => `/api/mail/drafts/${encodeURIComponent(draftId)}/attachments/${file.sha256}`;

function Thumb({ draftId, file }: { draftId: string; file: DraftAttachment }) {
  const [failed, setFailed] = useState(false);
  const box = "flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md";
  if (file.mediaType && IMAGE.test(file.mediaType) && !failed) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={`${fileUrl(draftId, file)}?inline=1`} alt="" loading="lazy" onError={() => setFailed(true)} className={`${box} object-cover`} />;
  }
  const Icon = /csv|sheet|excel/.test(file.mediaType ?? "") || /\.(csv|xlsx?)$/i.test(file.filename) ? FileSpreadsheet : /pdf|text|word/.test(file.mediaType ?? "") || /\.(pdf|docx?|txt)$/i.test(file.filename) ? FileText : File;
  return <span className={box} style={{ background: "var(--color-surface-hover)", color: "var(--color-text-muted)" }}><Icon className="size-5" aria-hidden /></span>;
}

/** Files stored with an unsent draft: a small preview, the name and size, and a click that downloads. */
export function DraftAttachments({ draftId, files, transport }: { draftId: string; files: DraftAttachment[]; transport: string | null }) {
  const [all, setAll] = useState(false);
  if (!files.length) { return null; }
  const shown = all ? files : files.slice(0, COLLAPSED);
  const total = files.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0);
  const issues = attachmentIssues(files, transport);
  return (
    <section aria-label="Attachments" className="mb-5">
      <p className="mb-2 inline-flex items-center gap-1.5 text-[12px] font-medium" style={{ color: "var(--color-text-muted)" }}>
        <Paperclip className="size-3.5" aria-hidden />{files.length} {files.length === 1 ? "attachment" : "attachments"}{total ? ` · ${formatBytes(total)}` : ""}
      </p>
      <ul className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(210px,1fr))]">
        {shown.map((file) => (
          <li key={file.sha256}>
            <a href={fileUrl(draftId, file)} download={file.filename} title={`Download ${file.filename}`}
              className="group flex items-center gap-2.5 rounded-lg border p-2 text-[12px] transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
              style={{ borderColor: "var(--color-border)", background: "var(--color-main-bg)", color: "var(--color-text)" }}>
              <Thumb draftId={draftId} file={file} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{file.filename}</span>
                {file.sizeBytes !== null && <span className="block text-[11px]" style={{ color: "var(--color-text-muted)" }}>{formatBytes(file.sizeBytes)}</span>}
              </span>
              <Download className="size-3.5 shrink-0 opacity-50 group-hover:opacity-100" aria-hidden />
            </a>
          </li>
        ))}
      </ul>
      {files.length > COLLAPSED && <button type="button" onClick={() => setAll((v) => !v)} className="mt-2 text-[12px] underline" style={{ color: "var(--color-text-muted)" }}>{all ? "Show fewer" : `Show all ${files.length}`}</button>}
      {issues.length > 0 && <ul role="status" className="mt-2 space-y-0.5 text-[12px]" style={{ color: "var(--color-warning)" }}>{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
    </section>
  );
}
