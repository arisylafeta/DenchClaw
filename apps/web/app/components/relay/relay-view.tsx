"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HermesConversation } from "@/lib/hermes-conversations";
import type { RelayDraftView, RelayItem, RelayJob, RelayReviewItem, RelayTab, RelayTodo } from "@/lib/relay";
import { beforeYouSend, NEEDS_AGENT, promisesIn, type Issue } from "@/lib/relay-checks";
import s from "./relay.module.css";

const ChatPanel = dynamic(() => import("@/app/components/chat-panel").then((m) => m.ChatPanel), { ssr: false });

type Counts = { action: number; follow: number; other: number; review: number; todos: number; sent_today: number; done_today: number };
type Summary = { tab: RelayTab; counts: Counts; items: RelayItem[]; review: RelayReviewItem[]; todos: RelayTodo[]; rules: { id: string; text: string }[]; scannedAt: string | null; avgReplyMinutes: number | null };
type Page = "inbox" | "review" | "todos";

const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");
const PALETTE = ["#2563EB", "#0EA5E9", "#7C3AED", "#DB2777", "#EA580C", "#16A34A", "#0D9488", "#4F46E5", "#B45309"];
const colour = (name: string) => PALETTE[[...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % PALETTE.length];
const initials = (name: string) => name.split(/[\s@.]+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";
const firstName = (name: string | null | undefined) => (name ?? "").split(/[\s@]/)[0] || "them";
const PRIORITY_LABEL: Record<string, string> = { urgent: "Urgent", overdue: "Overdue", high: "High", medium: "Medium", low: "Low" };

function ago(iso: string | null | undefined): string {
  if (!iso) return "";
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}
function when(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
function duration(minutes: number | null): string {
  if (minutes == null) return "–";
  return minutes < 60 ? `${minutes}m` : minutes < 60 * 48 ? `${(minutes / 60).toFixed(1)}h` : `${Math.round(minutes / 1440)}d`;
}

async function api<T>(url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(url, { method: init?.method ?? "GET", headers: init?.body ? { "content-type": "application/json" } : undefined, body: init?.body ? JSON.stringify(init.body) : undefined, cache: "no-store" });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data as { error?: string } | null)?.error ?? "Something went wrong. Try again.");
  return data as T;
}

const Arrow = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
const Logo = () => <span className={s.logo}><i /></span>;

export function RelayView({ onOpenListing }: { onOpenListing?: (id: string, title?: string) => void }) {
  const [page, setPage] = useState<Page>("inbox");
  const [tab, setTab] = useState<RelayTab>("action");
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [, tick] = useState(0);

  const say = useCallback((text: string, undo?: () => void) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ text, undo });
    toastTimer.current = setTimeout(() => setToast(null), undo ? 6000 : 2800);
  }, []);

  const load = useCallback(async (which: RelayTab) => {
    try {
      const next = await api<Summary>(`/api/relay/summary?tab=${which}`);
      setData(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load Relay.");
    }
  }, []);
  useEffect(() => { void load(tab); }, [tab, load]);
  // Sends run on the server after Alex confirms. The page moves on, watches the message's own state, and reports
  // the outcome: Sent, or why not. The send itself does not depend on this tab staying open.
  const [sending, setSending] = useState<Record<string, string>>({});
  const startSend = useCallback(async (draftId: string, updatedAt: string, toLabel: string) => {
    try {
      await api(`/api/relay/drafts/${draftId}/send`, { method: "POST", body: { confirm: true, updated_at: updatedAt } });
      setSending((m) => ({ ...m, [draftId]: toLabel }));
      say(`Sending to ${toLabel}…`);
      void load(tab);
      return true;
    } catch (err) {
      say(`Not sent: ${err instanceof Error ? err.message : "something went wrong"}`);
      return false;
    }
  }, [say, load, tab]);
  // While sends are pending, check every few seconds and report each outcome once.
  useEffect(() => {
    if (!Object.keys(sending).length) return;
    const t = setInterval(() => void load(tab), 4000);
    return () => clearInterval(t);
  }, [sending, load, tab]);
  useEffect(() => {
    if (!data || !Object.keys(sending).length) return;
    const drafts = new Map(data.review.flatMap((x) => x.drafts).map((d) => [d.id, d]));
    const done: string[] = [];
    for (const [id, to] of Object.entries(sending)) {
      const mail = drafts.get(id)?.mail;
      if (!mail || mail.state === "accepted") { say(`Sent to ${to}`); done.push(id); }
      else if (mail.state === "failed" || mail.state === "unknown" || (mail.state === "draft" && mail.failure)) { say(`Not sent to ${to}: ${failureText(mail.failure, mail.state)}`); done.push(id); }
    }
    if (done.length) setSending((m) => Object.fromEntries(Object.entries(m).filter(([id]) => !done.includes(id))));
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  // The scan runs every 10 minutes; refresh the page each minute so new mail and the scan time show up.
  useEffect(() => {
    const id = setInterval(() => { tick((n) => n + 1); if (document.visibilityState === "visible") void load(tab); }, 60_000);
    return () => clearInterval(id);
  }, [tab, load]);

  const counts = data?.counts;
  const total = counts ? counts.action + counts.review + counts.sent_today + counts.done_today : 0;
  const handled = counts ? counts.sent_today + counts.done_today : 0;
  const pct = total ? Math.round(((handled + (counts?.review ?? 0) * 0.5) / total) * 100) : 100;
  const score = counts ? Math.min(99, Math.round(pct * 0.6 + Math.min(40, counts.sent_today * 4 + counts.done_today))) : 0;
  const scanned = data?.scannedAt ? Math.max(0, Math.round((Date.now() - new Date(data.scannedAt).getTime()) / 60_000)) : null;
  const ring = 2 * Math.PI * 25;

  return (
    <div className={s.root}>
      <div className={s.wrap}>
        <div className={s.top}>
          <div className={s.brand}><Logo />Relay</div>
          <div className={s.tabs} role="tablist" aria-label="Relay">
            {([["inbox", "Inbox", counts ? counts.action + counts.follow : 0], ["review", "Review", counts?.review ?? 0], ["todos", "To-dos", counts?.todos ?? 0]] as const).map(([key, label, n]) => (
              <button key={key} role="tab" type="button" aria-selected={page === key} onClick={() => setPage(key)}>{label} <span className={s.n}>{n}</span></button>
            ))}
          </div>
          <div className={s.scan} title="Relay scans Gmail every 10 minutes">
            <span className={cx(s.pulse, scanned != null && scanned > 20 && s.stale)} />
            <span>{scanned == null ? "Waiting for the first scan" : scanned > 20 ? `Last scan ${ago(data?.scannedAt)} ago` : `Scanned ${scanned} min ago · next scan in ${Math.max(1, 10 - (scanned % 10))} min`}</span>
          </div>
        </div>

        <div className={cx(s.card, s.score)}>
          <div className={s.meter}>
            <div className={s.ring}><svg viewBox="0 0 58 58"><circle cx="29" cy="29" r="25" stroke="var(--soft)" /><circle cx="29" cy="29" r="25" stroke="var(--blue)" strokeDasharray={ring} strokeDashoffset={ring * (1 - pct / 100)} /></svg><em className={s.num}>{pct}%</em></div>
            <div><b>Today</b><span>{handled} of {total} done</span></div>
          </div>
          <div><b className={s.num}>{counts?.sent_today ?? 0}</b><span>Replies sent</span></div>
          <div><b className={s.num}>{counts?.review ?? 0}</b><span>In review</span></div>
          <div><b className={s.num}>{duration(data?.avgReplyMinutes ?? null)}</b><span>Avg. reply time</span></div>
          <div><b className={s.num}><span className={s.dot} />{score}</b><span>Relay score</span></div>
        </div>

        {error && <p className={s.error} role="alert">{error}</p>}
        {!data && !error && <p className={s.muted} role="status">Loading Relay…</p>}
        {data && page === "inbox" && <Inbox data={data} tab={tab} setTab={setTab} reload={() => load(tab)} say={say} onOpenListing={onOpenListing} onDrafted={() => setPage("review")} />}
        {data && page === "review" && <Review data={data} reload={() => load(tab)} say={say} onBack={() => setPage("inbox")} sending={sending} startSend={startSend} />}
        {data && page === "todos" && <Todos todos={data.todos} reload={() => load(tab)} say={say} />}
      </div>
      <div className={cx(s.toast, toast && s.on)} role="status" aria-live="polite">
        <span>{toast?.text}</span>
        {toast?.undo && <button type="button" onClick={() => { toast.undo?.(); setToast(null); }}>Undo</button>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Inbox

function Inbox({ data, tab, setTab, reload, say, onOpenListing, onDrafted }: {
  data: Summary; tab: RelayTab; setTab: (t: RelayTab) => void; reload: () => Promise<void>; say: (t: string, undo?: () => void) => void;
  onOpenListing?: (id: string, title?: string) => void; onDrafted: () => void;
}) {
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [gone, setGone] = useState<Record<string, boolean>>({});
  const items = data.tab === tab ? data.items : [];
  const types = useMemo(() => [...new Set(items.map((i) => i.contact_type).filter((t): t is string => !!t))].sort(), [items]);
  const shown = items.filter((i) => !gone[i.id] && (!type || i.contact_type === type)
    && `${i.counterpart_name ?? ""} ${i.counterpart_email ?? ""} ${i.company ?? ""} ${i.headline} ${i.deal_label ?? ""}`.toLowerCase().includes(q.toLowerCase()));
  const noteOf = (i: RelayItem) => notes[i.id] ?? i.note;

  const saveNote = (i: RelayItem) => {
    const note = notes[i.id];
    if (note === undefined || note === i.note) return;
    void api(`/api/relay/items/${i.id}`, { method: "PATCH", body: { note } }).catch(() => undefined);
  };
  const draft = async (i: RelayItem) => {
    const note = noteOf(i).trim();
    if (!note) { say("Add a note first: how do you want to reply?"); setOpen(i.id); return; }
    setBusy((b) => ({ ...b, [i.id]: true }));
    const agent = NEEDS_AGENT.test(note);
    say(agent ? `Relay is on it for ${firstName(i.counterpart_name)} · follow progress in Review` : `Drafting v1 for ${firstName(i.counterpart_name)}…`);
    try {
      await api(`/api/relay/items/${i.id}/draft`, { method: "POST", body: { note } });
      setGone((g) => ({ ...g, [i.id]: true }));
      await reload();
      say(agent ? `Working on ${firstName(i.counterpart_name)} in Review (a few minutes)` : `Drafted · ${firstName(i.counterpart_name)} is in Review`, onDrafted);
    } catch (err) {
      say(err instanceof Error ? err.message : "Couldn't draft. Try again.");
    } finally {
      setBusy((b) => ({ ...b, [i.id]: false }));
    }
  };
  const moveToAction = async (i: RelayItem) => {
    setGone((g) => ({ ...g, [i.id]: true }));
    try {
      await api(`/api/relay/items/${i.id}`, { method: "PATCH", body: { tab: "action" } });
      say("Moved to Action · Relay will learn from this", async () => {
        await api(`/api/relay/items/${i.id}`, { method: "PATCH", body: { tab: "other" } }).catch(() => undefined);
        setGone((g) => ({ ...g, [i.id]: false }));
        await reload();
      });
      await reload();
    } catch (err) { setGone((g) => ({ ...g, [i.id]: false })); say(err instanceof Error ? err.message : "Couldn't move it."); }
  };
  const done = async (i: RelayItem) => {
    setGone((g) => ({ ...g, [i.id]: true }));
    try {
      await api(`/api/relay/items/${i.id}/done`, { method: "POST" });
      say("Done · marked read and labelled Sorted in Gmail");
      await reload();
    } catch (err) { setGone((g) => ({ ...g, [i.id]: false })); say(err instanceof Error ? err.message : "Couldn't update Gmail."); }
  };

  const heads = tab === "follow" ? ["Waiting on", "Your last email", "Deal", "No reply", "Priority"]
    : tab === "other" ? ["From", "What it is", "Deal", "Received", ""] : ["From", "What they want", "Deal", "Waiting", "Priority"];

  return (
    <section aria-label="Inbox">
      <div className={s.phead}>
        <div className={s.itabs} role="tablist" aria-label="Inbox views">
          {([["action", "Action"], ["follow", "Follow up"], ["other", "Other"]] as const).map(([key, label]) => (
            <button key={key} role="tab" type="button" aria-selected={tab === key} onClick={() => { setTab(key); setOpen(null); }}>{label} <span className={s.n}>{data.counts[key]}</span></button>
          ))}
        </div>
        <div className={s.tools}>
          <label className={s.search}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people or deals" aria-label="Search" />
          </label>
          <select className={s.filter} value={type} onChange={(e) => setType(e.target.value)} aria-label="Filter by type">
            <option value="">All types</option>
            {types.map((t) => <option key={t} value={t}>{t.replace(/^./, (c) => c.toUpperCase())}</option>)}
          </select>
        </div>
      </div>
      <div className={cx(s.card, s.list)}>
        <div className={cx(s.grid, s.lhead)}>{heads.map((h, k) => <span key={k}>{h}</span>)}</div>
        {data.tab !== tab ? <div className={s.empty}><span className={s.muted}>Loading…</span></div>
          : !items.length ? <div className={s.empty}><b>{tab === "action" ? "Nothing needs a reply" : tab === "follow" ? "Nothing to chase" : "Nothing else"}</b><span className={s.muted}>Relay checks again in a few minutes.</span></div>
          : !shown.length ? <div className={s.empty}><span className={s.muted}>No matches.</span></div>
          : shown.map((i) => {
            const isOpen = open === i.id;
            const name = i.counterpart_name || i.counterpart_email || "Unknown";
            const note = noteOf(i);
            const toggle = () => setOpen(isOpen ? null : i.id);
            return (
              <div key={i.id} className={cx(s.row, isOpen && s.open)}>
                <div className={cx(s.grid, s.rmain)} role="button" tabIndex={0} aria-expanded={isOpen} onClick={toggle} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggle(); } }}>
                  <div className={s.who}><div className={s.av} style={{ background: colour(name) }}>{initials(name)}</div><div style={{ minWidth: 0 }}><b>{name}</b><span>{i.company || i.counterpart_email}</span></div></div>
                  <div className={s.sum}><b>{i.headline}</b><span>{i.context}</span></div>
                  <div className={s.dealc}>
                    {i.bulk_listing_id
                      ? <button type="button" className={s.deal} title={`Open deal: ${i.deal_label ?? ""}`} onClick={(e) => { e.stopPropagation(); onOpenListing?.(i.bulk_listing_id!, i.deal_label ?? undefined); }}>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M20 12l-8 8-9-9V3h8z" /><circle cx="7.5" cy="7.5" r="1.5" /></svg><span>{i.deal_label || "Deal"}</span>
                        </button>
                      : <span className={s.nodeal}>No deal</span>}
                  </div>
                  <div className={cx(s.wait, s.num, i.priority === "overdue" && s.late)}>{ago(i.waiting_since ?? i.last_message?.at)}</div>
                  {tab === "other"
                    ? <div className={s.oacts}><button type="button" onClick={(e) => { e.stopPropagation(); void moveToAction(i); }}>Needs reply</button><button type="button" onClick={(e) => { e.stopPropagation(); void done(i); }}>Done</button></div>
                    : <div><span className={cx(s.pill, s[i.priority])}><i />{PRIORITY_LABEL[i.priority]}</span></div>}
                </div>
                {isOpen && (
                  <div className={s.thread}>
                    {i.last_message && (
                      <div className={s.lastmail}>
                        <div className={s.mh}><b>{i.last_message.from_name || i.last_message.from_email}</b> · {when(i.last_message.at)} · {tab === "follow" ? "your last email, no reply since" : "their latest email"}</div>
                        <div className={s.mb}>{i.last_message.text}</div>
                      </div>
                    )}
                    {i.earlier.length > 0 && <div className={s.earlier}>{i.earlier.map((e, k) => <span key={k}><b>{e.who}</b> · {e.when}: {e.summary}</span>)}</div>}
                  </div>
                )}
                {tab !== "other" && (
                  <>
                    <div className={s.note}>
                      <textarea
                        rows={1}
                        value={note}
                        aria-label={`Reply notes for ${name}`}
                        placeholder={tab === "follow" ? "How do you want to chase? e.g. nudge, offer a call, new deadline" : "How do you want to reply? e.g. thank him, offer €38, ask for volumes"}
                        onChange={(e) => { setNotes((n) => ({ ...n, [i.id]: e.target.value })); e.target.style.height = "auto"; e.target.style.height = `${e.target.scrollHeight}px`; }}
                        onBlur={() => saveNote(i)}
                        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void draft(i); } }}
                      />
                      <button type="button" className={cx(s.arrow, note.trim() && s.ready)} disabled={busy[i.id]} onClick={() => void draft(i)} aria-label="Draft this reply"><Arrow /></button>
                      {tab === "action" && <button type="button" className={s.doneb} title="No reply needed: marks it read and labels it Sorted in Gmail" onClick={() => void done(i)}>Done</button>}
                    </div>
                    {!isOpen && <div className={s.hint}>{busy[i.id] ? "Drafting…" : note.trim() ? (NEEDS_AGENT.test(note) ? "Relay will do the work first (research, lists, files), then draft. Takes a few minutes." : "Ready: press the arrow (or ⌘↵) to draft") : "Click to read the full email"}</div>}
                  </>
                )}
              </div>
            );
          })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- Review

type Local = { subject: string; body: string; updated_at: string };

function Review({ data, reload, say, onBack, sending, startSend }: {
  data: Summary; reload: () => Promise<void>; say: (t: string, undo?: () => void) => void; onBack: () => void;
  sending: Record<string, string>; startSend: (draftId: string, updatedAt: string, toLabel: string) => Promise<boolean>;
}) {
  const items = data.review;
  const [cur, setCur] = useState(0);
  const working = items.some((x) => x.job && ["queued", "running", "ready", "finalising"].includes(x.job.status));
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => void reload(), 8000);
    return () => clearInterval(t);
  }, [working, reload]);
  const [views, setViews] = useState<Record<string, string>>({});
  const index = Math.min(cur, Math.max(0, items.length - 1));
  const item = items[index];
  if (!item) return <div className={cx(s.card, s.empty)}><b>Nothing in review</b><span className={s.muted}>Add a note to an email in your Inbox and press the arrow. Relay drafts it here.</span></div>;
  const ordered = [...item.drafts].sort((a, b) => a.position - b.position);
  const viewId = views[item.id] && ordered.some((d) => d.id === views[item.id]) ? views[item.id] : ordered[0]?.id;
  const draft = ordered.find((d) => d.id === viewId) ?? ordered[0];
  const isSent = (d: RelayDraftView) => d.state === "sent" || d.id in sending;
  return (
    <section aria-label="Review">
      <div className={s.phead}><span className={s.tag}>In review</span></div>
      <div className={s.pager}>
        <button className={s.navb} type="button" aria-label="Previous" onClick={() => setCur((index - 1 + items.length) % items.length)}>‹</button>
        {items.map((x, k) => {
          const name = x.counterpart_name || x.counterpart_email || "?";
          const busyJob = !x.drafts.length && x.job && ["queued", "running", "ready", "finalising"].includes(x.job.status);
          return <button key={x.id} type="button" className={s.chip} aria-current={k === index} onClick={() => setCur(k)}><span className={s.av} style={{ background: colour(name) }}>{initials(name)}</span>{firstName(name)}<span className={cx(s.st, (busyJob || x.drafts.some((d) => d.id in sending)) && s.work, !busyJob && x.drafts.length > 0 && x.drafts.filter((d) => d.role === "primary").every((d) => d.state === "sent") && s.sent)} /></button>;
        })}
        <button className={s.navb} type="button" aria-label="Next" onClick={() => setCur((index + 1) % items.length)}>›</button>
        <span className={s.count}>{index + 1} of {items.length}</span>
      </div>
      <div className={s.rgrid}>
        <div className={s.col}>
          {!draft && item.job ? <JobCard job={item.job} itemId={item.id} reload={reload} say={say} />
            : draft ? <Editor key={draft.id} item={item} draft={draft} reload={reload} say={say} onBack={onBack} sendingTo={sending[draft.id]}
            startSend={startSend}
            onNext={() => {
              // The draft just confirmed counts as sent: go to its next unsent email, else the next person.
              const next = ordered.find((d) => d.id !== draft.id && !isSent(d));
              if (next) setViews((v) => ({ ...v, [item.id]: next.id }));
              else if (items.length > 1) setCur((index + 1) % items.length);
            }} />
            : <div className={cx(s.card, s.empty)}><span className={s.muted}>No draft on this email.</span></div>}
          {ordered.length > 1 && (
            <div>
              <div className={s.sec}><h3>{draft?.role === "primary" ? "Follow-on emails" : "Other emails in this plan"}</h3><span>{draft?.role === "primary" ? "Suggested from the primary email. Click one to open it here." : "Click to switch."}</span></div>
              <div className={s.cards}>
                {ordered.filter((d) => d.id !== draft?.id).map((d) => (
                  <button key={d.id} type="button" className={cx(s.card, s.fo, d.role === "primary" && s.primary)} onClick={() => { setViews((v) => ({ ...v, [item.id]: d.id })); }}>
                    <div className={s.ft}><span className={s.step}>{d.role === "primary" ? "PRIMARY" : `FOLLOW-ON ${d.position}`}</span><span style={{ fontSize: 12.5, fontWeight: 500, color: isSent(d) ? "var(--green)" : "var(--muted)" }}>{isSent(d) ? "Sent" : d.mail ? "Draft" : "Needs a recipient"}</span></div>
                    <b>{d.title}</b>
                    <span className={s.to}>{d.mail?.to_emails.length ? `To ${d.mail.to_emails.join(", ")}` : d.why}</span>
                    <span className={s.pv}>{d.mail?.main.split("\n").filter(Boolean).slice(1, 2).join(" ") || d.why}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <Todos.Suggested item={item} draft={draft} reload={reload} say={say} />
        </div>
        <AiPanel key={item.id} item={item} draft={draft} rules={data.rules} reload={reload} say={say} />
      </div>
    </section>
  );
}

/** An agent job in progress or failed: steps so far, elapsed time, and Retry / Quick draft when it fails. */
function JobCard({ job, itemId, reload, say }: { job: RelayJob; itemId: string; reload: () => Promise<void>; say: (t: string) => void }) {
  const [busy, setBusy] = useState(false);
  const failed = job.status === "failed";
  const minutes = Math.max(0, Math.round((Date.now() - new Date(job.started_at ?? job.created_at).getTime()) / 60_000));
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try { await fn(); say(done); await reload(); } catch (err) { say(err instanceof Error ? err.message : "That didn't work."); } finally { setBusy(false); }
  };
  return (
    <div className={cx(s.card, s.editor)}>
      <div className={s.ebar}>
        <div><div className={s.lab}>Agent job</div><h2>{failed ? "Relay couldn't finish this" : "Relay is working on this"}</h2></div>
        <span className={cx(s.pill, failed ? s.urgent : s.medium)}><i />{failed ? "Failed" : job.status === "queued" ? "Queued" : `${minutes} min`}</span>
      </div>
      <div className={s.fromnote}>Your note: <b>&ldquo;{job.note}&rdquo;</b></div>
      <div className={s.jobsteps}>
        {job.steps.map((step, k) => <span key={k} className={s.done}>{step}</span>)}
        {!failed && <span className={s.now}><i className={s.spin} aria-hidden />{job.status === "ready" || job.status === "finalising" ? "Writing the draft and attaching files" : "Researching and preparing files. Usually 2 to 5 minutes; you can carry on in the Inbox."}</span>}
        {failed && <span className={s.err}>{job.error ?? "Something went wrong."}</span>}
      </div>
      {failed && (
        <div className={s.eact}>
          <button type="button" className={cx(s.btn, s.pri)} disabled={busy} onClick={() => void act(() => api(`/api/relay/items/${itemId}/job`, { method: "POST" }), "Trying again")}>Retry</button>
          <button type="button" className={s.btn} disabled={busy} onClick={() => void act(() => api(`/api/relay/items/${itemId}/draft`, { method: "POST", body: { note: job.note, mode: "quick" } }), "Quick draft ready")}>Quick draft instead</button>
        </div>
      )}
      <div className={s.eact} style={failed ? { paddingTop: 0 } : undefined}>
        <span className={s.sp} />
        <button type="button" className={cx(s.btn, s.ghost)} disabled={busy} onClick={() => void act(() => api(`/api/relay/items/${itemId}/done`, { method: "POST" }), "Done · no reply. Marked read and labelled Sorted in Gmail")}>Done, no reply</button>
      </div>
    </div>
  );
}

/** Plain words for why a send didn't go out. */
function failureText(failure: { reason: string; detail?: unknown } | null, state: string): string {
  const detail = (failure?.detail ?? {}) as { cause?: string; rule?: string; refused?: string };
  const reason = detail.cause ?? detail.refused ?? failure?.reason ?? state;
  const words: Record<string, string> = {
    thread_has_reply: "they replied since this was drafted. Read their reply first.",
    gmail_auth_unavailable: "Gmail login check failed. Try again in a minute.",
    gmail_read_failed: "couldn't read Gmail to check for new replies. Try again.",
    approval_digest_mismatch: "the draft changed while sending. Check it and send again.",
    reply_mailbox_unavailable: "couldn't find the mailbox to check for replies.",
    gmail_reply_anchor_missing: "couldn't find the email it replies to.",
    recipient_suppressed: "the recipient is on the do-not-email list.",
    not_sent_released: "an earlier attempt didn't go out. It's ready to send again.",
    send_timed_out: "the send took too long. Use Check if it went.",
    unknown: "Gmail didn't confirm. Use Check if it went.",
    failed: "Gmail refused it. Use Check if it went.",
    preflight_error: "a pre-send check failed. Try again.",
  };
  return words[reason] ?? `${reason.replace(/_/g, " ")}.`;
}

function Editor({ item, draft, reload, say, onBack, onNext, sendingTo, startSend }: {
  item: RelayReviewItem; draft: RelayDraftView; reload: () => Promise<void>; say: (t: string, undo?: () => void) => void; onBack: () => void; onNext: () => void;
  sendingTo?: string; startSend: (draftId: string, updatedAt: string, toLabel: string) => Promise<boolean>;
}) {
  const mail = draft.mail;
  const [local, setLocal] = useState<Local | null>(mail ? { subject: mail.subject ?? "", body: mail.main, updated_at: mail.updated_at } : null);
  const [saving, setSaving] = useState(false);
  const [arming, setArming] = useState(false);
  const [sending, setSending] = useState(false);
  const [toOverride, setToOverride] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  // A rewrite from the AI panel saves server-side; pick up the new copy when the draft's version moves on.
  useEffect(() => { if (mail && local && mail.updated_at !== local.updated_at && !saving) setLocal({ subject: mail.subject ?? "", body: mail.main, updated_at: mail.updated_at }); }, [mail?.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const el = bodyRef.current; if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; } }, [local?.body]);
  useEffect(() => { if (!arming) return; const t = setTimeout(() => setArming(false), 5000); return () => clearTimeout(t); }, [arming]);

  if (!mail || !local) {
    return <div className={cx(s.card, s.editor)}><div className={s.ebar}><div><div className={s.lab}>Follow-on email</div><h2>{draft.title}</h2></div></div><p style={{ padding: "14px 18px" }} className={s.muted}>{draft.why} Relay didn't know who to send this to, so there's no draft yet. Ask in the panel on the right, e.g. "draft this to Rob at Qube".</p></div>;
  }
  const dirty = local.subject !== (mail.subject ?? "") || local.body !== mail.main;
  const save = async (): Promise<Local | null> => {
    if (!dirty) return local;
    setSaving(true);
    try {
      const updated = await api<{ updated_at: string; subject: string | null; editable: { main: string } }>(`/api/mail/drafts/${mail.id}`, { method: "PATCH", body: { subject: local.subject, body: local.body, updated_at: local.updated_at } });
      const next = { subject: updated.subject ?? "", body: updated.editable.main, updated_at: updated.updated_at };
      setLocal(next);
      void reload();
      return next;
    } catch (err) { say(err instanceof Error ? err.message : "Couldn't save."); return null; } finally { setSaving(false); }
  };
  const sent = draft.state === "sent";
  const to = mail.to_emails;
  const verdict = beforeYouSend({ to, body: local.body, attachments: mail.attachments.length }, item.facts);
  const blocked = verdict.state === "stop";
  const send = async () => {
    if (!arming) { setArming(true); return; }
    setArming(false); setSending(true);
    try {
      const version = await save();
      if (!version) return;
      if (await startSend(draft.id, version.updated_at, to.join(", "))) onNext();
    } finally { setSending(false); }
  };
  const [checking, setChecking] = useState(false);
  const checkSent = async () => {
    setChecking(true);
    try {
      const r = await api<{ outcome: string; retry_after_seconds?: number }>(`/api/relay/drafts/${draft.id}/release`, { method: "POST" });
      say(r.outcome === "sent" ? "It did go: found in Gmail Sent. Marked as sent." : r.outcome === "released" ? "It didn't go. Back to a draft, ready to send again." : `Still settling. Try again in ${Math.ceil((r.retry_after_seconds ?? 60) / 60)} min.`);
      await reload();
    } catch (err) { say(err instanceof Error ? err.message : "Couldn't check."); } finally { setChecking(false); }
  };
  const markDone = async () => {
    try { await api(`/api/relay/items/${item.id}/done`, { method: "POST" }); say("Done · no reply. Marked read and labelled Sorted in Gmail"); await reload(); }
    catch (err) { say(err instanceof Error ? err.message : "Couldn't update Gmail."); }
  };
  const toGmail = async () => {
    const version = await save();
    if (!version) return;
    try {
      const r = await api<{ url: string }>(`/api/relay/drafts/${draft.id}/gmail`, { method: "POST" });
      say("Saved to Gmail drafts in alex@rebattery.io", () => window.open(r.url, "_blank", "noopener"));
      await reload();
    } catch (err) { say(err instanceof Error ? err.message : "Couldn't reach Gmail."); }
  };
  const detach = async (sha256: string, filename: string) => {
    try { await api(`/api/relay/drafts/${draft.id}/attachments`, { method: "DELETE", body: { sha256 } }); say(`Removed ${filename}`); await reload(); }
    catch (err) { say(err instanceof Error ? err.message : "Couldn't remove it."); }
  };
  const issueText = (issue: Issue, k: number) => (
    <span key={k}>{issue.text}{issue.fix && <> <button type="button" className={s.fixl} onClick={() => setToOverride(issue.fix!.to)}>{issue.fix.label}</button></>} </span>
  );
  const lead = verdict.state === "stop" ? "Fix this before sending." : verdict.state === "check" ? (verdict.issues.length === 1 ? "One thing to check." : `${verdict.issues.length} things to check.`) : "Ready to send.";
  const okLine = verdict.good.length ? `${verdict.state === "ok" ? "" : "Otherwise "}${verdict.good.join(", ").replace(/, ([^,]*)$/, " and $1")}.` : "";
  const hasPromise = draft.role === "primary" && (promisesIn(local.body).length > 0 || item.todos.some((t) => t.kind === "promise"));

  return (
    <div className={cx(s.card, s.editor)}>
      <div className={s.ebar}>
        <div><div className={s.lab}>{draft.role === "primary" ? "Primary email" : "Follow-on email"} · {mail.identity_key === "supply" ? "supply@" : "alex@"}</div><h2>{draft.title}</h2></div>
        <span className={cx(s.pill, sent ? s.ok : s.warn)}><i />{sent ? "Sent" : draft.state === "gmail" ? "In Gmail drafts" : saving ? "Saving…" : "Draft"}</span>
      </div>
      {draft.role === "primary" && draft.source_note && <div className={s.fromnote}>Drafted from your note: <b>&ldquo;{draft.source_note}&rdquo;</b></div>}
      {draft.agent_log.length > 0 && <div className={s.log}>{draft.agent_log.map((l, k) => <span key={k}>{l}</span>)}</div>}
      <div className={s.field} style={{ marginTop: 6 }}><span>From</span><div className={s.ro}>{mail.from_email}</div></div>
      <div className={s.field}><span>To</span><div className={s.ro}>{to.join(", ") || "No recipient"}{toOverride && <span className={s.muted}> · to send to {toOverride}, use Add to Gmail drafts and change it there</span>}</div></div>
      {mail.cc_emails.length > 0 && <div className={s.field}><span>Cc</span><div className={s.ro}>{mail.cc_emails.join(", ")}</div></div>}
      <div className={s.field}><label htmlFor={`sj-${draft.id}`}>Subject</label><input id={`sj-${draft.id}`} value={local.subject} disabled={sent} onChange={(e) => setLocal({ ...local, subject: e.target.value })} onBlur={() => void save()} /></div>
      <textarea ref={bodyRef} className={s.body} value={local.body} disabled={sent} aria-label="Email body" onChange={(e) => setLocal({ ...local, body: e.target.value })} onBlur={() => void save()} />
      {mail.attachments.length > 0 && (
        <div className={s.atts}>
          {mail.attachments.map((a) => (
            <div key={a.sha256} className={s.att}>
              <a className={s.attlink} href={`/api/mail/drafts/${mail.id}/attachments/${a.sha256}`} target="_blank" rel="noopener noreferrer">
                <span className={cx(s.ic, /xlsx?$/i.test(a.filename) && s.xl)}>{(a.filename.split(".").pop() ?? "").toUpperCase().slice(0, 4)}</span>
                <div><b>{a.filename}</b><span>{a.sizeBytes ? `${Math.max(1, Math.round(a.sizeBytes / 1024))} KB · open` : "open"}</span></div>
              </a>
              {!sent && <button type="button" className={s.attx} aria-label={`Remove ${a.filename}`} onClick={() => void detach(a.sha256, a.filename)}>×</button>}
            </div>
          ))}
        </div>
      )}
      {mail.state === "draft" && mail.failure && !sendingTo && <div className={s.sentbox} style={{ background: "var(--amber-soft)", color: "var(--ink)", marginBottom: 0 }}><b>Last try didn&apos;t send:</b> {failureText(mail.failure, mail.state)}</div>}
      {!sent && (
        <div className={cx(s.bys, verdict.state === "check" && s.check, verdict.state === "stop" && s.stop)} aria-live="polite">
          <div className={s.bysh}><span className={s.spark} aria-hidden>✦</span><b>Before you send</b><span className={s.state}>{verdict.state === "ok" ? "All clear" : verdict.state === "check" ? "Check" : "Blocked"}</span></div>
          <p><strong>{lead}</strong> {verdict.issues.map(issueText)}{okLine}{hasPromise ? " Any promise in this email is in your to-dos below." : ""}</p>
        </div>
      )}
      {(sendingTo || mail.state === "sending") ? <div className={s.sentbox} style={{ background: "var(--blue-soft)", color: "var(--blue-ink)" }}>Sending to {sendingTo ?? to.join(", ")}… You can carry on; Relay tells you when it lands.</div>
        : (mail.state === "failed" || mail.state === "unknown") ? (
          <div className={s.sentbox} style={{ background: "var(--amber-soft)", color: "var(--ink)" }}>
            <b>Not sent{mail.state === "unknown" ? " (unconfirmed)" : ""}:</b> {failureText(mail.failure, mail.state)}{" "}
            <button type="button" className={s.fixl} disabled={checking} onClick={() => void checkSent()}>{checking ? "Checking Gmail…" : "Check if it went"}</button>
          </div>)
        : sent ? <div className={s.sentbox}>✓ Sent. Relay brings this back to Follow up if there&apos;s no reply.</div> : (
        <div className={s.eact}>
          <button className={cx(s.btn, arming ? s.confirm : s.pri)} type="button" disabled={blocked || sending || saving} onClick={() => void send()}>{sending ? "Sending…" : arming ? `Confirm send to ${firstName(to[0])}` : "Send"} <Arrow /></button>
          <button className={s.btn} type="button" disabled={saving} onClick={() => void toGmail()}>{draft.state === "gmail" ? "✓ In Gmail drafts" : "Add to Gmail drafts"}</button>
          <span className={s.sp} />
          {draft.role === "primary" && <button className={cx(s.btn, s.ghost)} type="button" title="No reply needed after all: marks it read and labels it Sorted in Gmail; the draft is dropped" onClick={() => void markDone()}>Done, no reply</button>}
          <button className={cx(s.btn, s.ghost)} type="button" onClick={onBack}>Back to inbox</button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- AI panel

type Bubble = { who: "bot" | "me" | "work"; text: string };

function AiPanel({ item, draft, rules, reload, say }: { item: RelayReviewItem; draft: RelayDraftView | undefined; rules: { id: string; text: string }[]; reload: () => Promise<void>; say: (t: string) => void }) {
  const [mode, setMode] = useState<"edit" | "ask" | "rules">("edit");
  const [stock, setStock] = useState(false);
  const [chat, setChat] = useState<Bubble[]>([{ who: "bot", text: draft?.source_note ? `Drafted v1 from your note: "${draft.source_note}". Edit it directly, or tell me what to change.` : "Tell me what to change in this email." }]);
  const [input, setInput] = useState("");
  const [rule, setRule] = useState("");
  const [busy, setBusy] = useState(false);
  const [agent, setAgent] = useState<{ conversation: HermesConversation; transport: "gateway" | "sse" } | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  useEffect(() => { chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight }); }, [chat]);
  useEffect(() => {
    if (mode !== "ask" || agent) return;
    api<{ conversation: HermesConversation; transport: "gateway" | "sse" }>(`/api/relay/items/${item.id}/chat`, { method: "POST" })
      .then(setAgent).catch((err) => setAgentError(err instanceof Error ? err.message : "Couldn't open the assistant."));
  }, [mode, agent, item.id]);

  const edit = async (instruction: string) => {
    if (!draft?.mail || draft.state === "sent" || busy) return;
    setChat((c) => [...c, { who: "me", text: instruction }, { who: "work", text: "Rewriting…" }]);
    setInput(""); setBusy(true);
    try {
      const r = await api<{ note: string }>(`/api/relay/drafts/${draft.id}/rewrite`, { method: "POST", body: { instruction } });
      setChat((c) => [...c.slice(0, -1), { who: "bot", text: r.note }]);
      await reload();
    } catch (err) {
      setChat((c) => [...c.slice(0, -1), { who: "bot", text: err instanceof Error ? err.message : "That didn't work. Try again." }]);
    } finally { setBusy(false); }
  };
  const saveRules = async (body: unknown, message: string) => {
    try { await api(`/api/relay/rules`, { method: "POST", body }); say(message); await reload(); } catch (err) { say(err instanceof Error ? err.message : "Couldn't save the rule."); }
  };
  const openInChat = () => { if (agent) window.open(`/?chat=${encodeURIComponent(agent.conversation.key)}`, "_blank", "noopener"); else setMode("ask"); };

  return (
    <aside className={cx(s.card, s.ai)} aria-label="Relay AI">
      <div className={s.aihead}>
        <Logo /><b>Relay AI</b>
        <button type="button" className={s.crmlink} onClick={openInChat}>Open in CRM chat ↗</button>
        <div className={s.seg} role="group" aria-label="Panel mode">
          <button type="button" aria-pressed={mode === "edit"} onClick={() => setMode("edit")}>Edit email</button>
          <button type="button" aria-pressed={mode === "ask"} onClick={() => setMode("ask")}>Ask</button>
          <button type="button" aria-pressed={mode === "rules"} onClick={() => setMode("rules")}>Writing rules</button>
        </div>
      </div>
      {mode === "edit" && (
        <>
          <div className={s.chat} ref={chatRef}>{chat.map((m, k) => <div key={k} className={cx(s.bub, s[m.who])}>{m.text}</div>)}</div>
          {stock && draft?.mail && draft.state !== "sent"
            ? <StockListForm draftId={draft.id} onClose={() => setStock(false)} onDone={async (text) => { setStock(false); setChat((c) => [...c, { who: "bot", text }]); await reload(); }} say={say} />
            : <div className={s.quick}>
                <button type="button" className={s.qstock} disabled={busy || !draft?.mail || draft.state === "sent"} onClick={() => setStock(true)}>Attach stock list</button>
                {["Shorter", "Warmer", "Firmer", "Add a clear next step"].map((q) => <button key={q} type="button" disabled={busy} onClick={() => void edit(q)}>{q}</button>)}
              </div>}
          <form className={s.ask} onSubmit={(e) => { e.preventDefault(); if (input.trim()) void edit(input.trim()); }}>
            <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Tell Relay what to change" aria-label="Edit instruction" disabled={busy} />
            <button type="submit" aria-label="Apply" disabled={busy}><Arrow /></button>
          </form>
        </>
      )}
      {mode === "ask" && (
        <div className={s.agent}>
          {agentError ? <p className={s.error} style={{ padding: 16 }}>{agentError}</p>
            : !agent ? <p className={s.muted} style={{ padding: 16 }} role="status">Opening the assistant…</p>
            : <ChatPanel key={agent.conversation.key} nativeConversationKey={agent.conversation.key} nativeTransport={agent.transport} nativeAccess={agent.conversation.access} sessionTitle={agent.conversation.title}
                fileContext={{ path: item.bulk_listing_id ? `~trades-preview/listing/${item.bulk_listing_id}` : "~crm/relay", filename: item.headline || "Relay", isDirectory: true }}
                visible compact
                onBranched={(conversation: HermesConversation) => { setAgent((a) => a && { ...a, conversation }); void api(`/api/relay/items/${item.id}/chat`, { method: "PUT", body: { key: conversation.key } }).catch(() => undefined); }} />}
        </div>
      )}
      {mode === "rules" && (
        <div className={s.rules}>
          {rules.map((r) => <div key={r.id} className={s.rule}><i>›</i><span>{r.text}</span><button type="button" aria-label="Remove rule" onClick={() => void saveRules({ delete: r.id }, "Rule removed")}>×</button></div>)}
          <form className={s.ask} style={{ padding: "6px 0 0", border: 0 }} onSubmit={(e) => { e.preventDefault(); if (rule.trim()) { void saveRules({ text: rule.trim() }, "Rule added · applies to every draft"); setRule(""); } }}>
            <input value={rule} onChange={(e) => setRule(e.target.value)} placeholder="Add a rule, e.g. sign off 'Cheers'" aria-label="New rule" />
            <button type="submit" aria-label="Add rule">+</button>
          </form>
          <span className={s.muted} style={{ fontSize: 12.5 }}>Rules apply to every draft and edit.</span>
        </div>
      )}
    </aside>
  );
}

// ---------------------------------------------------------------- Stock list

type StockFilters = { chemistry: string[]; types: string[]; makes: string[]; minKwh: number | null; countries: string[]; prices: boolean; currency: "GBP" | "EUR" };
type StockSummary = { rows: number; total_kwh: number; by_type: Record<string, number>; by_country: Record<string, number>; excluded: Record<string, number>; gaps: unknown[] };
const TYPE_OPTIONS = [["pack", "Packs"], ["module", "Modules"], ["cell", "Cells"], ["container", "Containers"]] as const;
const splitList = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);

/** Filters prefilled from the email; builds the Excel list (supplier details stripped) and attaches it. */
function StockListForm({ draftId, onClose, onDone, say }: { draftId: string; onClose: () => void; onDone: (summary: string) => Promise<void>; say: (t: string) => void }) {
  const [f, setF] = useState<StockFilters | null>(null);
  const [makes, setMakes] = useState("");
  const [countries, setCountries] = useState("");
  const [chem, setChem] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ filters: StockFilters }>(`/api/relay/drafts/${draftId}/stock-list`).then(({ filters }) => {
      setF(filters); setMakes(filters.makes.join(", ")); setCountries(filters.countries.join(", ")); setChem(filters.chemistry.join(", "));
    }).catch(() => setF({ chemistry: [], types: [], makes: [], minKwh: null, countries: [], prices: false, currency: "GBP" }));
  }, [draftId]);
  if (!f) return <p className={s.muted} style={{ padding: "0 16px 12px" }} role="status">Reading the email…</p>;
  const build = async () => {
    setBusy(true);
    try {
      const body = { ...f, chemistry: splitList(chem), makes: splitList(makes), countries: splitList(countries) };
      const { summary } = await api<{ summary: StockSummary }>(`/api/relay/drafts/${draftId}/stock-list`, { method: "POST", body });
      const types = Object.entries(summary.by_type).map(([k, v]) => `${v} ${k.toLowerCase()}${v === 1 ? "" : "s"}`).join(", ");
      const where = Object.entries(summary.by_country).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ${v}`).join(", ");
      await onDone(`Attached the stock list: ${summary.rows} rows (${types}), ${Math.round(summary.total_kwh).toLocaleString("en-GB")} kWh in total. By country: ${where}. Supplier names, towns and refs are left out.${f.prices ? "" : " No prices."} Open it under the email to check before sending.`);
    } catch (err) { say(err instanceof Error ? err.message : "Couldn't build the list."); } finally { setBusy(false); }
  };
  return (
    <form className={s.stockform} onSubmit={(e) => { e.preventDefault(); void build(); }}>
      <b>Stock list for this email</b>
      <div className={s.chips} role="group" aria-label="Types">
        {TYPE_OPTIONS.map(([key, label]) => {
          const on = f.types.includes(key);
          return <button key={key} type="button" aria-pressed={on} onClick={() => setF({ ...f, types: on ? f.types.filter((t) => t !== key) : [...f.types, key] })}>{label}</button>;
        })}
      </div>
      <label>Chemistry<input value={chem} onChange={(e) => setChem(e.target.value)} placeholder="Any, or e.g. LFP, NMC" /></label>
      <label>Makes<input value={makes} onChange={(e) => setMakes(e.target.value)} placeholder="Any, or e.g. Volkswagen, Tesla" /></label>
      <label>Countries<input value={countries} onChange={(e) => setCountries(e.target.value)} placeholder="Any, or e.g. United Kingdom, Germany" /></label>
      <label>Min kWh<input type="number" min={0} value={f.minKwh ?? ""} onChange={(e) => setF({ ...f, minKwh: e.target.value === "" ? null : Number(e.target.value) })} placeholder="Any" /></label>
      <label className={s.check}><input type="checkbox" checked={f.prices} onChange={(e) => setF({ ...f, prices: e.target.checked })} />Include prices
        {f.prices && <select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value as "GBP" | "EUR" })} aria-label="Currency"><option value="GBP">£ GBP</option><option value="EUR">€ EUR</option></select>}
      </label>
      <span className={s.muted} style={{ fontSize: 12.5 }}>Excel, one row per lot. Country only: no supplier names, towns, refs or links.</span>
      <div className={s.acts}>
        <button type="button" className={cx(s.btn, s.ghost)} onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className={cx(s.btn, s.blue)} disabled={busy}>{busy ? "Building…" : "Build and attach"}</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- To-dos

function Todos({ todos, reload, say }: { todos: RelayTodo[]; reload: () => Promise<void>; say: (t: string) => void }) {
  const [title, setTitle] = useState("");
  const [adding, setAdding] = useState(false);
  const add = async () => {
    if (!title.trim() || adding) return;
    setAdding(true);
    try { const r = await api<{ reb_key: string }>(`/api/relay/todos`, { method: "POST", body: { title: title.trim() } }); setTitle(""); say(`Added · ${r.reb_key} in Work Tasks`); await reload(); }
    catch (err) { say(err instanceof Error ? err.message : "Couldn't add it."); } finally { setAdding(false); }
  };
  const act = async (t: RelayTodo, action: "done") => {
    try { await api(`/api/relay/todos/${t.id}`, { method: "POST", body: { action } }); say("Nice. Marked done in Work Tasks"); await reload(); } catch (err) { say(err instanceof Error ? err.message : "Couldn't update."); }
  };
  return (
    <section aria-label="To-dos">
      <div className={s.phead}><span className={s.tag}>To-dos · synced to Work Tasks</span></div>
      <form className={cx(s.card, s.addtodo)} onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a to-do, e.g. call Lubomír about the Brno delivery" aria-label="New to-do" disabled={adding} />
        <button type="submit" className={cx(s.btn, s.blue)} disabled={!title.trim() || adding}>{adding ? "Adding…" : "Add"}</button>
      </form>
      <div className={s.card} style={{ marginTop: 10 }}>
        {!todos.length ? <div className={s.empty}><b>No to-dos yet</b><span className={s.muted}>Add one above, or accept suggestions under any email in Review.</span></div> : (
          <>
            <div className={cx(s.trow, s.h)}><span /><span>To-do</span><span>From</span><span>Work Task</span></div>
            {todos.map((t) => (
              <div key={t.id} className={cx(s.trow, t.state === "done" && s.done)}>
                <button type="button" className={cx(s.cb, t.state === "done" && s.on)} aria-label="Mark done" disabled={t.state === "done"} onClick={() => void act(t, "done")}>{t.state === "done" ? "✓" : ""}</button>
                <div style={{ minWidth: 0 }}><b>{t.title}</b>{t.detail && <div className={s.muted} style={{ fontSize: 13 }}>{t.detail}</div>}</div>
                <span className={s.muted}>{t.source ?? "You"}</span>
                {t.reb_key ? <span className={s.key}>{t.reb_key}</span> : <span />}
              </div>
            ))}
          </>
        )}
      </div>
    </section>
  );
}

/** Suggested to-dos under a draft, plus any promise Relay spots in the copy ("I'll send the stock list"). */
Todos.Suggested = function Suggested({ item, draft, reload, say }: { item: RelayReviewItem; draft: RelayDraftView | undefined; reload: () => Promise<void>; say: (t: string) => void }) {
  const [hidden, setHidden] = useState<string[]>([]);
  const known = item.todos.map((t) => t.title.toLowerCase());
  const spotted = draft?.role === "primary" && draft.mail ? promisesIn(draft.mail.main).filter((p) => !known.includes(p.toLowerCase()) && !hidden.includes(p)) : [];
  if (!item.todos.length && !spotted.length) return null;
  const accept = async (t: RelayTodo) => { try { const r = await api<{ reb_key: string }>(`/api/relay/todos/${t.id}`, { method: "POST", body: { action: "accept" } }); say(`Added to To-dos · ${r.reb_key}`); await reload(); } catch (err) { say(err instanceof Error ? err.message : "Couldn't add it."); } };
  const dismiss = async (t: RelayTodo) => { try { await api(`/api/relay/todos/${t.id}`, { method: "POST", body: { action: "dismiss" } }); await reload(); } catch { say("Couldn't dismiss it."); } };
  const acceptPromise = async (title: string) => { setHidden((h) => [...h, title]); try { const r = await api<{ reb_key: string }>(`/api/relay/items/${item.id}/todos`, { method: "POST", body: { title } }); say(`Added to To-dos · ${r.reb_key}`); await reload(); } catch (err) { setHidden((h) => h.filter((x) => x !== title)); say(err instanceof Error ? err.message : "Couldn't add it."); } };
  const Row = ({ title, detail, promise, accepted, onAccept, onDismiss }: { title: string; detail: string; promise: boolean; accepted?: string | null; onAccept: () => void; onDismiss: () => void }) => (
    <div className={cx(s.card, s.todo)} style={accepted ? { opacity: .6 } : undefined}>
      <span className={s.tic}>✓</span>
      <div className={s.tt}><b>{title}</b><span>{detail}</span></div>
      {promise && <span className={cx(s.pill, s.warn)}><i />Your promise</span>}
      <div className={s.acts}>{accepted !== undefined ? <span className={cx(s.pill, s.ok)}><i />Added{accepted ? ` · ${accepted}` : ""}</span> : <><button className={s.btn} type="button" onClick={onDismiss}>Dismiss</button><button className={cx(s.btn, s.blue)} type="button" onClick={onAccept}>Accept</button></>}</div>
    </div>
  );
  return (
    <div>
      <div className={s.sec}><h3>Suggested to-dos</h3><span>Accept to add them to To-dos and Work Tasks.</span></div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {spotted.map((p) => <Row key={p} title={p} detail="Promised in this email" promise onAccept={() => void acceptPromise(p)} onDismiss={() => setHidden((h) => [...h, p])} />)}
        {item.todos.map((t) => <Row key={t.id} title={t.title} detail={t.detail} promise={t.kind === "promise"} accepted={t.state === "accepted" ? t.reb_key : undefined} onAccept={() => void accept(t)} onDismiss={() => void dismiss(t)} />)}
      </div>
    </div>
  );
};
