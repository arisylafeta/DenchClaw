"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { ChevronLeft, Search } from "lucide-react";
import type { RelayCounts, RelayItem, RelayReviewItem } from "@/lib/relay";
import type { WaitingView } from "@/lib/relay-rank";
import type { RankBand } from "@/lib/relay-rank-core";
import { sendSlots, sendLabel, undoSecondsLeft } from "@/lib/relay-send-time";
import { listEntries, matchesRow, tagTone, visibleRows, waitedDays, type ListBand } from "@/lib/relay-workspace-core";
import { api, cx } from "./relay-ui";
import { Work, type Say, type Toast } from "./relay-workspace-work";
import w from "./relay-workspace.module.css";

/**
 * The new Relay (Relay v2, board "Final"): who is waiting on Alex on the left, their newest email and the reply with
 * its linked emails in the middle, and Relay's chat on the right. RelayView shows it behind the "Try the new Relay"
 * switch; the old pages stay one click away. Nothing here sends without Alex pressing Send.
 */

type Summary = { counts: RelayCounts; items: RelayItem[]; review: RelayReviewItem[]; scannedAt: string | null; mailSyncedAt: string | null };
type View = "waiting" | "chase" | "drafts" | "done";
/** A person or an email in the list, whatever the view. */
type Row = { key: string; itemId: string; name: string; ask: string; waited: string; tag: string | null; reviewIds: string[]; itemIds?: string[]; waitingSince?: string | null; scheduledAt?: string | null };

const daysLabel = (since: string | null | undefined) => {
  const days = since ? Math.floor((Date.now() - new Date(since).getTime()) / 86_400_000) : 0;
  return days <= 0 ? "today" : `${days} d`;
};
const itemRow = (i: RelayItem, tag: string | null): Row => ({
  key: i.id, itemId: i.id, name: i.counterpart_name || i.counterpart_email || "Unknown", ask: i.headline, waited: daysLabel(i.waiting_since), waitingSince: i.waiting_since, tag, reviewIds: [],
});
const typing = (e: KeyboardEvent) => {
  const el = e.target as HTMLElement | null;
  return e.metaKey || e.ctrlKey || e.altKey || !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
};

