"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { Check, Download } from "lucide-react";
import { ConnectDrive, DriveLogo } from "../crm/inbox/attachment-strip";

type DriveState = { status: "idle" | "saving" | "connect" } | { status: "saved"; url: string; converted: boolean } | { status: "failed"; message: string };

const iconButton = "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-[var(--color-surface-hover)] disabled:opacity-50";

/** Download and Open in Google for a workspace file. Drive uploads go to the signed-in user's own Drive; Office files
 * become Google Docs, Sheets or Slides. The Connect step shows once, below the toolbar. */
export function FileShareButtons({ url, filePath, filename, dirty = false }: { url: string; filePath: string; filename: string; dirty?: boolean }) {
  const [drive, setDrive] = useState<DriveState>({ status: "idle" });
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  async function toDrive() {
    setDrive({ status: "saving" });
    try {
      const response = await fetch("/api/workspace/drive", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: filePath }) });
      const body = await response.json().catch(() => ({})) as { url?: string; converted?: boolean; error?: string; message?: string };
      if (response.status === 409 && body.error === "drive_not_connected") { setDrive({ status: "connect" }); return; }
      if (!response.ok || !body.url) throw new Error(body.message ?? "Couldn't save to Drive.");
      setDrive({ status: "saved", url: body.url, converted: !!body.converted });
      window.open(body.url, "_blank", "noopener,noreferrer");
    } catch (err) { setDrive({ status: "failed", message: err instanceof Error ? err.message : "Couldn't save to Drive." }); }
  }
  const unsaved = dirty ? " (last saved version)" : "";
  return (
    <span ref={setAnchor} className="relative inline-flex items-center gap-0.5" style={{ color: "var(--color-text-muted)" }}>
      <a className={iconButton} href={url} download={filename} title={`Download${unsaved}`} aria-label={`Download ${filename}`}><Download size={14} aria-hidden="true" /></a>
      {drive.status === "saved"
        ? <a className={iconButton} href={drive.url} target="_blank" rel="noopener noreferrer" title={`Saved to Google Drive${drive.converted ? " as a Google file" : ""}. Open it`} aria-label={`Open ${filename} in Google`}><Check size={14} aria-hidden="true" /></a>
        : <button type="button" className={iconButton} disabled={drive.status === "saving"} title={drive.status === "failed" ? drive.message : `Open in Google Sheets / Docs${unsaved}`}
            aria-label={`Open ${filename} in Google Drive`} onClick={() => void toDrive()}>
            {drive.status === "saving" ? <span className="block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" /> : <DriveLogo />}
          </button>}
      {drive.status === "failed" && <span role="alert" className="sr-only">{drive.message}</span>}
      {drive.status === "connect" && anchor && createPortal(
        <div className="fixed z-50" style={{ top: anchor.getBoundingClientRect().bottom + 6, right: Math.max(8, window.innerWidth - anchor.getBoundingClientRect().right), width: "min(36rem, calc(100vw - 16px))" }}>
          <ConnectDrive onCancel={() => setDrive({ status: "idle" })} onConnected={() => void toDrive()} />
        </div>, document.body)}
    </span>
  );
}
