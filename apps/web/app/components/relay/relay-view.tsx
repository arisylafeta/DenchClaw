"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HermesConversation } from "@/lib/hermes-conversations";
import { describeWhen, parseWhen } from "@/lib/relay-when";
import { londonInputValue, londonWallToUtc, sendAtProblem, sendLabel, sendSlots, undoSecondsLeft, UNDO_SEND_SECONDS } from "@/lib/relay-send-time";
import type { RelayDealOption, RelayDraftView, RelayItem, RelayJob, RelayReviewItem, RelayRule, RelayTab, RelayTask, RelayTodo } from "@/lib/relay";
import { missingInstruction, type ChecklistItem, type DealChecklist } from "@/lib/relay-checklist";
import { BULK_RULE_TEXT } from "@/lib/relay-front-door";
import { beforeYouSend, NEEDS_AGENT, promisesIn, senderRuleMatch, type Issue } from "@/lib/relay-checks";
import { isSenderKey, SENDERS } from "@/lib/relay-senders";
import { chaseLabel } from "@/lib/chase-clock";
import { AttachmentStrip } from "@/app/components/crm/inbox/attachment-strip";
import { Lanes, useSuggestions } from "./relay-lanes";
import { LeadCards, useLeadCards } from "./relay-lead-card";
import { JulesFlag } from "./relay-jules-flag";
import { api, colour, cx, firstName, initials } from "./relay-ui";
import s from "./relay.module.css";

const ChatPanel = dynamic(() => import("@/app/components/chat-panel").then((m) => m.ChatPanel), { ssr: false });

type Counts = { action: number; follow: number; other: number; review: number; todos: number; sent_today: number; done_today: number; scheduled: number };
type SenderRule = { id: string; match: string; tab: "action" | "other" };
type Summary = { tab: RelayTab; counts: Counts; items: RelayItem[]; review: RelayReviewItem[]; todos: RelayTask[]; scheduled: RelayTask[]; rules: RelayRule[]; senderRules: SenderRule[]; learnRun: LearnRun | null; voice: VoiceInfo | null; scannedAt: string | null; mailSyncedAt: string | null; avgReplyMinutes: number | null };
/** A second button on the toast, next to Undo. */
type ToastAction = { label: string; run: () => void | Promise<void> };
/** `until` (ms) keeps the toast up until then and counts the seconds down after the text: the undo window after Send. */
type Say = (text: string, undo?: () => void, action?: ToastAction, until?: number) => void;
type Page = "inbox" | "leads" | "follow" | "other" | "review" | "todos" | "rules";
/** The inbox as lanes is what Relay opens on. The table it replaced stays one click away, remembered on this device. */
const NEW_INBOX_KEY = "relay.newInbox";
/** The emails each page lists. The lanes are the emails that need a reply. */
const PAGE_TAB: Partial<Record<Page, RelayTab>> = { inbox: "action", follow: "follow", other: "other" };
type LearnRun = { ran_at: string; sent: number; unchanged: number; edited: number; proposed: number; note: string };
type VoiceInfo = { version: number; created_at: string; source_emails: number | null; eval: { judge_after_wins?: number; judge_before_wins?: number; n?: number } | null; guide: string };

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

const Clock = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
const Arrow = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
const Logo = () => <span className={s.logo}><i /></span>;

