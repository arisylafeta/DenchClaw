"use client";

import { useEffect, useState } from "react";
import { Check, Download, Paperclip } from "lucide-react";
import type { MailAttachment } from "@/lib/mail-attachments";

type State = { status: "loading" } | { status: "ready"; files: MailAttachment[] } | { status: "unavailable"; reason: string };
type Saved = { status: "saving" } | { status: "saved"; url: string; converted: boolean } | { status: "failed"; message: string };

export function formatBytes(bytes: number | null) {
  if (bytes === null) { return ""; }
  if (bytes < 1024) { return `${bytes} B`; }
  if (bytes < 1024 * 1024) { return `${Math.round(bytes / 1024)} KB`; }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const DriveLogo = () => (
  <svg width="14" height="14" viewBox="0 0 87.3 78" aria-hidden="true">
    <path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3L27.5 53H0c0 1.55.4 3.1 1.2 4.5z" fill="#0066da" />
    <path d="M43.65 25 29.9 1.2c-1.35.8-2.5 1.9-3.3 3.3L1.2 48.5A9.06 9.06 0 0 0 0 53h27.5z" fill="#00ac47" />
    <path d="M73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5H59.8l5.85 11.5z" fill="#ea4335" />
    <path d="M43.65 25 57.4 1.2C56.05.4 54.5 0 52.9 0H34.4c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d" />
    <path d="M59.8 53H27.5L13.75 76.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc" />
    <path d="M73.4 26.5 60.7 4.5c-.8-1.4-1.95-2.5-3.3-3.3L43.65 25 59.8 53h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00" />
  </svg>
);

/** Connect Google Drive once: Google's consent page opens in a new tab; its final address is pasted back here. */
function ConnectDrive({ onConnected, onCancel }: { onConnected: () => void; onCancel: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const post = async (body: unknown) => {
    const response = await fetch("/api/mail/drive-connect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({})) as { url?: string; connected?: boolean; message?: string };
    if (!response.ok) { throw new Error(data.message ?? "Something went wrong. Try again."); }
    return data;
  };
  const start = async () => {
    setBusy(true); setError(null);
    try { const data = await post({}); setUrl(data.url ?? null); if (data.url) { window.open(data.url, "_blank", "noopener"); } }
    catch (err) { setError(err instanceof Error ? err.message : "Couldn't start."); } finally { setBusy(false); }
  };
  const finish = async () => {
    setBusy(true); setError(null);
    try { await post({ redirect_url: pasted }); onConnected(); }
    catch (err) { setError(err instanceof Error ? err.message : "Couldn't connect."); } finally { setBusy(false); }
  };
  const box = { background: "var(--color-surface)", borderColor: "var(--color-border)" };
  const btn = "rounded-md border px-2.5 py-1 text-[12px] font-medium hover:bg-[var(--color-surface-hover)] disabled:opacity-50";
  return <div role="dialog" aria-label="Connect Google Drive" className="mt-2 w-full max-w-xl rounded-lg border p-3 text-[12.5px]" style={box}>
    <p className="font-medium" style={{ color: "var(--color-text)" }}>Connect Google Drive (once)</p>
    {!url ? <>
      <p className="mt-1" style={{ color: "var(--color-text-muted)" }}>Google asks you to approve Drive for this account. Your Gmail access stays as it is.</p>
      <div className="mt-2 flex gap-2"><button type="button" className={btn} style={box} disabled={busy} onClick={() => void start()}>{busy ? "Opening…" : "Open Google"}</button><button type="button" className={btn} style={{ ...box, borderColor: "transparent" }} onClick={onCancel}>Cancel</button></div>
    </> : <>
      <p className="mt-1" style={{ color: "var(--color-text-muted)" }}>Approve in the Google tab (<a className="underline" href={url} target="_blank" rel="noopener noreferrer">open it again</a>). It then shows a page that won&apos;t load: copy that tab&apos;s whole address and paste it here.</p>
      <div className="mt-2 flex gap-2">
        <input className="min-w-0 flex-1 rounded-md border px-2 py-1 text-[12px]" style={box} placeholder="http://127.0.0.1:…/oauth2/callback?…" aria-label="Address from the Google tab" value={pasted} onChange={(e) => setPasted(e.target.value)} autoComplete="off" spellCheck={false} />
        <button type="button" className={btn} style={box} disabled={busy || !pasted.trim()} onClick={() => void finish()}>{busy ? "Connecting…" : "Connect"}</button>
        <button type="button" className={btn} style={{ ...box, borderColor: "transparent" }} onClick={onCancel}>Cancel</button>
      </div>
    </>}
    {error && <p role="alert" className="mt-2" style={{ color: "var(--color-warning)" }}>{error}</p>}
  </div>;
}

/** Files attached to one message, fetched live from Gmail: download, or save to Google Drive (Office files open as Docs/Sheets/Slides). */
export function AttachmentStrip({ messageId }: { messageId: string }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [saved, setSaved] = useState<Record<string, Saved>>({});
  const [connectFor, setConnectFor] = useState<string | null>(null);
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
  const toDrive = async (filename: string) => {
    setSaved((m) => ({ ...m, [filename]: { status: "saving" } }));
    try {
      const response = await fetch(`/api/mail/messages/${encodeURIComponent(messageId)}/attachments/drive`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: filename }) });
      const body = await response.json().catch(() => ({})) as { url?: string; converted?: boolean; error?: string; message?: string };
      if (response.status === 409 && body.error === "drive_not_connected") {
        setSaved((m) => { const next = { ...m }; delete next[filename]; return next; });
        setConnectFor(filename);
        return;
      }
      if (!response.ok || !body.url) { throw new Error(body.message ?? "Couldn't save to Drive."); }
      setSaved((m) => ({ ...m, [filename]: { status: "saved", url: body.url!, converted: !!body.converted } }));
      window.open(body.url, "_blank", "noopener");
    } catch (err) {
      setSaved((m) => ({ ...m, [filename]: { status: "failed", message: err instanceof Error ? err.message : "Couldn't save to Drive." } }));
    }
  };
  if (state.status === "ready" && !state.files.length) { return null; }
  const chip = "inline-flex max-w-full items-center gap-1 rounded-lg border pl-3 pr-1 py-1 text-[12px]";
  const style = { background: "var(--color-surface)", borderColor: "var(--color-border)", color: "var(--color-text-muted)" };
  const icon = "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md hover:bg-[var(--color-surface-hover)] disabled:opacity-50";
  return <div className="mt-3 flex flex-wrap gap-2" aria-label="Attachments">
    {state.status === "loading" && <span className={`${chip} pr-3`} style={style}><Paperclip size={14} aria-hidden />Loading attachments…</span>}
    {state.status === "unavailable" && <span role="status" className={`${chip} pr-3`} style={style}><Paperclip size={14} aria-hidden />Attachments could not be loaded ({state.reason})</span>}
    {state.status === "ready" && state.files.map((file) => {
      const s = saved[file.filename];
      return <span key={file.filename} className={chip} style={{ ...style, color: "var(--color-text)" }}>
        <Paperclip size={14} aria-hidden style={{ color: "var(--color-text-muted)" }} />
        <span className="ml-1 truncate">{file.filename}</span>
        {file.sizeBytes !== null && <span className="ml-1 shrink-0 text-[11px]" style={{ color: "var(--color-text-muted)" }}>{formatBytes(file.sizeBytes)}</span>}
        {s?.status === "saved"
          ? <a className={`${icon} ml-1`} href={s.url} target="_blank" rel="noopener noreferrer" title={`Saved to Drive · open${s.converted ? " in Google" : ""}`} aria-label={`Open ${file.filename} in Drive`}><Check size={14} style={{ color: "var(--color-success, #16a34a)" }} /></a>
          : <button type="button" className={`${icon} ml-1`} disabled={s?.status === "saving"} onClick={() => void toDrive(file.filename)} title={s?.status === "failed" ? s.message : s?.status === "saving" ? "Saving to Drive…" : "Save to Google Drive"} aria-label={`Save ${file.filename} to Google Drive`}>
            {s?.status === "saving" ? <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden /> : <DriveLogo />}
          </button>}
        <a className={icon} href={`/api/mail/messages/${encodeURIComponent(messageId)}/attachments/download?name=${encodeURIComponent(file.filename)}`} download={file.filename} title={`Download ${file.filename}`} aria-label={`Download ${file.filename}`}>
          <Download size={13} aria-hidden style={{ color: "var(--color-text-muted)" }} />
        </a>
      </span>;
    })}
    {Object.entries(saved).filter(([, s]) => s.status === "failed").map(([name, s]) => <span key={name} role="alert" className="w-full text-[12px]" style={{ color: "var(--color-warning)" }}>{name}: {(s as { message: string }).message}</span>)}
    {connectFor && <ConnectDrive onCancel={() => setConnectFor(null)} onConnected={() => { const name = connectFor; setConnectFor(null); void toDrive(name); }} />}
  </div>;
}
