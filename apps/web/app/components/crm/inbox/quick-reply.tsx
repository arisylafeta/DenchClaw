"use client";

import { useEffect, useRef, useState } from "react";

/** POSIX shell quoting, including apostrophes, newlines and command substitutions. */
export function draftCommand(threadId: string, identity: string, recipient: string, subject: string, body: string): string {
  const args = ["--thread", threadId, "--identity", identity, "--to", recipient, "--subject", subject, "--body", body];
  return `rebattery-mail draft ${args.map((value, index) => index % 2 === 0 ? value : `'${value.replace(/'/g, `'"'"'`)}'`).join(" ")}`;
}

/** Prepares a command locally. This component never writes to the mail store. */
export function QuickReply({ threadId, recipientName, recipientEmail, subject, onExpand }: { threadId: string; recipientName?: string | null; recipientEmail: string | null; subject: string | null; onExpand?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [body, setBody] = useState("");
  const [identity, setIdentity] = useState("alex");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {if (expanded) {textarea.current?.focus(); onExpand?.();}}, [expanded, onExpand]);
  const command = recipientEmail && body.trim() ? draftCommand(threadId, identity, recipientEmail, subject ?? "", body) : "";
  async function copy() {
    setError(null); setResult(null);
    try {await navigator.clipboard.writeText(command); setResult("Command copied. No draft has been saved or sent.");}
    catch {setError("Clipboard unavailable. Select and copy the command below.");}
  }
  if (!expanded) {return <button type="button" className="w-full rounded-xl border px-4 py-3 text-left text-sm" style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }} onClick={() => setExpanded(true)}>Prepare draft{recipientName ? ` to ${recipientName}` : " reply"}…</button>;}
  return <div className="rounded-xl border p-4" style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}>
    <div className="mb-2 flex items-center gap-3 text-sm"><span>To: {recipientEmail ?? "No reply address available"}</span><label>From <select aria-label="Draft identity" value={identity} onChange={(event) => setIdentity(event.target.value)}>{["alex", "ari", "supply", "hello", "support", "enterprise"].map((key) => <option key={key}>{key}</option>)}</select></label></div>
    <textarea ref={textarea} aria-label="Draft reply" placeholder="Type a reply…" rows={6} value={body} onChange={(event) => {setBody(event.target.value); setResult(null);}} className="w-full resize-none rounded border p-3 text-sm" style={{ background: "var(--color-bg)", borderColor: "var(--color-border)" }} />
    <p className="my-2 text-xs" style={{ color: "var(--color-text-muted)" }}>Prepare this draft with rebattery-mail; approval and send happen in the CLI</p>
    {!recipientEmail && <p role="alert">No reply address is recorded. Prepare the recipient explicitly in the CLI.</p>}
    {command && <textarea aria-label="Draft CLI command" readOnly value={command} rows={4} className="w-full rounded border p-2 font-mono text-xs" />}
    {error && <p role="alert" className="text-sm">{error}</p>}{result && <p role="status" className="text-sm">{result}</p>}
    <div className="mt-3 flex gap-2"><button disabled={!command} onClick={() => void copy()} className="rounded border px-3 py-2 text-sm disabled:opacity-50">Copy</button><button onClick={() => {setExpanded(false); setBody(""); setError(null); setResult(null);}} className="px-3 py-2 text-sm">Discard</button></div>
  </div>;
}