export function RelayView({ onOpenListing, onOpenMailMessage, onOpenCompany }: { onOpenListing?: (id: string, title?: string) => void; onOpenMailMessage?: (id: string, title?: string) => void; onOpenCompany?: (id: string) => void }) {
  const [page, setPage] = useState<Page>("inbox");
  const [tab, setTab] = useState<RelayTab>("action");
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; undo?: () => void; action?: ToastAction; until?: number } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [, tick] = useState(0);

  const say = useCallback<Say>((text, undo, action, until) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ text, undo, action, until });
    toastTimer.current = setTimeout(() => setToast(null), until ? Math.max(0, until - Date.now()) : action ? 9000 : undo ? 6000 : 2800);
  }, []);
  const counting = !!toast?.until;
  useEffect(() => {
    if (!counting) return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [counting]);

  // The list now on show. An answer for a list Alex has since left is dropped, and a late refresh loads this one.
  const tabNow = useRef(tab);
  tabNow.current = tab;
  const load = useCallback(async (which: RelayTab) => {
    try {
      const next = await api<Summary>(`/api/relay/summary?tab=${which}`);
      if (which !== tabNow.current) return;
      setData(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load Relay.");
    }
  }, []);
  useEffect(() => { void load(tab); }, [tab, load]);
  // null until this device's choice is read, so the old table never shows for a moment before the lanes.
  const [lanesOn, setLanesOn] = useState<boolean | null>(null);
  useEffect(() => { try { setLanesOn(localStorage.getItem(NEW_INBOX_KEY) !== "off"); } catch { setLanesOn(true); } }, []);
  const fresh = lanesOn !== false;
  /** In the new inbox each page lists its own emails; the old table picks them with its inner tabs. */
  const goto = useCallback((next: Page) => {
    setPage(next);
    const list = PAGE_TAB[next];
    if (fresh && list) setTab(list);
  }, [fresh]);
  const switchLanes = (on: boolean) => {
    setLanesOn(on);
    try { localStorage.setItem(NEW_INBOX_KEY, on ? "on" : "off"); } catch { /* not remembered */ }
    setPage("inbox");
    setTab("action");
  };
  const leads = useLeadCards(lanesOn === true);
  /** The lead card to open: the one whose row was clicked in the lanes. */
  const [leadAt, setLeadAt] = useState<string | null>(null);
  // Send holds the email on the server for 30 seconds, with Undo, then sends it. The page moves on, watches the
  // message's own state, and reports the outcome: Sent, or why not. The send does not depend on this tab staying open.
  const [sending, setSending] = useState<Record<string, string>>({});
  const undoSend = useCallback(async (draftId: string, toLabel: string) => {
    try {
      await api(`/api/relay/drafts/${draftId}/schedule`, { method: "DELETE" });
      setSending((m) => Object.fromEntries(Object.entries(m).filter(([id]) => id !== draftId)));
      say(`Stopped. The email to ${toLabel} is a draft again, in Review.`);
      void load(tabNow.current);
      return true;
    } catch (err) {
      say(err instanceof Error ? err.message : "Couldn't stop it.");
      return false;
    }
  }, [say, load]);
  const startSend = useCallback(async (draftId: string, updatedAt: string, toLabel: string) => {
    try {
      const held = await api<{ undo_seconds?: number }>(`/api/relay/drafts/${draftId}/send`, { method: "POST", body: { confirm: true, updated_at: updatedAt } });
      setSending((m) => ({ ...m, [draftId]: toLabel }));
      say(`Sending to ${toLabel}`, () => void undoSend(draftId, toLabel), undefined, Date.now() + (held.undo_seconds ?? UNDO_SEND_SECONDS) * 1000);
      void load(tabNow.current);
      return true;
    } catch (err) {
      say(`Not sent: ${err instanceof Error ? err.message : "something went wrong"}`);
      return false;
    }
  }, [say, load, undoSend]);
  // While Matcha creates or updates a deal, check every few seconds so its result shows on the email.
  const dealBusy = !!data?.items.some(dealWorking);
  useEffect(() => {
    if (!dealBusy) return;
    const t = setInterval(() => void load(tab), 6000);
    return () => clearInterval(t);
  }, [dealBusy, load, tab]);
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
  // The scan reads Gmail and sorts it about every 10 minutes; refresh the page each minute so new mail and the times show up.
  useEffect(() => {
    const id = setInterval(() => { tick((n) => n + 1); if (document.visibilityState === "visible") void load(tab); }, 60_000);
    return () => clearInterval(id);
  }, [tab, load]);

  const counts = data?.counts;
  const total = counts ? counts.action + counts.review + counts.sent_today + counts.done_today : 0;
  const handled = counts ? counts.sent_today + counts.done_today : 0;
  const pct = total ? Math.round(((handled + (counts?.review ?? 0) * 0.5) / total) * 100) : 100;
  const score = counts ? Math.min(99, Math.round(pct * 0.6 + Math.min(40, counts.sent_today * 4 + counts.done_today))) : 0;
  const minutesSince = (iso: string | null | undefined) => (iso ? Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000)) : null);
  const scanned = minutesSince(data?.scannedAt);
  const mailAge = minutesSince(data?.mailSyncedAt);
  // Fresh means Gmail was read recently, not just that the scan ran on old mail.
  const freshness = scanned == null ? "Waiting for the first scan"
    : scanned > 25 ? `Last scan ${ago(data?.scannedAt)} ago`
    : mailAge != null && mailAge > 25 ? `Sorted ${scanned} min ago · Gmail last read ${ago(data?.mailSyncedAt)} ago`
    : mailAge != null ? `Checked Gmail ${mailAge} min ago` : `Sorted ${scanned} min ago`;
  const stale = scanned != null && (scanned > 25 || (mailAge != null && mailAge > 25));
  const ring = 2 * Math.PI * 25;
  const proposed = data?.rules.filter((r) => r.state === "proposed").length ?? 0;
  const nav: [Page, string, number][] = fresh
    ? [["inbox", "Inbox", counts?.action ?? 0], ["review", "Review", counts?.review ?? 0], ["follow", "Follow-ups", counts?.follow ?? 0], ["todos", "To-dos", counts?.todos ?? 0], ["rules", "Rules", proposed]]
    : [["inbox", "Inbox", counts ? counts.action + counts.follow : 0], ["review", "Review", counts?.review ?? 0], ["todos", "To-dos", counts?.todos ?? 0], ["rules", "Rules", proposed]];
  // A lead card and the no-reply list are opened from the inbox and belong to it.
  const navAt: Page = page === "leads" || page === "other" ? "inbox" : page;

  return (
    <div className={cx(s.root, fresh && s.fresh)}>
      <div className={s.wrap}>
        <div className={s.top}>
          <div className={s.brand}><Logo />Relay</div>
          <div className={s.tabs} role="tablist" aria-label="Relay">
            {nav.map(([key, label, n]) => (
              <button key={key} role="tab" type="button" aria-selected={navAt === key} onClick={() => goto(key)}>{label}{(!fresh || n > 0) && <> <span className={s.n}>{n}</span></>}</button>
            ))}
          </div>
          {lanesOn === false && (
            <button type="button" role="switch" aria-checked={false} className={s.leadswitch} onClick={() => switchLanes(true)} title="The inbox sorted into lanes: new leads with the reply ready, deal replies, and answers to pick for the rest. Nothing is sent until you press Send.">
              <i aria-hidden /><span>New inbox</span>
            </button>
          )}
          <div className={s.scan} title="Relay reads new Gmail and sorts it about every 10 minutes">
            <span className={cx(s.pulse, stale && s.stale)} />
            <span>{freshness}</span>
          </div>
        </div>

        {!(fresh && (page === "inbox" || page === "leads")) && <div className={cx(s.card, s.score)}>
          <div className={s.meter}>
            <div className={s.ring}><svg viewBox="0 0 58 58"><circle cx="29" cy="29" r="25" stroke="var(--soft)" /><circle cx="29" cy="29" r="25" stroke="var(--blue)" strokeDasharray={ring} strokeDashoffset={ring * (1 - pct / 100)} /></svg><em className={s.num}>{pct}%</em></div>
            <div><b>Today</b><span>{handled} of {total} done</span></div>
          </div>
          <div><b className={s.num}>{counts?.sent_today ?? 0}</b><span>Replies sent</span></div>
          <div><b className={s.num}>{counts?.review ?? 0}</b><span>In review</span></div>
          <div><b className={s.num}>{duration(data?.avgReplyMinutes ?? null)}</b><span>Avg. reply time</span></div>
          <div><b className={s.num}><span className={s.dot} />{score}</b><span>Relay score</span></div>
        </div>}

        {error && <p className={s.error} role="alert">{error}</p>}
        {!data && !error && <p className={s.muted} role="status">Loading Relay…</p>}
        {data && page === "inbox" && lanesOn === false && <Inbox data={data} tab={tab} setTab={setTab} reload={() => load(tab)} say={say} onOpenListing={onOpenListing} onOpenCompany={onOpenCompany} onDrafted={() => setPage("review")} />}
        {data && page === "inbox" && lanesOn && (
          <LanesInbox data={data} leads={leads} reload={() => load("action")} say={say} onOpenListing={onOpenListing} onOpenCompany={onOpenCompany} onDrafted={() => setPage("review")}
            onLead={(cardId) => { setLeadAt(cardId); setPage("leads"); }} onGo={goto} onOld={() => switchLanes(false)} />
        )}
        {data && lanesOn && (page === "follow" || page === "other") && <Inbox data={data} tab={tab} setTab={setTab} only={page} onBack={() => goto("inbox")} reload={() => load(tab)} say={say} onOpenListing={onOpenListing} onOpenCompany={onOpenCompany} onDrafted={() => setPage("review")} />}
        {page === "leads" && lanesOn && (
          <LeadCards data={leads.data} error={leads.error} reload={leads.reload} say={say} start={leadAt} onInbox={() => goto("inbox")}
            onReview={() => { setPage("review"); void load(tab); }}
            // The outcome watcher reads a missing draft as sent, so the draft has to be on the page before it is watched.
            onQueued={async (draftId, to) => { await load(tab); setSending((m) => ({ ...m, [draftId]: to })); }}
            onUndone={(draftId) => { setSending((m) => Object.fromEntries(Object.entries(m).filter(([id]) => id !== draftId))); void load(tab); }} />
        )}
        {data && page === "review" && <Review data={data} reload={() => load(tab)} say={say} onBack={() => goto("inbox")} sending={sending} startSend={startSend} undoSend={undoSend} />}
        {data && page === "rules" && <Rules data={data} reload={() => load(tab)} say={say} />}
        {data && page === "todos" && <Tasks tasks={data.todos} scheduled={data.scheduled ?? []} reload={() => load(tab)} say={say} onOpenListing={onOpenListing} onOpenMailMessage={onOpenMailMessage} onDrafted={() => setPage("review")} />}
      </div>
      <div className={cx(s.toast, toast && s.on)} role="status" aria-live="polite">
        <span>{toast?.text}{toast?.until ? ` in ${undoSecondsLeft(new Date(toast.until))} s` : ""}</span>
        {toast?.action && <button type="button" onClick={() => { void toast.action?.run(); setToast(null); }}>{toast.action.label}</button>}
        {toast?.undo && <button type="button" onClick={() => { toast.undo?.(); setToast(null); }}>Undo</button>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Inbox

/** What can be done to an email in the inbox. The lanes and the table share these, so a click does the same in both. */
function useItemActions({ data, tab, reload, say, onDrafted }: { data: Summary; tab: RelayTab; reload: () => Promise<void>; say: Say; onDrafted: () => void }) {
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [gone, setGone] = useState<Record<string, boolean>>({});
  const review: ToastAction = { label: "Open Review", run: onDrafted };
  const dealJob = async (i: RelayItem, action: "create" | "update") => {
    setBusy((b) => ({ ...b, [i.id]: true }));
    try {
      await api(`/api/relay/items/${i.id}/deal`, { method: "POST", body: { action } });
      say(action === "create" ? `Matcha is creating the deal for ${firstName(i.counterpart_name)} (a minute or two)` : `Matcha is updating the deal from ${firstName(i.counterpart_name)}'s reply`);
      await reload();
    } catch (err) {
      say(err instanceof Error ? err.message : "Couldn't start Matcha. Try again.");
    } finally {
      setBusy((b) => ({ ...b, [i.id]: false }));
    }
  };
  const linkDeal = async (i: RelayItem, listingId: string | null) => {
    setBusy((b) => ({ ...b, [i.id]: true }));
    try {
      await api(`/api/relay/items/${i.id}/link`, { method: "POST", body: { listing_id: listingId } });
      say(listingId ? `Linked ${firstName(i.counterpart_name)}'s thread to the deal` : `Unlinked ${firstName(i.counterpart_name)}'s thread`);
      await reload();
    } catch (err) {
      say(err instanceof Error ? err.message : "Couldn't link the deal. Try again.");
    } finally {
      setBusy((b) => ({ ...b, [i.id]: false }));
    }
  };
  const draftAsk = async (i: RelayItem) => {
    setBusy((b) => ({ ...b, [i.id]: true }));
    say(`Drafting the ask for ${firstName(i.counterpart_name)}…`);
    try {
      await api(`/api/relay/items/${i.id}/ask`, { method: "POST" });
      setGone((g) => ({ ...g, [i.id]: true }));
      await reload();
      say(`Drafted the ask · ${firstName(i.counterpart_name)} is in Review`, undefined, review);
    } catch (err) {
      say(err instanceof Error ? err.message : "Couldn't draft the ask. Try again.");
    } finally {
      setBusy((b) => ({ ...b, [i.id]: false }));
    }
  };
  /** Drafts the reply from a note, Alex's own or a suggested answer, and moves the email to Review. A suggested answer
   * is words Relay wrote from the email, so it only ever gets the plain draft: never the job that can look things up. */
  const draft = async (i: RelayItem, text: string, suggested = false) => {
    const note = text.trim();
    if (!note) { say("Add a note first: how do you want to reply?"); return; }
    setBusy((b) => ({ ...b, [i.id]: true }));
    const agent = !suggested && NEEDS_AGENT.test(note);
    say(agent ? `Relay is on it for ${firstName(i.counterpart_name)} · follow progress in Review` : `Drafting v1 for ${firstName(i.counterpart_name)}…`);
    try {
      await api(`/api/relay/items/${i.id}/draft`, { method: "POST", body: suggested ? { note, mode: "quick" } : { note } });
      setGone((g) => ({ ...g, [i.id]: true }));
      await reload();
      say(agent ? `Working on ${firstName(i.counterpart_name)} in Review (a few minutes)` : `Drafted · ${firstName(i.counterpart_name)} is in Review`, undefined, review);
    } catch (err) {
      say(err instanceof Error ? err.message : "Couldn't draft. Try again.");
    } finally {
      setBusy((b) => ({ ...b, [i.id]: false }));
    }
  };
  /** "Always do this for this sender" offered on the toast after a move or a Done. */
  const ruleAction = (i: RelayItem, tab: "action" | "other"): ToastAction | undefined => {
    const match = senderRuleMatch(i.counterpart_email);
    if (!match || data.senderRules.some((r) => r.match === match && r.tab === tab)) return undefined;
    return {
      label: tab === "action" ? `Always for ${match}` : `Never for ${match}`,
      run: async () => {
        try {
          await api(`/api/relay/sender-rules`, { method: "POST", body: { email: i.counterpart_email, tab } });
          say(tab === "action" ? `New email from ${match} will show under Action` : `New email from ${match} will go to Other`);
          await reload();
        } catch (err) { say(err instanceof Error ? err.message : "Couldn't save the rule."); }
      },
    };
  };
  const moveToAction = async (i: RelayItem) => {
    setGone((g) => ({ ...g, [i.id]: true }));
    try {
      await api(`/api/relay/items/${i.id}`, { method: "PATCH", body: { tab: "action" } });
      say("Moved to Action. It stays there until they write again.", async () => {
        await api(`/api/relay/items/${i.id}`, { method: "PATCH", body: { tab: "other", sticky: false } }).catch(() => undefined);
        setGone((g) => ({ ...g, [i.id]: false }));
        await reload();
      }, ruleAction(i, "action"));
      await reload();
    } catch (err) { setGone((g) => ({ ...g, [i.id]: false })); say(err instanceof Error ? err.message : "Couldn't move it."); }
  };
  const done = async (i: RelayItem) => {
    setGone((g) => ({ ...g, [i.id]: true }));
    try {
      await api(`/api/relay/items/${i.id}/done`, { method: "POST" });
      say("Done · marked read and labelled Sorted in Gmail", undefined, tab === "action" ? ruleAction(i, "other") : undefined);
      await reload();
    } catch (err) { setGone((g) => ({ ...g, [i.id]: false })); say(err instanceof Error ? err.message : "Couldn't update Gmail."); }
  };
  /** Follow up: stop suggesting a chase on this thread. It comes back only if they write again. `park`: after three
   * unanswered chases, the same with a note on the linked deal that it was parked. */
  const dontChase = async (i: RelayItem, park = false) => {
    setGone((g) => ({ ...g, [i.id]: true }));
    try {
      await api(`/api/relay/items/${i.id}/done`, { method: "POST", body: { reason: park ? "park" : "no_chase" } });
      say(`${park ? "Parked" : "No chase for"} ${firstName(i.counterpart_name)}. It comes back only if they write again.`, async () => {
        await api(`/api/relay/items/${i.id}`, { method: "PATCH", body: { status: "open", done_reason: "" } }).catch(() => undefined);
        setGone((g) => ({ ...g, [i.id]: false }));
        await reload();
      });
      await reload();
    } catch (err) { setGone((g) => ({ ...g, [i.id]: false })); say(err instanceof Error ? err.message : "Couldn't update Gmail."); }
  };
  const dropRule = async (r: SenderRule) => {
    try { await api(`/api/relay/sender-rules`, { method: "POST", body: { delete: r.id } }); say(`Removed the rule for ${r.match}`); await reload(); }
    catch (err) { say(err instanceof Error ? err.message : "Couldn't remove it."); }
  };

  return { busy, gone, dealJob, linkDeal, draftAsk, draft, moveToAction, done, dontChase, dropRule };
}
type ItemActions = ReturnType<typeof useItemActions>;

/** The email behind a row: their latest message, its attachments, what came before, and the deal it belongs to.
 * In a lane the row has its own answers and no avatar column, so there is no indent and no second Ask button. */
function ThreadDetail({ item: i, tab, act, onOpenCompany, inLane }: { item: RelayItem; tab: RelayTab; act: ItemActions; onOpenCompany?: (id: string) => void; inLane?: boolean }) {
  return (
    <div className={cx(s.thread, inLane && s.flat)}>
      {/* In the lanes the row above already says it. */}
      {!inLane && i.jules && <div style={{ marginBottom: 6 }}><JulesFlag jules={i.jules} /></div>}
      {i.last_message && (
        <div className={s.lastmail}>
          <div className={s.mh}><b>{i.last_message.from_name || i.last_message.from_email}</b> · {when(i.last_message.at)} · {tab === "follow" ? "your last email, no reply since" : "their latest email"}</div>
          <div className={s.mb}>{i.last_message.text}</div>
        </div>
      )}
      {i.attachment_message_id && <div onClick={(e) => e.stopPropagation()}><AttachmentStrip messageId={i.attachment_message_id} /></div>}
      {i.earlier.length > 0 && <div className={s.earlier}>{i.earlier.map((e, k) => <span key={k}><b>{e.who}</b> · {e.when}: {e.summary}</span>)}</div>}
      <DealBar item={i} busy={!!act.busy[i.id]} create={inLane} onRun={(action) => void act.dealJob(i, action)} onAsk={!inLane && tab === "action" && i.can_ask ? () => void act.draftAsk(i) : undefined} onLink={(id) => void act.linkDeal(i, id)} onOpenCompany={onOpenCompany} />
    </div>
  );
}

/** The new inbox: the emails that need a reply, in lanes. It only arranges them; every click is one the table has too. */
function LanesInbox({ data, leads, reload, say, onOpenListing, onOpenCompany, onDrafted, onLead, onGo, onOld }: {
  data: Summary; leads: ReturnType<typeof useLeadCards>; reload: () => Promise<void>; say: Say;
  onOpenListing?: (id: string, title?: string) => void; onOpenCompany?: (id: string) => void; onDrafted: () => void;
  onLead: (cardId: string) => void; onGo: (page: Page) => void; onOld: () => void;
}) {
  const act = useItemActions({ data, tab: "action", reload, say, onDrafted });
  const suggest = useSuggestions(true);
  if (data.tab !== "action") return <p className={s.muted} role="status">Loading the inbox…</p>;
  return (
    <>
      <Lanes items={data.items} counts={data.counts} cards={leads.data} cardsError={leads.error} reloadCards={leads.reload} suggest={suggest.data} act={act} say={say}
        detail={(i) => <ThreadDetail item={i} tab="action" act={act} onOpenCompany={onOpenCompany} inLane />}
        onLead={onLead} onOpenListing={onOpenListing} onGo={onGo} />
      <button type="button" className={s.oldlink} onClick={onOld}>Use the old inbox</button>
    </>
  );
}

function Inbox({ data, tab, setTab, only, onBack, reload, say, onOpenListing, onOpenCompany, onDrafted }: {
  data: Summary; tab: RelayTab; setTab: (t: RelayTab) => void; reload: () => Promise<void>; say: Say;
  /** One list with no inner tabs: how the new inbox shows its follow-ups and its no-reply emails. */
  only?: "follow" | "other"; onBack?: () => void;
  onOpenListing?: (id: string, title?: string) => void; onOpenCompany?: (id: string) => void; onDrafted: () => void;
}) {
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const act = useItemActions({ data, tab, reload, say, onDrafted });
  const { busy, gone, dealJob, moveToAction, done, dontChase, dropRule } = act;
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
  const draft = (i: RelayItem) => {
    const note = noteOf(i);
    if (!note.trim()) setOpen(i.id);
    return act.draft(i, note);
  };

  const heads = tab === "follow" ? ["Waiting on", "Your last email", "Deal", "No reply", "Priority"]
    : tab === "other" ? ["From", "What it is", "Deal", "Received", ""] : ["From", "What they want", "Deal", "Waiting", "Priority"];

  return (
    <section aria-label="Inbox">
      <div className={s.phead}>
        {only ? (
          <div className={s.only}>
            <button type="button" className={s.backlink} onClick={onBack}>← Inbox</button>
            <h2>{only === "follow" ? "Follow-ups due" : "No reply needed"} <span className={s.n}>{data.counts[only]}</span></h2>
          </div>
        ) : (
          <div className={s.itabs} role="tablist" aria-label="Inbox views">
            {([["action", "Action"], ["follow", "Follow up"], ["other", "Other"]] as const).map(([key, label]) => (
              <button key={key} role="tab" type="button" aria-selected={tab === key} onClick={() => { setTab(key); setOpen(null); }}>{label} <span className={s.n}>{data.counts[key]}</span></button>
            ))}
          </div>
        )}
        <div className={s.tools}>
          <label className={s.search}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
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
                  <div className={s.sum}><b>{i.headline}</b><span>{i.context}</span>{i.jules && <div style={{ marginTop: 3 }}><JulesFlag jules={i.jules} compact /></div>}</div>
                  <div className={s.dealc}>
                    {i.bulk_listing_id
                      ? <button type="button" className={s.deal} title={`Open deal: ${i.deal_label ?? ""}`} onClick={(e) => { e.stopPropagation(); onOpenListing?.(i.bulk_listing_id!, i.deal_label ?? undefined); }}>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M20 12l-8 8-9-9V3h8z" /><circle cx="7.5" cy="7.5" r="1.5" /></svg><span>{i.deal_label || "Deal"}</span>
                        </button>
                      : dealWorking(i) ? <span className={s.nodeal}>Matcha working…</span>
                      : i.dismantler
                        ? <button type="button" className={s.dism} title={`Open ${i.dismantler.name} in the CRM. A dismantler: one or a few packs go to the marketplace, not a bulk deal`} onClick={(e) => { e.stopPropagation(); onOpenCompany?.(i.dismantler!.company_id); }}>Dismantler · {i.dismantler.name}</button>
                      : i.deal_action === "create"
                        ? <button type="button" className={s.mkdeal} disabled={busy[i.id]} title={`Matcha creates the deal from this ${i.inbox === "buy" ? "buyer" : i.inbox === "supply" ? "seller" : ""} email and fills the card`} onClick={(e) => { e.stopPropagation(); void dealJob(i, "create"); }}>+ Create deal</button>
                        : <span className={s.nodeal}>No deal</span>}
                  </div>
                  <div className={cx(s.wait, s.num, i.priority === "overdue" && s.late)}>{ago(i.waiting_since ?? i.last_message?.at)}</div>
                  {tab === "other"
                    ? <div className={s.oacts}><button type="button" onClick={(e) => { e.stopPropagation(); void moveToAction(i); }}>Needs reply</button><button type="button" onClick={(e) => { e.stopPropagation(); void done(i); }}>Done</button></div>
                    : <div><span className={cx(s.pill, s[i.priority])}><i />{PRIORITY_LABEL[i.priority]}</span></div>}
                </div>
                {isOpen && <ThreadDetail item={i} tab={tab} act={act} onOpenCompany={onOpenCompany} />}
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
                      {tab === "follow" && <button type="button" className={s.doneb} title="Stop suggesting a chase. It comes back only if they write again." onClick={() => void dontChase(i)}>Don&apos;t chase</button>}
                    </div>
                    {tab === "follow" && i.chase && i.chase.state !== "waiting" && (
                      <div className={s.hint} data-chase={i.chase.state}>
                        {chaseLabel(i.chase)}{i.chase.state === "due" ? ". Relay prepares the chase in Review for you to send." : ""}
                        {i.chase.state === "park" && <> <button type="button" className={s.doneb} title={i.bulk_listing_id ? "Stop chasing and note on the deal that it was parked. It comes back only if they write again." : "Stop chasing. It comes back only if they write again."} onClick={() => void dontChase(i, true)}>Park</button></>}
                      </div>
                    )}
                    {i.gmail_chase_copy && <div className={s.hint} role="status" data-gmail-chase>A copy of this chase is still in Gmail drafts. They replied, so delete it there.</div>}
                    {!isOpen && <div className={s.hint}>{busy[i.id] ? "Drafting…" : note.trim() ? (NEEDS_AGENT.test(note) ? "Relay will do the work first (research, lists, files), then draft. Takes a few minutes." : "Ready: press the arrow (or ⌘↵) to draft") : "Click to read the full email"}</div>}
                  </>
                )}
              </div>
            );
          })}
      </div>
      {data.senderRules.length > 0 && (
        <div className={s.srules} aria-label="Sorting rules">
          <span className={s.muted}>Sorting rules:</span>
          {data.senderRules.map((r) => (
            <span key={r.id} className={s.srule}>{r.match} → {r.tab === "action" ? "needs reply" : "no reply"}
              <button type="button" aria-label={`Remove the rule for ${r.match}`} onClick={() => void dropRule(r)}>×</button>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- Review

type Local = { subject: string; body: string; to: string; cc: string; bcc: string; updated_at: string };
const splitAddrs = (v: string) => v.replace(/;/g, ",").split(",").map((a) => a.trim()).filter(Boolean);

function Review({ data, reload, say, onBack, sending, startSend, undoSend }: {
  data: Summary; reload: () => Promise<void>; say: (t: string, undo?: () => void) => void; onBack: () => void;
  sending: Record<string, string>; startSend: (draftId: string, updatedAt: string, toLabel: string) => Promise<boolean>; undoSend: (draftId: string, toLabel: string) => Promise<boolean>;
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
  const isSent = (d: RelayDraftView) => d.state === "sent" || d.id in sending || (!!d.mail?.scheduled && !d.mail.scheduled.changed);
  const [finishing, setFinishing] = useState(false);
  const finish = async (reason?: "no_chase") => {
    setFinishing(true);
    try {
      await api(`/api/relay/items/${item.id}/done`, { method: "POST", body: reason ? { reason } : undefined });
      say(reason ? `No chase for ${firstName(item.counterpart_name)}. It comes back only if they write again.` : "Done · no reply. Marked read and labelled Sorted in Gmail");
      await reload();
    }
    catch (err) { say(err instanceof Error ? err.message : "Couldn't update Gmail."); } finally { setFinishing(false); }
  };
  // A chase Relay prepared by itself when the chase clock fell due: "Don't chase" drops it and stops chasing this thread.
  const chasePrepared = item.drafts.some((d) => d.origin === "predraft" && d.state !== "sent");
  return (
    <section aria-label="Review">
      <div className={s.phead}><span className={s.tag}>In review</span></div>
      <div className={s.pager}>
        <button className={s.navb} type="button" aria-label="Previous" onClick={() => setCur((index - 1 + items.length) % items.length)}>‹</button>
        {items.map((x, k) => {
          const name = x.counterpart_name || x.counterpart_email || "?";
          const busyJob = !x.drafts.length && x.job && ["queued", "running", "ready", "finalising"].includes(x.job.status);
          return <button key={x.id} type="button" className={s.chip} aria-current={k === index} onClick={() => setCur(k)}><span className={s.av} style={{ background: colour(name) }}>{initials(name)}</span>{firstName(name)}<span className={cx(s.st, (busyJob || x.drafts.some((d) => d.id in sending)) && s.work, !busyJob && x.drafts.length > 0 && x.drafts.filter((d) => d.role === "primary").every((d) => d.state === "sent") && s.sent, !busyJob && x.drafts.some((d) => d.role === "primary" && d.mail?.scheduled) && s.sched)} /></button>;
        })}
        <button className={s.navb} type="button" aria-label="Next" onClick={() => setCur((index + 1) % items.length)}>›</button>
        <span className={s.count}>{index + 1} of {items.length}</span>
        <span className={s.sp} />
        {chasePrepared && <button type="button" className={cx(s.btn, s.ghost)} disabled={finishing} title="Drop this chase and stop chasing the thread. It comes back only if they write again." onClick={() => void finish("no_chase")}>Don&apos;t chase</button>}
        <button type="button" className={cx(s.btn, s.ghost)} disabled={finishing} title="No reply needed: marks this email read, labels it Sorted in Gmail and removes it from Review" onClick={() => void finish()}>{finishing ? "Marking…" : "Done, no reply"}</button>
      </div>
      <div className={s.rgrid}>
        <div className={s.col}>
          {!draft && item.job ? <JobCard job={item.job} itemId={item.id} reload={reload} say={say} />
            : draft ? <Editor key={draft.id} item={item} draft={draft} reload={reload} say={say} onBack={onBack} sendingTo={sending[draft.id]}
            startSend={startSend} undoSend={undoSend}
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
                    <div className={s.ft}><span className={s.step}>{d.role === "primary" ? "PRIMARY" : `FOLLOW-ON ${d.position}`}</span><span style={{ fontSize: 11, fontWeight: 500, color: d.mail?.scheduled ? "var(--blue-ink)" : isSent(d) ? "var(--green)" : "var(--muted)" }}>{d.mail?.scheduled ? (d.mail.scheduled.undo ? "Sending…" : sendLabel(d.mail.scheduled.at)) : isSent(d) ? "Sent" : d.mail ? "Draft" : "Needs a recipient"}</span></div>
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
        <div className={s.aicol}>
          <AiPanel key={item.id} item={item} draft={draft} rules={data.rules} reload={reload} say={say} />
          <DealChecklistCard key={`check-${item.id}`} item={item} draft={draft} reload={reload} say={say} />
        </div>
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
    gmail_send_as_missing: 'Gmail can\'t send from this address yet. Add it in Gmail under Settings, Accounts, "Send mail as", or pick another From.',
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
    schedule_changed: "the draft changed after you scheduled it. Check it and send or schedule again.",
    schedule_missed: "the scheduled time passed while Relay was down. Send it now or pick a new time.",
    schedule_invalid: "the schedule was incomplete. Schedule it again.",
  };
  return words[reason] ?? `${reason.replace(/_/g, " ")}.`;
}

function Editor({ item, draft, reload, say, onBack, onNext, sendingTo, startSend, undoSend }: {
  item: RelayReviewItem; draft: RelayDraftView; reload: () => Promise<void>; say: (t: string, undo?: () => void) => void; onBack: () => void; onNext: () => void;
  sendingTo?: string; startSend: (draftId: string, updatedAt: string, toLabel: string) => Promise<boolean>; undoSend: (draftId: string, toLabel: string) => Promise<boolean>;
}) {
  const mail = draft.mail;
  const [local, setLocal] = useState<Local | null>(mail ? { subject: mail.subject ?? "", body: mail.main, to: mail.to_emails.join(", "), cc: mail.cc_emails.join(", "), bcc: mail.bcc_emails.join(", "), updated_at: mail.updated_at } : null);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [, tick] = useState(0);
  const [later, setLater] = useState(false);
  const [custom, setCustom] = useState("");
  const [scheduling, setScheduling] = useState(false);
  const [checking, setChecking] = useState(false);
  const [switching, setSwitching] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  // A rewrite from the AI panel saves server-side; pick up the new copy when the draft's version moves on.
  useEffect(() => { if (mail && local && mail.updated_at !== local.updated_at && !saving) setLocal({ subject: mail.subject ?? "", body: mail.main, to: mail.to_emails.join(", "), cc: mail.cc_emails.join(", "), bcc: mail.bcc_emails.join(", "), updated_at: mail.updated_at }); }, [mail?.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const el = bodyRef.current; if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; } }, [local?.body]);
  // While Send holds the email, count the seconds down.
  const holdAt = mail?.state === "draft" && mail.scheduled?.undo ? mail.scheduled.at : null;
  useEffect(() => { if (!holdAt) return; const t = setInterval(() => tick((n) => n + 1), 500); return () => clearInterval(t); }, [holdAt]);

  if (!mail || !local) {
    return <div className={cx(s.card, s.editor)}><div className={s.ebar}><div><div className={s.lab}>Follow-on email</div><h2>{draft.title}</h2></div></div><p style={{ padding: "11px 14px" }} className={s.muted}>{draft.why} Relay didn't know who to send this to, so there's no draft yet. Ask in the panel on the right, e.g. "draft this to Rob at Qube".</p></div>;
  }
  const isDirty = (l: Local) => l.subject !== (mail.subject ?? "") || splitAddrs(l.to).join(",") !== mail.to_emails.join(",") || l.body !== mail.main || splitAddrs(l.cc).join(",") !== mail.cc_emails.join(",") || splitAddrs(l.bcc).join(",") !== mail.bcc_emails.join(",");
  const save = async (edited: Local = local): Promise<Local | null> => {
    if (!isDirty(edited)) return edited;
    setSaving(true);
    try {
      const updated = await api<{ updated_at: string; subject: string | null; to_emails: string[]; cc_emails: string[]; bcc_emails: string[]; editable: { main: string } }>(`/api/mail/drafts/${mail.id}`, { method: "PATCH", body: { subject: edited.subject, body: edited.body, to: splitAddrs(edited.to), cc: splitAddrs(edited.cc), bcc: splitAddrs(edited.bcc), updated_at: edited.updated_at } });
      const next = { subject: updated.subject ?? "", body: updated.editable.main, to: updated.to_emails.join(", "), cc: updated.cc_emails.join(", "), bcc: updated.bcc_emails.join(", "), updated_at: updated.updated_at };
      setLocal(next);
      void reload();
      return next;
    } catch (err) { say(err instanceof Error ? err.message : "Couldn't save."); return null; } finally { setSaving(false); }
  };
  const useTo = async (address: string) => { await save({ ...local, to: address }); };
  // From: saves the copy first, then the server re-signs that version as the new sender.
  const changeSender = async (identity: string) => {
    setSwitching(true);
    try {
      const version = await save();
      if (!version) return;
      await api(`/api/relay/drafts/${draft.id}/sender`, { method: "POST", body: { identity, updated_at: version.updated_at } });
      await reload();
    } catch (err) { say(err instanceof Error ? err.message : "Couldn't change who it is from."); } finally { setSwitching(false); }
  };
  const sent = draft.state === "sent";
  const scheduled = mail.scheduled;
  // A sender switch re-signs the saved copy; the editor holds still until that version is back.
  const locked = sent || !!scheduled || switching;
  const to = splitAddrs(local.to);
  const verdict = beforeYouSend({ to, body: local.body, attachments: mail.attachments.length }, item.facts);
  const blocked = verdict.state === "stop";
  // Send: one click. The server holds it for 30 seconds so it can be undone, then sends this exact version.
  const send = async () => {
    setSending(true);
    try {
      const version = await save();
      if (!version) return;
      if (await startSend(draft.id, version.updated_at, splitAddrs(version.to).join(", "))) onNext();
    } finally { setSending(false); }
  };
  // Send later: saves the copy, pins that version and the time; the server sends it then, unless they reply first.
  const scheduleAt = async (at: string) => {
    setScheduling(true);
    try {
      const version = await save();
      if (!version) return;
      await api(`/api/relay/drafts/${draft.id}/schedule`, { method: "POST", body: { confirm: true, updated_at: version.updated_at, send_at: at } });
      say(`Scheduled for ${sendLabel(at)} to ${firstName(splitAddrs(version.to)[0])}`);
      setLater(false);
      await reload();
      onNext();
    } catch (err) { say(err instanceof Error ? err.message : "Couldn't schedule it."); } finally { setScheduling(false); }
  };
  const scheduleCustom = () => {
    if (!custom) return;
    const [date, time] = custom.split("T");
    const at = londonWallToUtc(date, time);
    if (londonInputValue(at) !== custom) { say("That time doesn't exist in London: the clocks change then. Pick another."); return; }
    const problem = sendAtProblem(at);
    if (problem) { say(problem); return; }
    void scheduleAt(at.toISOString());
  };
  const cancelSchedule = async () => {
    setScheduling(true);
    try { await api(`/api/relay/drafts/${draft.id}/schedule`, { method: "DELETE" }); say("Schedule cancelled. It's a draft again."); await reload(); }
    catch (err) { say(err instanceof Error ? err.message : "Couldn't cancel."); } finally { setScheduling(false); }
  };
  const undoHold = async () => {
    setScheduling(true);
    try { await undoSend(draft.id, mail.to_emails.join(", ")); } finally { setScheduling(false); }
  };
  const holdLeft = holdAt ? undoSecondsLeft(holdAt) : 0;
  const sendNow = async () => {
    setScheduling(true);
    try { if (await startSend(draft.id, mail.updated_at, mail.to_emails.join(", "))) onNext(); } finally { setScheduling(false); }
  };
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
    <span key={k}>{issue.text}{issue.fix && <> <button type="button" className={s.fixl} onClick={() => void useTo(issue.fix!.to)}>{issue.fix.label}</button></>} </span>
  );
  const lead = verdict.state === "stop" ? "Fix this before sending." : verdict.state === "check" ? (verdict.issues.length === 1 ? "One thing to check." : `${verdict.issues.length} things to check.`) : "Ready to send.";
  const okLine = verdict.good.length ? `${verdict.state === "ok" ? "" : "Otherwise "}${verdict.good.join(", ").replace(/, ([^,]*)$/, " and $1")}.` : "";
  const hasPromise = draft.role === "primary" && (promisesIn(local.body).length > 0 || item.todos.some((t) => t.kind === "promise"));

  return (
    <div className={cx(s.card, s.editor)}>
      <div className={s.ebar}>
        <div><div className={s.lab}>{draft.role === "primary" ? "Primary email" : "Follow-on email"} · {(mail.from_email ?? "alex@").split("@")[0]}@</div><h2>{draft.title}</h2></div>
        <span className={cx(s.pill, sent ? s.ok : scheduled ? s.sched : s.warn)}><i />{sent ? "Sent" : scheduled ? (scheduled.undo ? "Sending" : "Scheduled") : draft.state === "gmail" ? "In Gmail drafts" : saving ? "Saving…" : "Draft"}</span>
      </div>
      {draft.role === "primary" && draft.source_note && <div className={s.fromnote}>Drafted from your note: <b>&ldquo;{draft.source_note}&rdquo;</b></div>}
      {draft.agent_log.length > 0 && <div className={s.log}>{draft.agent_log.map((l, k) => <span key={k}>{l}</span>)}</div>}
      <div className={s.field} style={{ marginTop: 6 }}>
        <label htmlFor={`from-${draft.id}`}>From</label>
        {isSenderKey(mail.identity_key) && mail.transport === "gmail"
          ? <select id={`from-${draft.id}`} value={mail.identity_key} disabled={locked || saving} onChange={(e) => void changeSender(e.target.value)}>{SENDERS.map((sender) => <option key={sender.key} value={sender.key}>{sender.address}</option>)}</select>
          : <div className={s.ro}>{mail.from_email}</div>}
      </div>
      <div className={s.field}><label htmlFor={`to-${draft.id}`}>To</label><input id={`to-${draft.id}`} value={local.to} disabled={locked} placeholder="Add an address" onChange={(e) => setLocal({ ...local, to: e.target.value })} onBlur={() => void save()} /></div>
      {(["cc", "bcc"] as const).map((k) => <div key={k} className={s.field}><label htmlFor={`${k}-${draft.id}`}>{k === "cc" ? "Cc" : "Bcc"}</label><input id={`${k}-${draft.id}`} value={local[k]} disabled={locked || mail.transport !== "gmail"} placeholder="Add addresses, separated by commas" onChange={(e) => setLocal({ ...local, [k]: e.target.value })} onBlur={() => void save()} /></div>)}
      <div className={s.field}><label htmlFor={`sj-${draft.id}`}>Subject</label><input id={`sj-${draft.id}`} value={local.subject} disabled={locked} onChange={(e) => setLocal({ ...local, subject: e.target.value })} onBlur={() => void save()} /></div>
      <textarea ref={bodyRef} className={s.body} value={local.body} disabled={locked} aria-label="Email body" onChange={(e) => setLocal({ ...local, body: e.target.value })} onBlur={() => void save()} />
      {mail.attachments.length > 0 && (
        <div className={s.atts}>
          {mail.attachments.map((a) => (
            <div key={a.sha256} className={s.att}>
              <a className={s.attlink} href={`/api/mail/drafts/${mail.id}/attachments/${a.sha256}`} target="_blank" rel="noopener noreferrer">
                <span className={cx(s.ic, /xlsx?$/i.test(a.filename) && s.xl)}>{(a.filename.split(".").pop() ?? "").toUpperCase().slice(0, 4)}</span>
                <div><b>{a.filename}</b><span>{a.sizeBytes ? `${Math.max(1, Math.round(a.sizeBytes / 1024))} KB · open` : "open"}</span></div>
              </a>
              {!locked && <button type="button" className={s.attx} aria-label={`Remove ${a.filename}`} onClick={() => void detach(a.sha256, a.filename)}>×</button>}
            </div>
          ))}
        </div>
      )}
      {!sent && mail.warnings.map((w) => <div key={w} role="alert" className={s.sentbox} style={{ background: "var(--amber-soft)", color: "var(--ink)", marginBottom: 0 }}><b>Check the conversation:</b> {w}</div>)}
      {mail.state === "draft" && mail.failure && !sendingTo && <div className={s.sentbox} style={{ background: "var(--amber-soft)", color: "var(--ink)", marginBottom: 0 }}><b>Last try didn&apos;t send:</b> {failureText(mail.failure, mail.state)}</div>}
      {!sent && (
        <div className={cx(s.bys, verdict.state === "check" && s.check, verdict.state === "stop" && s.stop)} aria-live="polite">
          <div className={s.bysh}><span className={s.spark} aria-hidden>✦</span><b>Before you send</b><span className={s.state}>{verdict.state === "ok" ? "All clear" : verdict.state === "check" ? "Check" : "Blocked"}</span></div>
          <p><strong>{lead}</strong> {verdict.issues.map(issueText)}{okLine}{hasPromise ? " Any promise in this email is in your to-dos below." : ""}</p>
        </div>
      )}
      {holdLeft > 0 ? (
          <div className={cx(s.sentbox, s.schedbox)} role="status">
            <span>Sending to {mail.to_emails.join(", ")} in <b className={s.count}>{holdLeft} s</b>.</span>
            <span className={s.sp} />
            <button type="button" className={s.btn} disabled={scheduling} onClick={() => void undoHold()}>Undo send</button>
          </div>)
        : (sendingTo || mail.state === "sending" || holdAt) ? <div className={s.sentbox} style={{ background: "var(--blue-soft)", color: "var(--blue-ink)" }}>Sending to {sendingTo ?? to.join(", ")}… You can carry on; Relay tells you when it lands.</div>
        : (mail.state === "failed" || mail.state === "unknown") ? (
          <div className={s.sentbox} style={{ background: "var(--amber-soft)", color: "var(--ink)" }}>
            <b>Not sent{mail.state === "unknown" ? " (unconfirmed)" : ""}:</b> {failureText(mail.failure, mail.state)}{" "}
            <button type="button" className={s.fixl} disabled={checking} onClick={() => void checkSent()}>{checking ? "Checking Gmail…" : "Check if it went"}</button>
          </div>)
        : sent ? <div className={s.sentbox}>✓ Sent. Relay brings this back to Follow up if there&apos;s no reply.</div>
        : scheduled ? (
          <div className={cx(s.sentbox, s.schedbox, scheduled.changed && s.schedwarn)}>
            {scheduled.changed
              ? <span><b>Won&apos;t send {sendLabel(scheduled.at)}:</b> this draft changed after you scheduled it. Send it now or cancel and schedule again.</span>
              : <span>Sends <b>{sendLabel(scheduled.at)}</b> to {mail.to_emails.join(", ")}. If they reply before then, it waits for you.</span>}
            <span className={s.sp} />
            <button type="button" className={s.btn} disabled={scheduling} onClick={() => void sendNow()}>Send now</button>
            <button type="button" className={cx(s.btn, s.ghost)} disabled={scheduling} onClick={() => void cancelSchedule()}>Cancel</button>
          </div>
        ) : (
        <>
        <div className={s.eact}>
          <button className={cx(s.btn, s.pri)} type="button" title="Sends in 30 seconds. You can undo until then." disabled={blocked || sending || saving || switching || scheduling} onClick={() => void send()}>{sending ? "Sending…" : "Send"} <Arrow /></button>
          <button className={s.btn} type="button" aria-expanded={later} disabled={blocked || sending || saving || switching || scheduling} onClick={() => setLater((v) => !v)}><Clock /> Send later</button>
          <button className={s.btn} type="button" disabled={saving} onClick={() => void toGmail()}>{draft.state === "gmail" ? "✓ In Gmail drafts" : "Add to Gmail drafts"}</button>
          <span className={s.sp} />
          {draft.role === "primary" && <button className={cx(s.btn, s.ghost)} type="button" title="No reply needed after all: marks it read and labels it Sorted in Gmail; the draft is dropped" onClick={() => void markDone()}>Done, no reply</button>}
          <button className={cx(s.btn, s.ghost)} type="button" onClick={onBack}>Back to inbox</button>
        </div>
        {later && (
          <div className={s.later} role="group" aria-label="Send later">
            {sendSlots().map((slot) => <button key={slot.at} type="button" className={s.btn} disabled={scheduling} onClick={() => void scheduleAt(slot.at)}>{slot.label}</button>)}
            <input type="datetime-local" aria-label="Pick a time (London)" value={custom} min={londonInputValue(new Date())} onChange={(e) => setCustom(e.target.value)} />
            {custom && <button type="button" className={cx(s.btn, s.pri)} disabled={scheduling} onClick={scheduleCustom}>Schedule</button>}
          </div>
        )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Rules

/** Writing rules: what Relay learned from Alex's edits (to approve), the rules in force, and the writing style behind every draft. */
function Rules({ data, reload, say }: { data: Summary; reload: () => Promise<void>; say: Say }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState(false);
  const post = async (body: unknown, message: string, key: string) => {
    setBusy(key);
    try { await api(`/api/relay/rules`, { method: "POST", body }); say(message); await reload(); }
    catch (err) { say(err instanceof Error ? err.message : "Couldn't save that."); } finally { setBusy(null); }
  };
  const proposals = data.rules.filter((r) => r.state === "proposed");
  const own = data.rules.filter((r) => r.state === "active" && r.source === "alex");
  const learned = data.rules.filter((r) => r.state === "active" && r.source === "learned");
  const run = data.learnRun;
  const v = data.voice;
  return (
    <section aria-label="Rules" className={s.rulespage}>
      <div className={cx(s.card, s.rcard)}>
        <div className={s.sec}><h3>To review</h3><span>{proposals.length ? "Relay noticed these in how you edit its drafts. Approve to apply them to every draft." : "Nothing to review. Relay checks your sent drafts every week."}</span></div>
        {proposals.map((p) => (
          <div key={p.id} className={s.proposal}>
            <b>{p.action === "remove" ? `Stop: ${p.text}` : p.text}</b>
            {p.why && <span className={s.muted}>{p.why}</span>}
            {p.evidence.slice(0, 2).map((e, k) => e.request
              ? <span key={k} className={s.ev}>You asked: &ldquo;{e.request}&rdquo;</span>
              : <span key={k} className={s.ev}><i>Relay wrote:</i> {(e.before ?? "").slice(0, 160)}… <i>You sent:</i> {(e.after ?? "").slice(0, 160)}…</span>)}
            <div className={s.eact} style={{ padding: "8px 0 0" }}>
              <button type="button" className={cx(s.btn, s.pri)} disabled={busy === p.id} onClick={() => void post({ approve: p.id }, p.action === "remove" ? "Removed from your rules" : "Added · applies to every draft", p.id)}>Approve</button>
              <button type="button" className={cx(s.btn, s.ghost)} disabled={busy === p.id} onClick={() => void post({ reject: p.id }, "Rejected · Relay won't suggest it again", p.id)}>Reject</button>
            </div>
          </div>
        ))}
        {run && <span className={s.muted} style={{ fontSize: 11 }}>Last checked {when(run.ran_at)}: {run.sent} sent, {run.unchanged} unchanged, {run.edited} edited{run.note ? ` · ${run.note}` : ""}.</span>}
      </div>
      <div className={cx(s.card, s.rcard)}>
        <div className={s.sec}><h3>Your rules</h3><span>Always followed, ahead of everything else.</span></div>
        <div className={s.rules}>
          {own.map((r) => <div key={r.id} className={s.rule}><i>›</i><span>{r.text}</span><button type="button" aria-label="Remove rule" onClick={() => void post({ delete: r.id }, "Rule removed", r.id)}>×</button></div>)}
          <form className={s.ask} style={{ padding: "6px 0 0", border: 0 }} onSubmit={(e) => { e.preventDefault(); if (text.trim()) { void post({ text: text.trim() }, "Rule added · applies to every draft", "new"); setText(""); } }}>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a rule, e.g. sign off 'Cheers'" aria-label="New rule" />
            <button type="submit" aria-label="Add rule">+</button>
          </form>
        </div>
      </div>
      <div className={cx(s.card, s.rcard)}>
        <div className={s.sec}><h3>Learned from your edits</h3><span>{learned.length ? "Approved by you. Remove one and Relay won't suggest it again." : "None yet."}</span></div>
        <div className={s.rules}>
          {learned.map((r) => <div key={r.id} className={s.rule}><i>›</i><span>{r.text}</span><button type="button" aria-label="Remove learned rule" onClick={() => void post({ delete: r.id }, "Removed · Relay won't suggest it again", r.id)}>×</button></div>)}
        </div>
      </div>
      <div className={cx(s.card, s.rcard)}>
        <div className={s.sec}><h3>Writing style</h3><span>{v ? `Version ${v.version}, learned from ${v.source_emails ?? "your"} sent emails${v.eval?.judge_after_wins != null ? `; in a blind test it read more like you ${v.eval.judge_after_wins} times out of ${v.eval.n}` : ""}.` : "No writing style yet."}</span></div>
        {v && <button type="button" className={cx(s.btn, s.ghost)} onClick={() => setShowGuide((x) => !x)}>{showGuide ? "Hide the guide" : "Read the guide"}</button>}
        {v && showGuide && <pre className={s.guide}>{v.guide}</pre>}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- AI panel

type Bubble = { who: "bot" | "me" | "work"; text: string };

function AiPanel({ item, draft, rules, reload, say }: { item: RelayReviewItem; draft: RelayDraftView | undefined; rules: RelayRule[]; reload: () => Promise<void>; say: (t: string) => void }) {
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
          {agentError ? <p className={s.error} style={{ padding: 12 }}>{agentError}</p>
            : !agent ? <p className={s.muted} style={{ padding: 12 }} role="status">Opening the assistant…</p>
            : <ChatPanel key={agent.conversation.key} nativeConversationKey={agent.conversation.key} nativeTransport={agent.transport} nativeAccess={agent.conversation.access} sessionTitle={agent.conversation.title}
                fileContext={{ path: item.bulk_listing_id ? `~trades-preview/listing/${item.bulk_listing_id}` : "~crm/relay", filename: item.headline || "Relay", isDirectory: true }}
                visible compact
                onBranched={(conversation: HermesConversation) => { setAgent((a) => a && { ...a, conversation }); void api(`/api/relay/items/${item.id}/chat`, { method: "PUT", body: { key: conversation.key } }).catch(() => undefined); }} />}
        </div>
      )}
      {mode === "rules" && (
        <div className={s.rules}>
          {rules.filter((r) => r.state === "active").map((r) => <div key={r.id} className={s.rule}><i>›</i><span>{r.text}</span><button type="button" aria-label="Remove rule" onClick={() => void saveRules({ delete: r.id }, r.source === "learned" ? "Learned rule removed · Relay won't suggest it again" : "Rule removed")}>×</button></div>)}
          <form className={s.ask} style={{ padding: "6px 0 0", border: 0 }} onSubmit={(e) => { e.preventDefault(); if (rule.trim()) { void saveRules({ text: rule.trim() }, "Rule added · applies to every draft"); setRule(""); } }}>
            <input value={rule} onChange={(e) => setRule(e.target.value)} placeholder="Add a rule, e.g. sign off 'Cheers'" aria-label="New rule" />
            <button type="submit" aria-label="Add rule">+</button>
          </form>
          <span className={s.muted} style={{ fontSize: 11 }}>Rules apply to every draft and edit.</span>
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
  if (!f) return <p className={s.muted} style={{ padding: "0 12px 9px" }} role="status">Reading the email…</p>;
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
      <span className={s.muted} style={{ fontSize: 11 }}>Excel, one row per lot. Country only: no supplier names, towns, refs or links.</span>
      <div className={s.acts}>
        <button type="button" className={cx(s.btn, s.ghost)} onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className={cx(s.btn, s.blue)} disabled={busy}>{busy ? "Building…" : "Build and attach"}</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- To-dos

/** Holder for the suggested to-dos shown under a draft in Review. */
const Todos = {} as { Suggested: (props: { item: RelayReviewItem; draft: RelayDraftView | undefined; reload: () => Promise<void>; say: (t: string) => void }) => React.ReactElement | null };

// ---------------------------------------------------------------- To-dos (Work Tasks)

const CATEGORIES: { key: RelayTask["category"]; name: string; hint: string; colour: string; soft: string; icon: string }[] = [
  { key: "market", name: "Marketplace replies", hint: "Buyers waiting in marketplace chats", colour: "var(--blue)", soft: "var(--blue-soft)", icon: '<path d="M3 9h18l-2 11H5z"/><path d="M8 9V6a4 4 0 0 1 8 0v3"/>' },
  { key: "trade", name: "Buyers and suppliers", hint: "People to reply to or chase", colour: "var(--violet)", soft: "var(--violet-soft)", icon: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 20a6 6 0 0 0-3-5.2"/>' },
  { key: "ops", name: "Recycling and paperwork", hint: "Quotes, invoices and forms", colour: "var(--teal)", soft: "var(--teal-soft)", icon: '<path d="M7 19H4l3.5-6M17 19h3l-3.5-6M12 4l2 3.5M9.5 7.5 12 4"/><path d="M8 13l4-7 4 7M8 19h8"/>' },
  { key: "decide", name: "Needs a decision", hint: "One answer and Relay closes it", colour: "var(--amber)", soft: "var(--amber-soft)", icon: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5h.01"/>' },
  { key: "mine", name: "Added by you", hint: "", colour: "var(--green)", soft: "var(--green-soft)", icon: '<path d="M12 5v14M5 12h14"/>' },
  { key: "other", name: "Other", hint: "Relay is still reading these", colour: "var(--muted)", soft: "var(--soft)", icon: '<circle cx="12" cy="12" r="1.5"/><circle cx="5" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>' },
];
const LINK_ICON: Record<string, string> = {
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  deal: '<path d="M20 12l-8 8-9-9V3h8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  shop: '<path d="M3 9h18l-2 11H5z"/><path d="M8 9V6a4 4 0 0 1 8 0v3"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z"/>',
};
const Svg = ({ d, className }: { d: string; className?: string }) => <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden dangerouslySetInnerHTML={{ __html: d }} />;
const ageDays = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000));

/** Snooze choices relative to now; mornings are 8:00 local. */
function snoozeChoices(now = new Date()): { label: string; hint: string; at: Date }[] {
  const at = (days: number, hour = 8) => { const d = new Date(now); d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0); return d; };
  const fmt = (d: Date) => d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  const toMonday = ((8 - now.getDay()) % 7) || 7;
  const list = [
    ...(now.getHours() < 16 ? [{ label: "Later today", hint: "5 pm", at: at(0, 17) }] : []),
    { label: "Tomorrow", hint: fmt(at(1)), at: at(1) },
    { label: "Monday", hint: fmt(at(toMonday)), at: at(toMonday) },
    { label: "Next week", hint: fmt(at(7)), at: at(7) },
    { label: "In 2 weeks", hint: fmt(at(14)), at: at(14) },
    { label: "In a month", hint: fmt(at(30)), at: at(30) },
  ];
  return list.filter((c, i, all) => all.findIndex((o) => o.hint === c.hint) === i);
}

function SnoozeMenu({ onPick }: { onPick: (at: Date, label: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  const pick = (at: Date, label: string) => { setOpen(false); onPick(at, label); };
  return (
    <span className={s.snz} ref={ref} onClick={(e) => e.stopPropagation()}>
      <button type="button" className={s.tbtn} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>Snooze ▾</button>
      {open && (
        <div className={s.menu} role="menu">
          {snoozeChoices().map((c) => <button key={c.label} type="button" role="menuitem" onClick={() => pick(c.at, c.label.toLowerCase())}>{c.label}<span>{c.hint}</span></button>)}
          <div className={s.msep} />
          <label className={s.mlabel}>Pick a date
            <input type="date" min={new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)} onChange={(e) => { if (e.target.value) { const d = new Date(`${e.target.value}T08:00:00`); pick(d, d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })); } }} />
          </label>
        </div>
      )}
    </span>
  );
}


function Tasks({ tasks, scheduled, reload, say, onOpenListing, onOpenMailMessage, onDrafted }: {
  tasks: RelayTask[]; scheduled: RelayTask[]; reload: () => Promise<void>; say: (t: string, undo?: () => void) => void;
  onOpenListing?: (id: string, title?: string) => void; onOpenMailMessage?: (id: string, title?: string) => void; onDrafted: () => void;
}) {
  const [filter, setFilter] = useState<string>("all");
  const [sel, setSel] = useState<string | null>(null);
  const [gone, setGone] = useState<Record<string, boolean>>({});
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [title, setTitle] = useState("");
  const visible = tasks.filter((t) => !gone[t.id]);
  const urgent = visible.filter((t) => t.urgent_reason).slice(0, 3);
  const rest = visible.filter((t) => !urgent.includes(t));
  const used = CATEGORIES.filter((c) => rest.some((t) => t.category === c.key));
  const shown = filter === "all" || !used.some((c) => c.key === filter) ? used : used.filter((c) => c.key === filter);
  const order = shown.flatMap((c) => rest.filter((t) => t.category === c.key)).map((t) => t.id);

  const post = (id: string, body: unknown) => api(`/api/relay/tasks/${id}`, { method: "POST", body });
  const hide = (id: string) => setGone((g) => ({ ...g, [id]: true }));
  const unhide = (id: string) => setGone((g) => { const n = { ...g }; delete n[id]; return n; });
  const close = async (t: RelayTask, action: "done" | "retire") => {
    hide(t.id);
    try {
      await post(t.id, { action });
      say(`${t.reb_key} ${action === "done" ? "done" : "retired"} · closed in Work Tasks`, async () => { await post(t.id, { action: "reopen" }).catch(() => undefined); unhide(t.id); await reload(); });
      void reload();
    } catch (err) { unhide(t.id); say(err instanceof Error ? err.message : "Couldn't update the task."); }
  };
  const tick = (t: RelayTask) => { setTicked((x) => ({ ...x, [t.id]: true })); setTimeout(() => void close(t, "done"), 350); };
  const snooze = async (t: RelayTask, at: Date, label: string) => {
    hide(t.id);
    try {
      await post(t.id, { action: "snooze", until: at.toISOString() });
      say(`Snoozed until ${label}`, async () => { await post(t.id, { action: "reopen" }).catch(() => undefined); unhide(t.id); await reload(); });
    } catch (err) { unhide(t.id); say(err instanceof Error ? err.message : "Couldn't snooze it."); }
  };
  const open = (t: RelayTask) => {
    if (t.open_message_id && onOpenMailMessage) onOpenMailMessage(t.open_message_id, t.link_label ?? t.title);
    else if (t.bulk_listing_id && onOpenListing) onOpenListing(t.bulk_listing_id, t.link_label ?? undefined);
    else if (t.link_url) window.open(t.link_url, "_blank", "noopener");
    else say("Nothing linked to open for this one.");
  };
  const act = async (t: RelayTask) => {
    if (t.action_kind !== "draft") { open(t); return; }
    setBusy((b) => ({ ...b, [t.id]: true }));
    say(`Drafting for ${t.reb_key}…`);
    try { await post(t.id, { action: "draft" }); say(`Drafted · ${t.reb_key} is in Review`, onDrafted); await reload(); }
    catch (err) { say(err instanceof Error ? err.message : "Couldn't draft it."); }
    finally { setBusy((b) => ({ ...b, [t.id]: false })); }
  };
  const decide = (t: RelayTask, yes: boolean) => {
    if (yes) void close(t, /retire/i.test(t.yes_label ?? "") ? "retire" : "done");
    else { const at = new Date(); at.setDate(at.getDate() + 3); at.setHours(8, 0, 0, 0); void snooze(t, at, "in 3 days"); }
  };
  const [view, setView] = useState<"open" | "scheduled">("open");
  const when = useMemo(() => parseWhen(title), [title]);
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = title.trim();
    if (!text) return;
    const parsed = parseWhen(text);
    if (parsed && !parsed.title) { say("Add what the to-do is, as well as the day."); return; }
    try {
      const r = await api<{ reb_key: string; shows_at: string | null }>("/api/relay/todos", { method: "POST", body: parsed ? { title: parsed.title, on: parsed.date, at: parsed.time } : { title: text } });
      setTitle("");
      say(parsed ? (r.shows_at ? `${r.reb_key} scheduled for ${describeWhen(parsed.date, parsed.time)}. I'll WhatsApp you then.` : `Added ${r.reb_key} to Work Tasks`) : `Added ${r.reb_key} to Work Tasks`);
      await reload();
    } catch (err) { say(err instanceof Error ? err.message : "Couldn't add it."); }
  };
  const showNow = async (t: RelayTask) => { try { await post(t.id, { action: "reopen" }); say(`${t.reb_key} is back in your list`); await reload(); } catch (err) { say(err instanceof Error ? err.message : "Couldn't move it."); } };
  const moveTo = async (t: RelayTask, day: string) => {
    if (!day) return;
    const at = new Date(`${day}T08:00:00`);
    if (Number.isNaN(at.getTime()) || at.getTime() < Date.now()) { say("Pick a day in the future."); return; }
    try { await post(t.id, { action: "snooze", until: at.toISOString() }); say(`${t.reb_key} moved to ${describeWhen(day, null)}`); await reload(); } catch (err) { say(err instanceof Error ? err.message : "Couldn't change the date."); }
  };
  // J/K move, E done, Enter acts, S snoozes (opens the menu on the selected row).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, [role=menu]")) return;
      const key = e.key.toLowerCase();
      if (key === "j" || key === "k") {
        if (!order.length) return;
        const i = sel ? order.indexOf(sel) : -1;
        const next = order[Math.max(0, Math.min(order.length - 1, i < 0 ? 0 : i + (key === "j" ? 1 : -1)))];
        setSel(next); document.getElementById(`task-${next}`)?.scrollIntoView({ block: "nearest" }); e.preventDefault();
      } else if (sel) {
        const t = visible.find((x) => x.id === sel);
        if (!t) return;
        if (key === "e") { tick(t); setSel(null); }
        else if (key === "enter") void act(t);
        else if (key === "s") { (document.querySelector(`#task-${sel} [aria-haspopup=menu]`) as HTMLButtonElement | null)?.click(); e.preventDefault(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const link = (t: RelayTask) => t.link_label ? <button type="button" className={s.tlink} onClick={(e) => { e.stopPropagation(); open(t); }}><Svg d={LINK_ICON[t.link_kind ?? "chat"]} /><span>{t.link_label}</span></button> : null;
  const actionButton = (t: RelayTask, primary = true) => t.action_kind !== "none" && (t.action_kind === "draft" || t.open_message_id || t.bulk_listing_id || t.link_url)
    ? <button type="button" className={cx(s.tbtn, primary && s.tpri)} disabled={busy[t.id]} onClick={(e) => { e.stopPropagation(); void act(t); }}>{busy[t.id] ? "Drafting…" : t.action_label || (t.action_kind === "draft" ? "Draft in Relay" : "Open")}</button> : null;

  return (
    <section aria-label="To-dos" className={s.tasks}>
      <form className={s.tadd} onSubmit={(e) => void add(e)}>
        <Svg d='<path d="M12 5v14M5 12h14"/>' />
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a to-do… try “call Lubomír next Wed” or “send NDA 12 Nov at 3pm”" aria-label="New to-do" />
        {when && <span className={s.parsed}>Appears {describeWhen(when.date, when.time)}</span>}
      </form>

      <div className={s.tfilters} role="group" aria-label="To-do view">
        <button type="button" className={s.tf} aria-pressed={view === "open"} onClick={() => setView("open")}>Open <span className={s.n}>{tasks.length}</span></button>
        <button type="button" className={s.tf} aria-pressed={view === "scheduled"} onClick={() => setView("scheduled")}>Scheduled <span className={s.n}>{scheduled.length}</span></button>
      </div>
      {view === "scheduled" && (
        <section aria-label="Scheduled to-dos" className={s.tgroup}>
          {scheduled.length === 0 && <div className={cx(s.card, s.empty)}><b>Nothing scheduled</b><span className={s.muted}>Add one with a day, like “call Lubomír next Wed”. It shows up here until then.</span></div>}
          {scheduled.map((t) => {
            const day = (t.snooze_until ?? "").slice(0, 10);
            return (
              <div key={t.id} className={s.trow} id={`task-${t.id}`}>
                <div className={s.tmain}><div className={s.tt}><b>{t.title}</b><span className={s.tkey}>{t.reb_key}</span></div></div>
                <div className={s.tside}><span className={s.parsed}>{day ? describeWhen(day, new Date(t.snooze_until!).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" })) : ""}</span></div>
                <div className={s.thov} style={{ opacity: 1 }}>
                  <input type="date" aria-label={`New day for ${t.reb_key}`} min={new Date().toISOString().slice(0, 10)} defaultValue={day} onChange={(e) => void moveTo(t, e.target.value)} className={s.tbtn} />
                  <button type="button" className={s.tbtn} onClick={() => void showNow(t)}>Show now</button>
                  <button type="button" className={s.tbtn} onClick={() => void close(t, "done")}>Done</button>
                </div>
              </div>
            );
          })}
        </section>
      )}
      {view === "open" && <>
      <div className={s.uhead}><h2>Most urgent</h2></div>
      <div className={s.urgent}>
        {urgent.length ? urgent.map((t) => (
          <div key={t.id} className={s.ucard} id={`task-${t.id}`}>
            <span className={cx(s.why, /draft|waiting/i.test(t.urgent_reason ?? "") && s.whyamber)}>● {t.urgent_reason}</span>
            <b>{t.title}</b>
            {t.next_step && <p>{t.next_step}</p>}
            <div className={s.ufoot}>
              <SnoozeMenu onPick={(at, label) => void snooze(t, at, label)} />
              <button type="button" className={s.tbtn} onClick={() => void close(t, "done")}>Done</button>{actionButton(t)}</div>
          </div>
        )) : <div className={s.uempty}><b>Nothing urgent</b>Everything with a date is handled.</div>}
      </div>

      <div className={s.tfilters} role="group" aria-label="Filter">
        {[{ key: "all", name: "Everything", colour: "" }, ...used].map((c) => (
          <button key={c.key} type="button" className={s.tf} aria-pressed={filter === c.key || (c.key === "all" && !used.some((u) => u.key === filter))} onClick={() => setFilter(c.key)}>
            {c.colour && <span className={s.gl} style={{ background: c.colour }} />}{c.name} <span className={s.n}>{c.key === "all" ? rest.length : rest.filter((t) => t.category === c.key).length}</span>
          </button>
        ))}
      </div>

      {shown.length === 0 && !urgent.length && <div className={cx(s.card, s.empty)}><b>All clear</b><span className={s.muted}>No open to-dos. Add one above.</span></div>}
      {shown.map((c) => {
        const list = rest.filter((t) => t.category === c.key);
        return (
          <section key={c.key} className={s.tgroup} aria-label={c.name}>
            <div className={s.tghead}><span className={s.glyph} style={{ background: c.soft, color: c.colour }}><Svg d={c.icon} /></span><h3>{c.name}</h3><span className={s.n}>{list.length}</span></div>
            {list.map((t) => {
              const age = ageDays(t.created_at);
              return (
                <div key={t.id} id={`task-${t.id}`} className={cx(s.trow, sel === t.id && s.tsel)} onClick={() => setSel(t.id)}>
                  <button type="button" className={cx(s.tcb, ticked[t.id] && s.ton)} aria-label={`Mark ${t.reb_key} done`} onClick={(e) => { e.stopPropagation(); tick(t); }}><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg></button>
                  <div className={s.tmain}>
                    <div className={s.tt}><b title={t.next_step || t.title}>{t.title}</b><span className={s.tkey}>{t.reb_key}</span></div>
                    {t.category === "decide" && t.question ? <div className={s.tq} title={t.question}>{t.question}</div>
                      : sel === t.id && t.next_step ? <div className={s.tnext}>{t.next_step}</div> : null}
                  </div>
                  <div className={s.tside}>
                    {t.category === "decide" && t.question
                      ? <span className={s.tanswers}>
                          <button type="button" className={s.tbtn} onClick={(e) => { e.stopPropagation(); decide(t, false); }}>{t.no_label || "Not yet"}</button>
                          <button type="button" className={cx(s.tbtn, s.tpri)} onClick={(e) => { e.stopPropagation(); decide(t, true); }}>{t.yes_label || "Yes, mark done"}</button>
                        </span>
                      : link(t)}
                    <span className={cx(s.tage, age >= 14 && s.told)}>{age}d</span>
                  </div>
                  {t.category !== "decide" && <div className={s.thov}>{actionButton(t)}<SnoozeMenu onPick={(at, label) => void snooze(t, at, label)} /></div>}
                </div>
              );
            })}
          </section>
        );
      })}
      </>}
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

const dealWorking = (i: RelayItem) => !!i.deal_job && ["queued", "running", "ready", "finalising"].includes(i.deal_job.status);

/** The deal under an open email: which inbox it came to, Matcha's latest result, Create deal or Update deal from this reply,
 * and "Link to deal" for a thread Relay won't link by itself, like a supplier quoting for a buyer's request. */
function DealBar({ item: i, busy, create, onRun, onAsk, onLink, onOpenCompany }: { item: RelayItem; busy: boolean; create?: boolean; onRun: (action: "create" | "update") => void; onAsk?: () => void; onLink: (listingId: string | null) => void; onOpenCompany?: (id: string) => void }) {
  const [picking, setPicking] = useState(false);
  const job = i.deal_job;
  // Shown for trade emails only: a deal, Matcha's run, a dismantler, a shared inbox, or a known seller or buyer.
  // "+ Create deal" and opening the deal live in the row.
  if (!i.bulk_listing_id && !job && !i.dismantler && !i.inbox && i.contact_type !== "buyer" && i.contact_type !== "supplier") return null;
  const dismantlerOnly = !i.bulk_listing_id && !!i.dismantler;
  const working = dealWorking(i);
  const result = job?.status === "done" ? job.result : null;
  const d = i.dismantler;
  return (
    <div className={s.dealbar}>
      <div className={s.dealtext}>
        {i.inbox && <span className={s.inbox}>{i.inbox === "buy" ? "buy@ · buyer" : "supply@ · seller"}</span>}
        {working ? <span>Matcha is {job?.action === "update" ? "updating the deal from this reply" : "creating the deal"}…</span>
          : job?.status === "failed" ? <span className={s.dealerr}>Matcha couldn&apos;t finish: {job.error ?? "unknown error"}</span>
          : result ? <span>{result.action === "none" ? `No deal: ${result.next ?? "too small for Bulk Trades"}` : <>{result.action === "created" ? "Deal created" : "Deal updated"}{result.gaps?.length ? <> · missing <b>{result.gaps.join(", ")}</b></> : " · card full"}{result.owner === "Sean" ? " · now Sean's" : ""}{result.next ? <> · next: {result.next}</> : null}</>}</span>
          : i.bulk_listing_id ? <span>Linked to {i.deal_label || "a deal"}</span>
          : dismantlerOnly && d ? <span><button type="button" className={s.linkish} onClick={() => onOpenCompany?.(d.company_id)}>{d.name}</button> is a dismantler{d.phase === "marketplace" ? " on the marketplace" : d.phase === "stock_only" ? " that sends us stock lists" : ""}. One or a few packs go to the marketplace. If they&apos;re quoting for one of our deals, link it.</span>
          : <span>Not linked to a deal yet</span>}
      </div>
      <div className={s.dealbtns}>
        {!working && onAsk && <button type="button" className={s.btn} disabled={busy} title="Drafts the playbook's ask for what the deal is still missing, from the inbox this thread uses. You read it in Review and send." onClick={onAsk}>Draft the ask</button>}
        {!working && i.deal_action === "update" && <button type="button" className={cx(s.btn, s.pri)} disabled={busy} onClick={() => onRun("update")}>
          {job?.status === "failed" && job.action === "update" ? "Try again" : "Update deal from this reply"}</button>}
        {!working && (dismantlerOnly || create) && !i.bulk_listing_id && i.deal_action === "create" && <button type="button" className={s.btn} disabled={busy} title={`Only for a bulk lot: ${BULK_RULE_TEXT}`} onClick={() => onRun("create")}>{job?.status === "failed" && job.action === "create" ? "Try again: create deal" : "+ Create deal"}</button>}
        {!working && !picking && <button type="button" className={s.btn} disabled={busy} title="Tie this thread to one of our open deals. Relay keeps the link; it never guesses one for a supplier." onClick={() => setPicking(true)}>{i.bulk_listing_id ? "Change deal" : "Link to deal"}</button>}
      </div>
      {picking && <DealPicker current={i.bulk_listing_id} canUnlink={!!i.relay_link} busy={busy} onPick={(id) => { setPicking(false); onLink(id); }} onCancel={() => setPicking(false)} />}
    </div>
  );
}

/** Pick one of our open deals for this thread, or unlink it. */
function DealPicker({ current, canUnlink, busy, onPick, onCancel }: { current: string | null; canUnlink: boolean; busy: boolean; onPick: (listingId: string | null) => void; onCancel: () => void }) {
  const [deals, setDeals] = useState<RelayDealOption[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [choice, setChoice] = useState("");
  useEffect(() => {
    let live = true;
    api<{ deals: RelayDealOption[] }>("/api/relay/deals").then((r) => { if (live) setDeals(r.deals); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);
  const label = (d: RelayDealOption) => `${d.kind === "demand" ? "Buying" : "Selling"} · ${d.title}${d.who ? ` · ${d.who}` : ""}`;
  return (
    <div className={s.dealpick}>
      {failed ? <span className={s.dealerr}>Couldn&apos;t load the deals. Try again.</span>
        : <select aria-label="Deal to link this thread to" value={choice} disabled={!deals || busy} onChange={(e) => setChoice(e.target.value)}>
            <option value="">{deals ? "Choose an open deal…" : "Loading deals…"}</option>
            {(["demand", "supply"] as const).map((k) => (
              <optgroup key={k} label={k === "demand" ? "Buyers' requests" : "Supply"}>
                {(deals ?? []).filter((d) => d.kind === k && d.id !== current).map((d) => <option key={d.id} value={d.id}>{label(d)}</option>)}
              </optgroup>
            ))}
          </select>}
      <button type="button" className={cx(s.btn, s.pri)} disabled={!choice || busy} onClick={() => onPick(choice)}>Link</button>
      {current && canUnlink && <button type="button" className={s.btn} disabled={busy} title="Removes the link you made here. The next scan puts back the sender's own deal, if they have one." onClick={() => onPick(null)}>Unlink</button>}
      <button type="button" className={cx(s.btn, s.ghost)} onClick={onCancel}>Cancel</button>
    </div>
  );
}

/** Under Relay AI: what we have from this seller or buyer and what is still missing, from the linked deal. */
function DealChecklistCard({ item, draft, reload, say }: { item: RelayReviewItem; draft: RelayDraftView | undefined; reload: () => Promise<void>; say: (t: string) => void }) {
  const [list, setList] = useState<DealChecklist | null | undefined>(undefined);
  const [counterparty, setCounterparty] = useState(false);
  const [busy, setBusy] = useState(false);
  const linked = !!item.bulk_listing_id;
  useEffect(() => {
    if (!linked) return;
    let live = true;
    api<{ checklist: DealChecklist | null; counterparty: boolean }>(`/api/relay/items/${item.id}/checklist`)
      .then((r) => { if (live) { setList(r.checklist); setCounterparty(r.counterparty); } }).catch(() => { if (live) setList(null); });
    return () => { live = false; };
  }, [item.id, linked, item.updated_at]);
  if (!linked) return item.contact_type === "buyer" || item.contact_type === "supplier"
    ? <div className={cx(s.card, s.check)}><b>No deal yet</b><span className={s.muted}>Create the deal from the inbox and this lists what we have and what is missing.</span></div>
    : null;
  if (list === undefined) return <div className={cx(s.card, s.check)}><span className={s.muted}>Loading the deal…</span></div>;
  if (counterparty) return <div className={cx(s.card, s.check)}><b>Answering someone else&apos;s deal</b><span className={s.muted}>{firstName(item.counterpart_name)} is quoting on another party&apos;s request, so that deal&apos;s checklist isn&apos;t shown here. Update deal from this reply records their quote on their offer.</span></div>;
  if (!list) return null;
  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    try { setList((await api<{ checklist: DealChecklist | null }>(`/api/relay/items/${item.id}/checklist`, { method: "POST", body })).checklist); }
    catch (err) { say(err instanceof Error ? err.message : "Couldn't save that."); }
    finally { setBusy(false); }
  };
  const tick = (row: ChecklistItem) => post({ key: row.key, have: !row.have });
  const q = list.qualify;
  const instruction = missingInstruction(list);
  const addMissing = async () => {
    if (!instruction || !draft?.mail || draft.state === "sent") return;
    setBusy(true);
    try { await api(`/api/relay/drafts/${draft.id}/rewrite`, { method: "POST", body: { instruction } }); say("Added what's missing to the draft"); await reload(); }
    catch (err) { say(err instanceof Error ? err.message : "Couldn't change the draft."); }
    finally { setBusy(false); }
  };
  const who = firstName(item.counterpart_name) || "them";
  const group = (name: string, rows: ChecklistItem[]) => (
    <div className={s.cgroup}>
      <div className={s.chead}><span>{name}</span><span>{rows.filter((r) => r.have).length} of {rows.length}</span></div>
      {rows.map((r) => (
        <div key={r.key} className={s.citem}>
          <label className={cx(s.crow, !r.have && !r.cannot && s.cmiss)}>
            <input type="checkbox" checked={r.have} disabled={!r.manual || busy} onChange={() => void tick(r)} />
            <span>{r.label}</span>
            <span className={cx(s.cval, r.warn && s.cwarn)}>{r.have ? [r.value, r.warn].filter(Boolean).join(" · ") || "Yes" : r.cannot ? "They can't provide it" : r.manual ? "Tick if you know" : r.asked ? `Missing · asked ${r.asked}x` : "Missing"}</span>
          </label>
          {r.forTick !== undefined && (
            <span className={s.cstate}>
              {(r.have || r.cannot) && <button type="button" className={s.linkish} disabled={busy} onClick={() => void post({ key: r.key, checked: !r.checkedAt })}>{r.checkedAt ? "✓ Checked" : "Mark checked"}</button>}
              {!r.have && <button type="button" className={s.linkish} disabled={busy} onClick={() => void post({ key: r.key, cannot: !r.cannot })}>{r.cannot ? "They can provide it" : "They can't provide it"}</button>}
            </span>
          )}
        </div>
      ))}
    </div>
  );
  return (
    <section className={cx(s.card, s.check)} aria-label="What we have">
      <div className={s.ctitle}><b>What we have from {who}</b><span>{list.kind === "demand" ? "buyer" : "seller"}</span></div>
      {group("Required", list.required)}
      {group("Helpful", list.helpful)}
      {q && (
        <div className={s.cqual}>
          <span>
            <b>{q.qualified ? "Qualified" : q.ready ? "Ready to qualify" : "Not qualified yet"}</b>
            {q.noPrice && <span className={s.dism}>No price</span>}
            {q.noDate && <span className={s.dism}>No date</span>}
            {!q.ready && <span className={s.muted}> · {q.missing.join(", ")}</span>}
          </span>
          {(q.ticked || q.ready) && <button type="button" className={s.btn} disabled={busy} onClick={() => void post({ qualified: !q.ticked })}>{q.ticked ? "Untick Qualified" : "Mark Qualified"}</button>}
          {q.park && <span className={s.cwarn}>{q.park}</span>}
        </div>
      )}
      <div className={s.cfoot}>
        <span className={s.muted}>Matcha ticks these from their emails. Tick the ones without a field yourself.</span>
        {instruction && draft?.mail && draft.state !== "sent" && <button type="button" className={s.btn} disabled={busy} onClick={() => void addMissing()}>Add missing to draft</button>}
      </div>
    </section>
  );
}
