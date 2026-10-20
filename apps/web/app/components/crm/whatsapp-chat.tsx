"use client";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, FileText, Image as ImageIcon, Link2, Mic, Paperclip, Users } from "lucide-react";
import type { WhatsappConversationData, WhatsappMessage } from "@/lib/crm-postgres/whatsapp";
import { ARCHIVE_PREFIX } from "@/lib/whatsapp-archive";
import { initialsOf, whatsappChatLabel } from "@/lib/whatsapp-display";
import styles from "./whatsapp.module.css";
import { Loading } from "../ui/shimmer";
import { WhatsappTradeLinks } from "./whatsapp-trade-links";

const pageSize = 50;
const RUN_GAP_MS = 5 * 60 * 1000;
const SENDER_COLORS = ["#1fa855", "#53bdeb", "#e26ab6", "#ff7a8c", "#fa6533", "#a5b337", "#7f66ff", "#06cf9c", "#ffb02e"];
const colorOf = (name: string) => SENDER_COLORS[[...name].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % SENDER_COLORS.length];

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

function Bubble({ m, outbound, first, group, sender, threadId, editable }: { m: WhatsappMessage; outbound: boolean; first: boolean; group: boolean; sender: string | null; threadId: string; editable: boolean }) {
  const at = whenOf(m);
  const tombstone = Boolean(m.deleted_at);
  const att = !tombstone && m.attachment ? attachmentLabel(m.attachment) : null;
  return <div id={`message-${m.id}`} className={`${styles.row} ${first ? styles.rowFirst : ""} ${outbound ? styles.rowOut : ""}`}>
    <article className={`group ${styles.bubble} ${outbound ? styles.out : ""} ${first ? (outbound ? styles.tailOut : styles.tailIn) : ""}`}>
      {first && !outbound && group && sender && <p className={styles.sender} style={{ color: colorOf(sender) }}>{sender}</p>}
      {m.reply_to_provider_id && <blockquote className={styles.quote}>
        <span className="line-clamp-2">{m.reply_body || "Reply to an unavailable or removed message"}</span>
        {m.reply_to_message_id && <a className="underline" href={`#message-${m.reply_to_message_id}`}>Reply target</a>}
      </blockquote>}
      {tombstone
        ? <p className={`${styles.text} ${styles.tomb}`}>Message deleted</p>
        : <p className={styles.text}>{m.body || (att ? "" : "Content unavailable")}</p>}
      {att && <p className={styles.attach}><att.Icon size={14} aria-hidden />{att.kind} · content not downloaded</p>}
      {m.trade_links?.length ? <p className={styles.trades}>{m.trade_links.map((link) => <span key={link.lot_id} className={styles.trade} title={`Explicitly linked to ${link.title}`}><Link2 size={11} aria-hidden />{link.title}</span>)}</p> : null}
      <span className={styles.meta}>
        {m.edit_version > 0 && <span>Edited </span>}
        <time dateTime={at.toISOString()} title={`${at.toLocaleString("en-GB")}${m.timestamp_source === "capture" ? " · capture time, not sent time" : ""}`}>{clock(at)}{m.timestamp_source === "capture" ? "*" : ""}</time>
      </span>
      {editable && <WhatsappTradeLinks threadId={threadId} messageId={m.id} />}
    </article>
  </div>;
}