export function RelayWorkspace({ onBack, onOpenPage, onOpenListing, onOpenMailMessage }: {
  onBack: () => void; onOpenPage: (page: "rules" | "todos") => void;
  /** Open a deal, or an email as sent, in a new CRM tab. */
  onOpenListing?: (id: string, title?: string) => void; onOpenMailMessage?: (id: string, title?: string) => void;
}) {
  const [view, setView] = useState<View>("waiting");
  const [waiting, setWaiting] = useState<WaitingView | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [follow, setFollow] = useState<RelayItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Partial<Record<ListBand, boolean>>>({});
  const [picked, setPicked] = useState<Row | null>(null);
  /** On a phone the list and the email are separate views. */
  const [pane, setPane] = useState<"list" | "work">("list");
  const [texts, setTexts] = useState<Record<string, string>>({});
  const composer = useRef<HTMLTextAreaElement | null>(null);
  const workPane = useRef<HTMLDivElement>(null);

  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [, tick] = useState(0);
  const say = useCallback<Say>((text, more) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ text, ...more });
    toastTimer.current = setTimeout(() => setToast(null), more?.until ? Math.max(0, more.until - Date.now()) : more?.action ? 9000 : more?.undo ? 6000 : 3200);
  }, []);
  useEffect(() => {
    if (!toast?.until) return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [toast?.until]);

  const loadWaiting = useCallback(async () => {
    try { setWaiting(await api<WaitingView>("/api/relay/waiting")); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : "Couldn't load who is waiting."); }
  }, []);
  const loadSummary = useCallback(async () => {
    try { setSummary(await api<Summary>("/api/relay/summary?tab=action")); }
    catch (err) { setError(err instanceof Error ? err.message : "Couldn't load Relay."); }
  }, []);
  const loadFollow = useCallback(async () => {
    try { setFollow((await api<{ items: RelayItem[] }>("/api/relay/summary?tab=follow")).items); }
    catch (err) { setError(err instanceof Error ? err.message : "Couldn't load the chases."); }
  }, []);
  const reloadLists = useCallback(async () => { await Promise.all([loadWaiting(), loadSummary(), view === "chase" ? loadFollow() : undefined]); }, [loadWaiting, loadSummary, loadFollow, view]);
  useEffect(() => { void loadWaiting(); void loadSummary(); }, [loadWaiting, loadSummary]);
  useEffect(() => { if (view === "chase" && !follow) void loadFollow(); }, [view, follow, loadFollow]);
  // New mail is sorted about every 10 minutes: refresh each minute while the page is on screen.
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === "visible") void reloadLists(); }, 60_000);
    return () => clearInterval(t);
  }, [reloadLists]);

  // ---- the list for the view on show
  const entries = useMemo(() => (waiting ? listEntries(waiting.bands, { open, query, scheduled: waiting.scheduled ?? [] }) : []), [waiting, open, query]);
  const rows: Row[] = useMemo(() => {
    if (view === "waiting") return visibleRows(entries).map((r) => ({ key: r.key, itemId: r.openId, name: r.name, ask: r.ask, waited: r.scheduledAt ? sendLabel(r.scheduledAt) : r.waited, waitingSince: r.waitingSince, tag: r.scheduledAt ? "Scheduled" : r.tag, reviewIds: r.reviewIds, itemIds: r.itemIds, scheduledAt: r.scheduledAt }));
    const list = view === "chase" ? (follow ?? []).map((i) => itemRow(i, null)) : view === "drafts" ? (summary?.review ?? []).map((i) => itemRow(i, "Draft ready")) : [];
    return query.trim() ? list.filter((r) => matchesRow({ name: r.name, company: null, ask: r.ask }, query)) : list;
  }, [view, entries, follow, summary, query]);
  const listReady = view === "waiting" ? !!waiting : view === "chase" ? !!follow : view === "drafts" ? !!summary : true;

  // The first row opens by itself on a wide screen; a phone starts on the list.
  useEffect(() => {
    if (picked || !rows.length) return;
    setPicked(rows[0]);
  }, [rows, picked]);
  const pick = useCallback((row: Row) => { setPicked(row); setPane("work"); }, []);
  /** Opens another person's email (the thread a linked reply is on): as their own row when they're waiting, never under this name. */
  const openOther = useCallback((itemId: string, name: string) => {
    const row = waiting ? [...Object.values(waiting.bands).flat(), ...(waiting.scheduled ?? [])].find((r) => r.openId === itemId || r.itemIds?.includes(itemId)) : undefined;
    pick(row ? { key: row.key, itemId, name: row.name, ask: row.ask, waited: row.scheduledAt ? sendLabel(row.scheduledAt) : row.waited, waitingSince: row.waitingSince, tag: row.scheduledAt ? "Scheduled" : row.tag, reviewIds: row.openId === itemId ? row.reviewIds : [], itemIds: row.itemIds, scheduledAt: row.scheduledAt }
      : { key: itemId, itemId, name, ask: "", waited: "", tag: null, reviewIds: [] });
  }, [waiting, pick]);
  // Below 1024 the email and the chat scroll as one pane: each person starts at the top.
  useEffect(() => { workPane.current?.scrollTo({ top: 0 }); }, [picked?.itemId]);
  const move = useCallback((step: number) => {
    if (!rows.length) return;
    const at = rows.findIndex((r) => r.key === picked?.key);
    const next = rows[Math.min(rows.length - 1, Math.max(0, at < 0 ? 0 : at + step))];
    setPicked(next);
    document.getElementById(`relay-row-${next.key}`)?.scrollIntoView({ block: "nearest" });
  }, [rows, picked]);
  const switchView = (next: View) => { setView(next); setPicked(null); setPane("list"); };

  const allItems = useMemo(() => [...(summary?.items ?? []), ...(summary?.review ?? []), ...(follow ?? [])], [summary, follow]);
  const item = picked ? allItems.find((i) => i.id === picked.itemId) ?? null : null;
  const job = picked ? summary?.review.find((i) => i.id === picked.itemId)?.job ?? null : null;

  /** Leaves the picked person out of the list at once and opens the next one. */
  const leave = useCallback((row: Row) => {
    const at = rows.findIndex((r) => r.key === row.key);
    const next = rows[at + 1] ?? rows[at - 1] ?? null;
    setWaiting((v) => v && { ...v, scheduled: (v.scheduled ?? []).filter((r) => r.key !== row.key), bands: Object.fromEntries(Object.entries(v.bands).map(([b, list]) => [b, list.filter((r) => r.key !== row.key)])) as WaitingView["bands"] });
    setPicked(next && next.key !== row.key ? next : null);
    if (!next) setPane("list");
  }, [rows]);

  const markDone = useCallback(async (row: Row) => {
    try {
      await api(`/api/relay/items/${row.itemId}/done`, { method: "POST" });
      leave(row);
      say(`${row.name}: no reply needed. Marked read and labelled Sorted in Gmail.`, {
        undo: async () => {
          try { await api(`/api/relay/items/${row.itemId}`, { method: "PATCH", body: { status: "open", done_reason: "" } }); await reloadLists(); }
          catch (err) { say(err instanceof Error ? err.message : "Couldn't undo that."); }
        },
      });
      void reloadLists();
    } catch (err) { say(err instanceof Error ? err.message : "Couldn't mark it done."); }
  }, [leave, say, reloadLists]);
  /** Snoozes every email of the person's row until then: they all come back together. */
  const snooze = useCallback(async (row: Row, until: string) => {
    const ids = [...new Set([row.itemId, ...(row.itemIds ?? []), ...row.reviewIds])];
    const set = (value: string | null) => Promise.all(ids.map((id) => api(`/api/relay/items/${id}`, { method: "PATCH", body: { snooze_until: value } })));
    try {
      await set(until);
      leave(row);
      say(`Snoozed ${row.name} until ${sendLabel(until)}.`, {
        undo: async () => {
          try { await set(null); await reloadLists(); }
          catch (err) { say(err instanceof Error ? err.message : "Couldn't undo that."); }
        },
      });
      void reloadLists();
    } catch (err) { say(err instanceof Error ? err.message : "Couldn't snooze it."); }
  }, [leave, say, reloadLists]);

  // J and K move, R goes to the chat to answer, E is no reply needed.
  const keys = useRef({ move, markDone, picked });
  keys.current = { move, markDone, picked };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e)) return;
      const k = e.key.toLowerCase();
      if (k === "j" || k === "k") { e.preventDefault(); keys.current.move(k === "j" ? 1 : -1); }
      else if (k === "r" && keys.current.picked) { e.preventDefault(); setPane("work"); composer.current?.focus(); }
      else if (k === "e" && keys.current.picked && view === "waiting") { e.preventDefault(); void keys.current.markDone(keys.current.picked); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view]);

  const counts = waiting?.counts;
  const views: [View, string, number | null][] = [
    ["waiting", "Waiting on you", counts?.waiting ?? null], ["chase", "Chase due", counts?.chase ?? null],
    ["drafts", "Drafts", counts?.drafts ?? null], ["done", "Done today", counts?.done_today ?? null],
  ];
  const mailAge = summary?.mailSyncedAt ? Math.max(0, Math.round((Date.now() - new Date(summary.mailSyncedAt).getTime()) / 60_000)) : null;
  const textOf = picked ? texts[picked.itemId] ?? "" : "";
  const setText = useCallback((itemId: string) => (next: SetStateAction<string>) =>
    setTexts((m) => ({ ...m, [itemId]: typeof next === "function" ? next(m[itemId] ?? "") : next })), []);

  return (
    <div className={w.ws} data-pane={pane}>
      <header className={w.top}>
        <span className={w.brand}><span className={w.logo} aria-hidden><i /></span>Relay</span>
        <div className={w.views} role="tablist" aria-label="Show">
          {views.map(([key, label, n]) => (
            <button key={key} type="button" role="tab" aria-selected={view === key} onClick={() => switchView(key)}>
              {label}{n != null && <span>{n}</span>}
            </button>
          ))}
        </div>
        <label className={w.search}>
          <Search size={14} aria-hidden />
          <input value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Find a person, deal or email" placeholder="Find a person, deal or email" />
        </label>
        <span className={w.links}>
          {mailAge != null && <span className={cx(w.fresh, mailAge > 25 && w.stale)}><i aria-hidden />Gmail checked {mailAge < 1 ? "just now" : `${mailAge} min ago`}</span>}
          <button type="button" onClick={() => onOpenPage("rules")}>Rules</button>
          <button type="button" onClick={() => onOpenPage("todos")}>To-dos{summary ? ` ${summary.counts.todos}` : ""}</button>
          <button type="button" className={w.quiet} onClick={onBack}>Back to the old Relay</button>
        </span>
      </header>

      <div className={w.body}>
        <nav className={w.list} aria-label={views.find(([k]) => k === view)?.[1]}>
          {error && <p className={w.error} role="alert">{error} <button type="button" className={w.linkbtn} onClick={() => void reloadLists()}>Try again</button></p>}
          {!listReady && !error && <p className={w.muted} role="status">Loading…</p>}
          {listReady && view === "waiting" && waiting && (
            <WaitingList entries={entries} picked={picked?.key ?? null} onPick={pick} total={waiting.counts.waiting}
              onOpen={(band) => setOpen((o) => ({ ...o, [band]: !o[band] }))} searching={!!query.trim()} />
          )}
          {listReady && (view === "chase" || view === "drafts") && (
            <>
              <span className={w.listHead}>{view === "chase" ? "Chase due" : "Drafts"} <span>{rows.length}</span></span>
              {rows.length ? (
                <ol className={w.rows}>{rows.map((r) => <li key={r.key}><RowButton row={r} current={picked?.key === r.key} onPick={pick} /></li>)}</ol>
              ) : <p className={w.muted}>{query.trim() ? "Nothing matches." : view === "chase" ? "No one to chase." : "No drafts waiting."}</p>}
            </>
          )}
          {view === "done" && <p className={w.muted}>{counts?.done_today ?? 0} done today. They stay in Gmail, labelled Sorted.</p>}
          <span className={w.keys}>J and K to move, R to reply, E for no reply needed</span>
        </nav>

        <div className={w.work} ref={workPane}>
          {picked ? (
            <Work key={picked.itemId} itemId={picked.itemId} name={picked.name} waited={view === "waiting" && !picked.scheduledAt ? picked.waited : null} waitingSince={view === "waiting" && !picked.scheduledAt ? picked.waitingSince ?? null : null} item={item} job={job}
              reviewIds={picked.reviewIds} autoDraft={view === "waiting"} onOpenDeal={onOpenListing} onOpenMail={onOpenMailMessage} say={say} text={textOf} setText={setText(picked.itemId)} composer={composer}
              onDone={view === "waiting" ? () => void markDone(picked) : undefined} onSnooze={view === "waiting" ? (until) => void snooze(picked, until) : undefined}
              onOpen={(itemId, other) => (other ? openOther(itemId, other) : setPicked({ ...picked, key: itemId, itemId, reviewIds: [] }))} onBack={() => setPane("list")} refreshLists={reloadLists} />
          ) : (
            <section className={w.empty}>
              <button type="button" className={w.back} onClick={() => setPane("list")}><ChevronLeft size={14} aria-hidden />Back to the list</button>
              {listReady && !error && (view === "waiting" && !rows.length ? (
                <p className={w.calm}><b>Nothing waiting on you.</b>{counts?.chase ? <> <button type="button" className={w.linkbtn} onClick={() => switchView("chase")}>{counts.chase} {counts.chase === 1 ? "chase is" : "chases are"} due</button></> : null}</p>
              ) : <p>{view === "done" ? "Done for today." : "Pick someone from the list."}</p>)}
            </section>
          )}
        </div>
      </div>

      <div className={cx(w.toast, toast && w.on)} role="status" aria-live="polite">
        <span>{toast?.text}{toast?.until ? ` ${undoSecondsLeft(new Date(toast.until))} s` : ""}</span>
        {toast?.action && <button type="button" onClick={() => { void toast.action?.run(); setToast(null); }}>{toast.action.label}</button>}
        {toast?.undo && <button type="button" onClick={() => { void toast.undo?.(); setToast(null); }}>Undo</button>}
      </div>
    </div>
  );
}

