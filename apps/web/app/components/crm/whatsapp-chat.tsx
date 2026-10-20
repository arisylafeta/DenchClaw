"use client";
import { Fragment, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Clock, FileText, Image as ImageIcon, Mic, Paperclip, Users } from "lucide-react";
import type { WhatsappConversationData, WhatsappMessage } from "@/lib/crm-postgres/whatsapp";
import { initialsOf, whatsappChatLabel } from "@/lib/whatsapp-display";
import { WhatsappTradeLinks } from "./whatsapp-trade-links";

const pageSize = 50;
const RUN_GAP_MS = 5 * 60 * 1000;
const muted = { color: "var(--color-text-muted)" } as const;
const border = { borderColor: "var(--color-border)" } as const;

const dayLabel = (d: Date) => {
  const today = new Date(); const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86_400_000);
  if (diff === 0) { return "Today"; }
  if (diff === 1) { return "Yesterday"; }
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
};
const clock = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const whenOf = (m: WhatsappMessage) => new Date(m.occurred_at || m.captured_at);

type Run = { key: string; day: string; newDay: boolean; outbound: boolean; sender: string | null; messages: WhatsappMessage[] };

function senderOf(m: WhatsappMessage) {
  if (m.direction === "outbound") { return "Our account"; }
  return m.sender_person_name || (m.sender_name ? `${m.sender_name} (unconfirmed sender)` : "Unknown sender");
}

/** Consecutive messages from the same side within five minutes share one run, so the sender is named once. */
export function groupRuns(messages: WhatsappMessage[]): Run[] {
  const runs: Run[] = [];
  for (const m of messages) {
    const at = whenOf(m); const day = at.toDateString(); const outbound = m.direction === "outbound"; const sender = senderOf(m);
    const last = runs.at(-1); const prev = last?.messages.at(-1);
    if (last && prev && last.day === day && last.outbound === outbound && last.sender === sender && at.getTime() - whenOf(prev).getTime() < RUN_GAP_MS) { last.messages.push(m); continue; }
    runs.push({ key: m.id, day, newDay: !last || last.day !== day, outbound, sender, messages: [m] });
  }
  return runs;
}

function attachmentLabel(att: Record<string, unknown>) {
  const raw = String(att.type ?? att.mimetype ?? "media").toLowerCase();
  const kind = raw.startsWith("image") ? "image" : raw.startsWith("audio") || raw.includes("ptt") ? "audio" : raw.startsWith("video") ? "video" : raw.includes("pdf") || raw.includes("document") ? "document" : raw;
  return { kind, Icon: kind === "image" ? ImageIcon : kind === "audio" ? Mic : kind === "document" ? FileText : Paperclip };
}

function Bubble({ m, outbound, first, last, threadId }: { m: WhatsappMessage; outbound: boolean; first: boolean; last: boolean; threadId: string }) {
  const at = whenOf(m);
  const tombstone = Boolean(m.deleted_at);
  const att = !tombstone && m.attachment ? attachmentLabel(m.attachment) : null;
  return <div id={`message-${m.id}`} className={`flex ${outbound ? "justify-end" : "justify-start"} ${first ? "mt-3" : "mt-0.5"}`}>
    <article className="w-fit min-w-[84px] max-w-[min(88%,640px)] border px-3 py-1.5 sm:max-w-[min(78%,640px)]"
      style={{ ...border, borderRadius: `${first ? 14 : 6}px ${first ? 14 : 6}px ${outbound ? (last ? 14 : 6) : 14}px ${outbound ? 14 : (last ? 14 : 6)}px`,
        background: outbound ? "color-mix(in srgb, var(--color-accent-fill) 22%, var(--color-surface))" : "var(--color-surface)", opacity: tombstone ? 0.85 : 1 }}>
      {m.reply_to_provider_id && <blockquote className="mb-1.5 border-l-2 px-2 py-0.5 text-[12px] leading-[18px]" style={{ borderColor: "var(--color-accent)", ...muted }}>
        <span className="line-clamp-2">{m.reply_body || "Reply to an unavailable or removed message"}</span>
        {m.reply_to_message_id && <a className="underline" href={`#message-${m.reply_to_message_id}`}>Reply target</a>}
      </blockquote>}
      {tombstone
        ? <p className="text-[13px] italic" style={muted}>Message deleted</p>
        : <p className="whitespace-pre-wrap text-[14px] leading-[21px] [overflow-wrap:anywhere]" style={{ color: "var(--color-text)" }}>{m.body || (att ? "" : "Content unavailable")}</p>}
      {att && <p className="mt-1 inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px]" style={{ ...border, ...muted }}><att.Icon size={13} aria-hidden />{att.kind} · content not downloaded</p>}
      <div className="mt-0.5 flex items-center justify-end gap-2 text-[11px] tabular-nums" style={muted}>
        {m.edit_version > 0 && <span>Edited</span>}
        <time dateTime={at.toISOString()} title={`${at.toLocaleString("en-GB")}${m.timestamp_source === "capture" ? " · capture time, not sent time" : ""}`}>{clock(at)}{m.timestamp_source === "capture" ? "*" : ""}</time>
      </div>
      <WhatsappTradeLinks threadId={threadId} messageId={m.id} />
    </article>
  </div>;
}