/** WhatsApp Web look for captured history. Read only. `embedded` fills a panel; otherwise it is a full page. */
export function WhatsappConversation({ id, embedded = false, onClose, onOpenPerson }: { id: string; embedded?: boolean; onClose?: () => void; onOpenPerson?: (personId: string) => void }) {
  const [data, setData] = useState<WhatsappConversationData | null>(null);
  const [offset, setOffset] = useState<number | "tail">("tail");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const toEnd = useRef(true);
  useEffect(() => { setData(null); setOffset("tail"); toEnd.current = true; }, [id]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    const position = offset === "tail" ? "tail=1" : `offset=${offset}`;
    const url = id.startsWith(ARCHIVE_PREFIX) ? `/api/whatsapp/archive?chat=${encodeURIComponent(id.slice(ARCHIVE_PREFIX.length))}&limit=${pageSize}&${position}` : `/api/whatsapp/threads/${encodeURIComponent(id)}?limit=${pageSize}&${position}`;
    fetch(url, { signal: controller.signal })
      .then(async (r) => { if (!r.ok) { throw new Error(r.status === 404 ? "Chat not found" : "Could not load conversation"); } setData(await r.json()); })
      .catch((e) => { if (e.name !== "AbortError") { setError(e.message); } })
      .finally(() => { if (!controller.signal.aborted) { setLoading(false); } });
    return () => controller.abort();
  }, [id, offset]);
  useEffect(() => { const el = scroller.current; if (el && data) { el.scrollTop = toEnd.current ? el.scrollHeight : 0; } }, [data]);
  const thread = data?.thread;
  const label = whatsappChatLabel({ id, kind: thread?.kind ?? "direct", name: thread?.name ?? thread?.subject, name_source: thread?.name_source });
  const runs = useMemo(() => groupRuns(data?.messages ?? []), [data]);
  const expiryUnavailable = data?.messages.some((m) => m.metadata.expiry_policy_unavailable === true);
  const status = data?.capture_status;
  const total = Number(thread?.message_count ?? 0);
  const start = data?.offset ?? 0;
  const hasEarlier = start > 0;
  const hasLater = Boolean(data) && start + (data?.messages.length ?? 0) < total;
  const go = (next: number, end: boolean) => { toEnd.current = end; setOffset(Math.max(0, next)); };
  const group = thread?.kind === "group";
  const imported = id.startsWith(ARCHIVE_PREFIX);
  return <div className={`${styles.wa} ${styles.pane} ${embedded ? "" : "mx-auto min-h-screen max-w-[920px]"}`}>
    <header className="flex shrink-0 items-center gap-3 border-b px-4 py-3" style={{ borderColor: "var(--color-border)", background: "var(--color-surface)", color: "var(--color-text)" }}>
      {(onClose || !embedded) && <button type="button" aria-label="Back to Inbox" onClick={onClose ?? (() => { window.location.href = "/?crm=inbox&view=whatsapp"; })} className="inline-flex h-8 w-8 items-center justify-center rounded-full hover:bg-[var(--color-surface-hover)]" style={{ color: "var(--color-text-muted)" }}><ArrowLeft size={16} aria-hidden /></button>}
      <span aria-hidden className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold" style={{ background: "var(--color-accent-fill)", color: "var(--color-accent-foreground)" }}>{group ? <Users size={17} /> : initialsOf(label.text)}</span>
      <div className="min-w-0 flex-1">
        <h1 className="flex items-baseline gap-1.5 truncate text-[15px] font-semibold leading-5" title={label.hint}>{label.text}{label.inferred && <span className="text-[12px] font-normal" style={{ color: "var(--color-text-muted)" }}>~ inferred</span>}</h1>
        <p className="truncate text-[12px] leading-4" style={{ color: "var(--color-text-muted)" }}>{group ? "Group · read only" : "Read only"}</p>
      </div>
      {thread?.person_id && onOpenPerson && <button type="button" onClick={() => onOpenPerson(thread.person_id!)} className="rounded-md border px-2.5 py-1 text-[12px] font-medium hover:bg-[var(--color-surface-hover)]" style={{ borderColor: "var(--color-border)" }}>View in CRM</button>}
    </header>
    <div ref={scroller} className={styles.scroller}>
      <p aria-label="History limitations" className={styles.notice}>{imported ? "Imported WhatsApp export" : "Captured history, gaps possible"}</p>
      {!imported && <WhatsappTradeLinks threadId={id} />}
      {error && <p role="alert" className={styles.notice} style={{ color: "#b3261e" }}>{error}</p>}
      {hasEarlier && <button type="button" className={styles.pager} disabled={loading} onClick={() => go(start - pageSize, true)}>Earlier messages</button>}
      {loading && !data ? <Loading label="Loading conversation…" variant="chat" /> : null}
      {data && !runs.length && !loading && <p className={styles.chip}>No messages captured for this chat</p>}
      <div aria-busy={loading} style={{ opacity: loading && data ? 0.6 : 1 }}>
        {runs.map((run) => <Fragment key={run.key}>
          {run.newDay && <time className={styles.chip} dateTime={whenOf(run.messages[0]).toISOString()}>{dayLabel(whenOf(run.messages[0]))}</time>}
          <section aria-label={`${run.sender} messages`}>
            {run.messages.map((m, i) => <Bubble key={m.id} m={m} outbound={run.outbound} first={i === 0} group={group} sender={run.sender} threadId={id} editable={!imported} />)}
          </section>
        </Fragment>)}
      </div>
      {hasLater && <button type="button" className={styles.pager} disabled={loading} onClick={() => go(start + pageSize, false)}>Later messages</button>}
    </div>
  </div>;
}
