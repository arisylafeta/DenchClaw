"use client";

import { useEffect, useState } from "react";
import { Download, Paperclip } from "lucide-react";
import type { MailAttachment } from "@/lib/mail-attachments";

type State = { status: "loading" } | { status: "ready"; files: MailAttachment[] } | { status: "unavailable"; reason: string };

export function formatBytes(bytes: number | null) {
  if (bytes === null) { return ""; }
  if (bytes < 1024) { return `${bytes} B`; }
  if (bytes < 1024 * 1024) { return `${Math.round(bytes / 1024)} KB`; }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Files attached to one message, fetched live from Gmail. Each links to a download; inline images are left out. */
export function AttachmentStrip({ messageId }: { messageId: string }) {
  const [state, setState] = useState<State>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    void fetch(`/api/mail/messages/${encodeURIComponent(messageId)}/attachments`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as { attachments?: MailAttachment[]; unavailable?: string; error?: string };
        if (controller.signal.aborted) { return; }
        if (body.attachments) { setState({ status: "ready", files: body.attachments }); }
        else { setState({ status: "unavailable", reason: body.unavailable ?? body.error ?? `HTTP ${response.status}` }); }
      })
      .catch(() => { if (!controller.signal.aborted) { setState({ status: "unavailable", reason: "network" }); } });
    return () => controller.abort();
  }, [messageId]);
  if (state.status === "ready" && !state.files.length) { return null; }
  const chip = "inline-flex max-w-full items-center gap-2 rounded-lg border px-3 py-1.5 text-[12px]";
  const style = { background: "var(--color-surface)", borderColor: "var(--color-border)", color: "var(--color-text-muted)" };
  return <div className="mt-3 flex flex-wrap gap-2" aria-label="Attachments">
    {state.status === "loading" && <span className={chip} style={style}><Paperclip size={14} aria-hidden />Loading attachments…</span>}
    {state.status === "unavailable" && <span role="status" className={chip} style={style}><Paperclip size={14} aria-hidden />Attachments could not be loaded ({state.reason})</span>}
    {state.status === "ready" && state.files.map((file) => <a key={file.filename} className={`${chip} hover:bg-[var(--color-surface-hover)]`} style={{ ...style, color: "var(--color-text)" }}
      href={`/api/mail/messages/${encodeURIComponent(messageId)}/attachments/download?name=${encodeURIComponent(file.filename)}`} download={file.filename} title={`Download ${file.filename}`}>
      <Paperclip size={14} aria-hidden style={{ color: "var(--color-text-muted)" }} />
      <span className="truncate">{file.filename}</span>
      {file.sizeBytes !== null && <span className="shrink-0 text-[11px]" style={{ color: "var(--color-text-muted)" }}>{formatBytes(file.sizeBytes)}</span>}
      <Download size={13} aria-hidden className="shrink-0" style={{ color: "var(--color-text-muted)" }} />
    </a>)}
  </div>;
}