function RowButton({ row, current, onPick }: { row: Row; current: boolean; onPick: (row: Row) => void }) {
  const tone = tagTone(row.tag);
  return (
    <button type="button" id={`relay-row-${row.key}`} className={w.row} aria-current={current || undefined} onClick={() => onPick(row)}>
      <span className={w.rowTop}>
        <b>{row.name}</b>
        <span className={cx(waitedDays(row.waited) >= 7 && w.late)}>{row.waited}</span>
      </span>
      <span className={w.rowAsk}>{row.tag && <span className={cx(w.tag, tone === "acc" && w.acc, tone === "err" && w.err)}>{row.tag} </span>}{row.ask}</span>
    </button>
  );
}

/** "Waiting on you" by band: Now and Today open, the rest of today behind More, This week and Later folded. */
function WaitingList({ entries, picked, total, searching, onPick, onOpen }: {
  entries: ReturnType<typeof listEntries>; picked: string | null; total: number; searching: boolean; onPick: (row: Row) => void; onOpen: (band: ListBand) => void;
}) {
  let folds = 0;
  return (
    <>
      <span className={w.listHead}>Waiting on you <span>{total}</span></span>
      {!entries.length && searching && <p className={w.muted}>Nothing matches.</p>}
      <ol className={w.rows}>
        {entries.map((e) => {
          if (e.kind === "head") return <li key={`h-${e.band}`}><span className={w.band}>{e.label} <span>{e.n}</span></span></li>;
          if (e.kind === "more") return <li key={`m-${e.band}`}><button type="button" className={w.more} onClick={() => onOpen(e.band)}>{e.n} more today</button></li>;
          if (e.kind === "fold") {
            const first = e.band !== "scheduled" && folds++ === 0;
            return (
              <li key={`f-${e.band}`} className={cx(first && w.foldFirst, e.band === "scheduled" && w.foldScheduled)}>
                <button type="button" className={w.fold} aria-expanded={e.open} onClick={() => onOpen(e.band)} disabled={searching}><span>{e.label}</span><span>{e.n}</span></button>
              </li>
            );
          }
          const r = e.row;
          // A scheduled reply shows when it goes instead of how long they've waited.
          const row: Row = { key: r.key, itemId: r.openId, name: r.name, ask: r.ask, waited: r.scheduledAt ? sendLabel(r.scheduledAt) : r.waited, waitingSince: r.waitingSince,
            tag: r.scheduledAt ? "Scheduled" : r.tag, reviewIds: r.reviewIds, itemIds: r.itemIds, scheduledAt: r.scheduledAt };
          return <li key={r.key}><RowButton row={row} current={picked === r.key} onPick={onPick} /></li>;
        })}
      </ol>
    </>
  );
}
