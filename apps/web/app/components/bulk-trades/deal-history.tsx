"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Mail, MessageCircle } from "lucide-react";
import type { HistoryMessage } from "@/lib/deal-history-core";
import type { Mention } from "@/lib/bulk-today";
import { mentionsIn } from "@/lib/bulk-today";
import { ShBlock } from "./bt-shimmer";
import { ErrorText, request } from "./trade-ui";

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });

/** Team notes on the deal. "@Sean" (or Alex, Ari) puts the note on that person's Today until they tick it. Nobody is emailed. */
export function TeamNotes({ listingId }: { listingId: string }) {
  const [notes, setNotes] = useState<Mention[] | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endpoint = `/api/bulk-listings/${encodeURIComponent(listingId)}/notes`;
  const load = useCallback(async () => {
    try { const r = await request<{ notes?: Mention[] }>(endpoint); setNotes(Array.isArray(r.notes) ? r.notes : []); }
    catch (err) { setNotes([]); setError(err instanceof Error ? err.message : "Could not load notes."); }
  }, [endpoint]);
  useEffect(() => { void load(); }, [load]);
  const mentions = mentionsIn(text);
  const add = async () => {
    setBusy(true); setError(null);
    try { await request(endpoint, { method: "POST", body: JSON.stringify({ text }) }); setText(""); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not save the note."); }
    finally { setBusy(false); }
  };
  return (
    <section aria-label="Team notes" className="flex flex-col gap-2">
      <h3 className="text-[13px] font-semibold">Team notes</h3>
      <form className="flex flex-col gap-1.5" onSubmit={(event) => { event.preventDefault(); if (text.trim()) void add(); }}>
        <textarea rows={2} value={text} onChange={(event) => setText(event.target.value)} aria-label="Team note"
          placeholder="A note for the team. Write @Alex, @Sean or @Ari to put it on their Today."
          className="w-full rounded-lg border px-3 py-2 text-[13px]" style={{ borderColor: "var(--bt-border)", background: "var(--bt-surface)" }} />
        <span className="flex items-center justify-between gap-2 text-[12px]" style={{ color: "var(--bt-muted)" }}>
          <span>{mentions.length ? `Shows on ${mentions.join(" and ")}'s Today until they tick it. No email is sent.` : "No one is mentioned."}</span>
          <button type="submit" disabled={busy || !text.trim()} className="h-8 rounded-lg border px-3 text-[12px] font-medium" style={{ borderColor: "var(--bt-border)", color: "var(--bt-text)" }}>{busy ? "Saving…" : "Add note"}</button>
        </span>
      </form>
      <ErrorText error={error} />
      {notes === null ? <ShBlock on size={3} /> : notes.length > 0 && (
        <ul className="flex flex-col gap-2">
          {notes.map((note) => (
            <li key={note.id} className="rounded-lg border px-3 py-2 text-[13px]" style={{ borderColor: "var(--bt-divider)" }}>
              <p className="whitespace-pre-wrap">{note.text}</p>
              <p className="mt-1 text-[12px]" style={{ color: "var(--bt-muted)" }}>
                {note.by ? `${note.by.split("@")[0]} · ` : ""}{when(note.at)}
                {note.mentions.map((person) => <span key={person}> · @{person} {note.ticked[person] ? "done" : "open"}</span>)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** One readable history: every email on the deal's linked threads and every message in its linked WhatsApp chats, oldest first. */
export function DealConversation({ listingId }: { listingId: string }) {
  const [messages, setMessages] = useState<HistoryMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setMessages(null);
    request<{ messages?: HistoryMessage[] }>(`/api/bulk-listings/${encodeURIComponent(listingId)}/history`)
      .then((r) => { if (live) setMessages(Array.isArray(r.messages) ? r.messages : []); })
      .catch((err) => { if (live) { setMessages([]); setError(err instanceof Error ? err.message : "Could not load the conversation."); } });
    return () => { live = false; };
  }, [listingId]);
  return (
    <section aria-label="Conversation" className="flex flex-col gap-2">
      <h3 className="text-[13px] font-semibold">Conversation <span className="font-normal" style={{ color: "var(--bt-muted)" }}>email and WhatsApp linked to this deal, oldest first</span></h3>
      <ErrorText error={error} />
      {messages === null ? <ShBlock on size={6} /> : !messages.length ? (
        <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>No email or WhatsApp is linked to this deal yet.</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {messages.map((m) => {
            const Icon = m.channel === "whatsapp" ? MessageCircle : Mail;
            return (
              <li key={m.id} data-history-channel={m.channel} className="rounded-lg border px-3 py-2 text-[13px]"
                style={{ borderColor: "var(--bt-divider)", background: m.direction === "outbound" ? "var(--bt-segment)" : "var(--bt-surface)" }}>
                <p className="flex items-center gap-1.5 text-[12px]" style={{ color: "var(--bt-muted)" }}>
                  <Icon size={12} aria-hidden />
                  <b style={{ color: "var(--bt-text)" }}>{m.from}</b><span>· {when(m.at)}</span>
                  {m.subject && <span className="min-w-0 truncate">· {m.subject}</span>}
                  {m.href && <a href={m.href} className="ml-auto inline-flex items-center gap-1 hover:underline" aria-label={`Open the ${m.channel === "whatsapp" ? "chat" : "email thread"}`}><ExternalLink size={11} aria-hidden />Open</a>}
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words">{m.text || "(no text)"}</p>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
