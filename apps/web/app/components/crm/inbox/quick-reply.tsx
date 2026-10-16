"use client";

import { useEffect, useRef, useState } from "react";

/** Saves approved-copy candidates only. Sending is exclusively the CLI approval flow. */
export function QuickReply({ threadId, recipientName, onExpand }: { threadId: string; recipientName?: string | null; onExpand?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [body, setBody] = useState("");
  const [identity, setIdentity] = useState("alex");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {if (expanded) {textarea.current?.focus(); onExpand?.();}}, [expanded, onExpand]);
  async function createDraft() {
    setBusy(true); setError(null); setResult(null);
    try {
      const response = await fetch(`/api/mail/threads/${encodeURIComponent(threadId)}/draft`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body_text: body, identity }),
      });
      const payload = await response.json() as { id?: string; state?: string; error?: string; refused?: string };
      if (!response.ok) {throw new Error(payload.refused ?? payload.error ?? `HTTP ${response.status}`);}
      if (!payload.id || payload.state !== "draft") {throw new Error("The API did not confirm a saved draft.");}
      setResult(`Draft ${payload.id} created. Not sent. Approve and send through rebattery-mail.`);
      setBody("");
    } catch (failure) {setError(failure instanceof Error ? failure.message : "Could not create draft.");}
    finally {setBusy(false);}
  }
  if (!expanded) {return <button type="button" className="w-full rounded-xl border px-4 py-3 text-left text-sm" style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }} onClick={() => setExpanded(true)}>Create draft{recipientName ? ` to ${recipientName}` : " reply"}…</button>;}
  return <div className="rounded-xl border p-4" style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}>
    <div className="mb-2 flex items-center gap-3 text-sm"><span>To: {recipientName ?? "Thread counterparty"}</span><label>From <select aria-label="Draft identity" value={identity} onChange={(event) => setIdentity(event.target.value)} disabled={busy}>{["alex", "ari", "supply", "hello", "support", "enterprise"].map((key) => <option key={key}>{key}</option>)}</select></label></div>
    <textarea ref={textarea} aria-label="Draft reply" placeholder="Type a reply…" rows={6} value={body} onChange={(event) => setBody(event.target.value)} disabled={busy} className="w-full resize-none rounded border p-3 text-sm" style={{ background: "var(--color-bg)", borderColor: "var(--color-border)" }} />
    <p className="my-2 text-xs" style={{ color: "var(--color-text-muted)" }}>Creates a draft only. Sending requires named approval through the CLI.</p>
    {error && <p role="alert" className="text-sm">{error}</p>}{result && <p role="status" className="text-sm">{result}</p>}
    <div className="mt-3 flex gap-2"><button disabled={busy || !body.trim()} onClick={() => void createDraft()} className="rounded border px-3 py-2 text-sm disabled:opacity-50">{busy ? "Creating draft…" : "Create draft"}</button><button disabled={busy} onClick={() => {setExpanded(false); setBody(""); setError(null); setResult(null);}} className="px-3 py-2 text-sm">Discard</button></div>
  </div>;
}