export function WhatsappConversation({ id }: { id: string }) {
  const [data, setData] = useState<WhatsappConversationData | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    fetch(`/api/whatsapp/threads/${encodeURIComponent(id)}?limit=${pageSize}&offset=${offset}`, { signal: controller.signal })
      .then(async (r) => { if (!r.ok) { throw new Error(r.status === 404 ? "Chat not found" : "Could not load conversation"); } setData(await r.json()); })
      .catch((e) => { if (e.name !== "AbortError") { setError(e.message); } })
      .finally(() => { if (!controller.signal.aborted) { setLoading(false); } });
    return () => controller.abort();
  }, [id, offset]);
  const thread = data?.thread;
  const label = whatsappChatLabel({ id, kind: thread?.kind ?? "direct", name: thread?.name ?? thread?.subject, name_source: thread?.name_source });
  const runs = useMemo(() => groupRuns(data?.messages ?? []), [data]);
  const expiryUnavailable = data?.messages.some((m) => m.metadata.expiry_policy_unavailable === true);
  const status = data?.capture_status;
  const Pager = ({ where }: { where: "top" | "bottom" }) => (offset > 0 || (data && data.messages.length >= pageSize)) ? <div className={`flex items-center justify-between py-2 ${where === "top" ? "" : "pt-4"}`}>
    <button type="button" className="rounded-md border px-3 py-1.5 text-[13px] disabled:opacity-40 hover:bg-[var(--color-surface-hover)]" style={border} disabled={!offset || loading} onClick={() => setOffset(Math.max(0, offset - pageSize))}>Earlier messages</button>
    <button type="button" className="rounded-md border px-3 py-1.5 text-[13px] disabled:opacity-40 hover:bg-[var(--color-surface-hover)]" style={border} disabled={!data || data.messages.length < pageSize || loading} onClick={() => setOffset(offset + pageSize)}>Later messages</button>
  </div> : null;
  return <main className="mx-auto flex min-h-screen max-w-[920px] flex-col" style={{ background: "var(--color-surface)", color: "var(--color-text)" }}>
    <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b px-5 py-3" style={{ ...border, background: "var(--color-surface)" }}>
      <a href="/?crm=inbox&view=whatsapp" aria-label="Back to Inbox" className="inline-flex h-8 w-8 items-center justify-center rounded-full hover:bg-[var(--color-surface-hover)]" style={muted}><ArrowLeft size={16} aria-hidden /></a>
      <span aria-hidden className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold" style={{ background: "var(--color-accent-fill)", color: "var(--color-accent-foreground)" }}>
        {thread?.kind === "group" ? <Users size={18} /> : initialsOf(label.text)}
      </span>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-[16px] font-semibold leading-6" title={label.hint}>{label.text}{label.inferred && <span className="ml-1 text-[12px] font-normal" style={muted}>~ inferred</span>}</h1>
        <div className="flex flex-wrap items-center gap-x-3 text-[12px]" style={muted}>
          <span>{thread?.kind === "group" ? "Group · shared context" : "1:1"}</span>
          <span>Captured history · Read only</span>
          {data && <span>{Number(thread?.message_count ?? data.messages.length).toLocaleString("en-GB")} messages</span>}
        </div>
      </div>
      <a className="text-[12px] underline" style={muted} href="/whatsapp/identities">Identity links</a>
    </header>
    <div className="flex-1 px-4 pb-10 pt-3 sm:px-6" style={{ background: "color-mix(in srgb, var(--color-text) 3%, var(--color-surface))" }}>
      <aside aria-label="History limitations" className="mb-2 rounded-lg border px-3 py-2 text-[12px] leading-[18px]" style={{ ...border, ...muted, background: "var(--color-surface)" }}>
        <span className="inline-flex items-center gap-1.5 font-medium" style={{ color: "var(--color-text)" }}><Clock size={13} aria-hidden />Captured history only</span>
        {" "}Older messages and disconnected periods may be missing. Member observations are not a complete roster or exact membership dates.
        {status && <> Saved capture state: {typeof status.state === "string" ? status.state : "unknown"}.{typeof status.gapSince === "string" && <> Disconnection gap since {status.gapSince}.</>}{status.lastGap != null && <> Last recorded gap: {JSON.stringify(status.lastGap)}.</>} This is an imported observation, not a live connection check.</>}
        {expiryUnavailable && <> Disappearing-message timers were not captured.</>}
        <details className="mt-1"><summary className="cursor-pointer">Capture connection and gap status</summary>
          {status ? <pre className="mt-1 overflow-auto whitespace-pre-wrap text-[11px]">{JSON.stringify(status, null, 2)}</pre> : <p className="mt-1">No imported connection status. Disconnection gaps are unknown.</p>}
        </details>
      </aside>
      <WhatsappTradeLinks threadId={id} />
      {error && <p role="alert" className="py-3 text-[13px]" style={{ color: "var(--color-error)" }}>{error}</p>}
      <Pager where="top" />
      {loading && !data ? <p role="status" className="py-6 text-center text-[13px]" style={muted}>Loading conversation…</p> : null}
      {data && !runs.length && !loading && <p className="py-10 text-center text-[13px]" style={muted}>No messages captured for this chat.</p>}
      <div aria-busy={loading} className={loading ? "opacity-60" : undefined}>
        {runs.map((run) => <Fragment key={run.key}>
          {run.newDay && <div className="my-5 flex items-center gap-3 text-[11px] font-medium" style={muted}><span className="h-px flex-1" style={{ background: "var(--color-border)" }} />{dayLabel(whenOf(run.messages[0]))}<span className="h-px flex-1" style={{ background: "var(--color-border)" }} /></div>}
          <section aria-label={`${run.sender} messages`} className="mt-3">
            {(thread?.kind === "group" || !run.outbound) && <p className={`px-1 text-[11px] font-medium ${run.outbound ? "text-right" : ""}`} style={muted}>{run.sender}</p>}
            {run.messages.map((m, i) => <Bubble key={m.id} m={m} outbound={run.outbound} first={i === 0} last={i === run.messages.length - 1} threadId={id} />)}
          </section>
        </Fragment>)}
      </div>
      <Pager where="bottom" />
    </div>
  </main>;
}
