"use client";

import { useCallback, useEffect, useRef, useState, type RefObject, type SetStateAction } from "react";
import { ArrowUpRight, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import type { RelayItem, RelayJob, RelayReviewItem } from "@/lib/relay";
import type { SendOutcome, TalkDraft, TalkState } from "@/lib/relay-talk";
import type { DeskMode } from "@/lib/relay-desk-core";
import { foundRun, keepPolling, runState, type DeskTalk, type Following } from "@/lib/relay-desk-view-core";
import type { PriceFill, StockFit } from "@/lib/relay-price-types";
import type { SendMode } from "@/lib/relay-talk-core";
import { fillGaps } from "@/lib/relay-ways-core";
import { dealLine, draftNeeds, earlierRows, gapSpans, sendGate, versionsOf, type EarlierRow } from "@/lib/relay-workspace-core";
import { boldSpans, cleanEmail, emailParagraphs, firstLine, type ThreadEmail } from "@/lib/relay-email-clean";
import { AUTO_NOTE } from "@/lib/relay-auto-note";
import { AttachmentStrip } from "@/app/components/crm/inbox/attachment-strip";
import { api, cx, failureText, firstName, firstOf, statusOf } from "./relay-ui";
import { DraftSheet, type SheetActions } from "./relay-workspace-draft";
import { RelayChat } from "./relay-workspace-chat";
import { SnoozeMenu } from "./relay-snooze";
import w from "./relay-workspace.module.css";

/** A message at the foot of the page, with an optional Undo, a second action and (until, ms) a countdown. */
export type Toast = { text: string; undo?: () => void | Promise<void>; action?: { label: string; run: () => void | Promise<void> }; until?: number };
export type Say = (text: string, more?: Omit<Toast, "text">) => void;
export type StockView = { fits: StockFit[]; prices: PriceFill[] };
/** What Send did, shown under the Send bar until the drafts say what happened. */
export type SendRun = { results: SendOutcome[]; until: number };

const JOB_BUSY = new Set<RelayJob["status"]>(["queued", "running", "ready", "finalising"]);
/** How often the page reads the chat while Relay's desk works on this email. */
const DESK_POLL_MS = 1500;
/** Why Send, the prices and the gaps wait while the desk works: its changes and Alex's would race. */
const DESK_HOLD = "Relay is changing these emails. Send waits until it finishes, or press Stop.";
const message = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");

/** One person's email: who they are, what they wrote, the reply with its linked emails, and Relay's chat about them. */
export function Work({ itemId, name, waited, item, job, reviewIds, autoDraft, onOpenDeal, onOpenMail, say, text, setText, composer, onDone, onSnooze, onOpen, onBack, refreshLists }: {
  itemId: string; name: string; waited: string | null; item: RelayItem | RelayReviewItem | null; job: RelayJob | null; reviewIds: string[];
  /** Write Relay's first reply on opening when there is none ("Waiting on you" only). */
  autoDraft: boolean;
  /** Opens the linked deal, or an email as it was sent, in a new CRM tab. */
  onOpenDeal?: (id: string, title?: string) => void; onOpenMail?: (id: string, title?: string) => void;
  say: Say; text: string; setText: (next: SetStateAction<string>) => void; composer: RefObject<HTMLTextAreaElement | null>;
  onDone?: () => void; onSnooze?: (until: string) => void; onOpen: (itemId: string) => void; onBack: () => void; refreshLists: () => Promise<void>;
}) {
  const [talk, setTalkState] = useState<DeskTalk | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const talkRef = useRef<DeskTalk | null>(null);
  /** Every change to the talk state goes through here, so an action that awaits sees the latest drafts at once. */
  const setTalk = useCallback((next: DeskTalk | null) => { talkRef.current = next; setTalkState(next); }, []);
  const update = useCallback((fn: (t: DeskTalk) => DeskTalk) => { if (talkRef.current) setTalk(fn(talkRef.current)); }, [setTalk]);
  // Loads are numbered as they start; `fresh` is the number of the one the page shows. An answer that started earlier than
  // the one shown is dropped, and a desk turn only counts as ended on a load that started after it was known.
  const loads = useRef(0);
  const freshRef = useRef(0);
  const [fresh, setFresh] = useState(0);
  const setDrafts = useCallback((drafts: TalkDraft[]) => update((t) => ({ ...t, drafts })), [update]);
  const patchDraft = useCallback((id: string, fn: (d: TalkDraft) => TalkDraft) => update((t) => ({ ...t, drafts: t.drafts.map((d) => (d.id === id ? fn(d) : d)) })), [update]);

  const load = useCallback(async () => {
    const mine = ++loads.current;
    try {
      const next = await api<DeskTalk>(`/api/relay/items/${itemId}/talk`);
      if (mine < freshRef.current) return talkRef.current;
      freshRef.current = mine;
      setFresh(mine);
      setTalk(next);
      setLoadError(null);
      return next;
    } catch (err) { setLoadError(message(err, "Couldn't load this email.")); return null; }
  }, [itemId, setTalk]);
  useEffect(() => { void load(); }, [load]);

  // The thread's emails in full, newest first: the newest shown cleaned, the earlier ones opened from their summary.
  const [thread, setThread] = useState<ThreadEmail[] | null>(null);
  useEffect(() => {
    let live = true;
    api<{ emails: ThreadEmail[] }>(`/api/relay/items/${itemId}/thread`).then((t) => { if (live) setThread(t.emails); }).catch(() => { if (live) setThread([]); });
    return () => { live = false; };
  }, [itemId]);

  // What else fits, for the margin of a buyer's reply. Only Alex sees it.
  const [stock, setStock] = useState<StockView | { error: string } | null>(null);
  useEffect(() => {
    let live = true;
    api<StockView>(`/api/relay/items/${itemId}/stock`).then((s) => { if (live) setStock(s); }).catch((err) => { if (live) setStock({ error: message(err, "Couldn't read the stock.") }); });
    return () => { live = false; };
  }, [itemId]);

  const drafts = talk?.drafts ?? [];
  const [tab, setTab] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const current = drafts.find((d) => d.id === tab) ?? drafts[0] ?? null;
  const pickTab = (id: string) => { setTab(id); setAll(false); };

  // The desk turn the page follows (see the chat below), and whether it is still working: while it is, nothing else
  // changes the drafts.
  const [following, setFollowingState] = useState<Following | null>(null);
  const followingRef = useRef<Following | null>(null);
  const setFollowing = (next: Following | null) => { followingRef.current = next; setFollowingState(next); };
  const run = following ? runState(following, talk, fresh) : null;
  const deskBusy = run?.kind === "running";

  /** The draft with these fills, and whether a gap is still open (the server's reading, worked out again here). */
  const withFills = (d: TalkDraft, fills: PriceFill[]): TalkDraft => {
    const needs = draftNeeds(d.mail?.main ?? "", fills);
    return { ...d, fills, gaps: needs.emptyPrices + needs.otherGaps > 0 };
  };

  // ---- typed gaps (not prices): kept here until the field is left, then saved into the draft
  const [typed, setTypedState] = useState<Record<string, Record<number, string>>>({});
  const typedRef = useRef(typed);
  const setTyped = (fn: (t: Record<string, Record<number, string>>) => Record<string, Record<number, string>>) => { typedRef.current = fn(typedRef.current); setTypedState(typedRef.current); };
  const saves = useRef<Promise<unknown>>(Promise.resolve());
  const saveGaps = (draftId: string) => {
    const run = saves.current.then(async () => {
      const values = { ...typedRef.current[draftId] };
      const mail = talkRef.current?.drafts.find((d) => d.id === draftId)?.mail;
      const filled = Object.entries(values).filter(([, v]) => v.trim());
      if (!mail || !filled.length) return;
      const list: (string | undefined)[] = [];
      for (const [k, v] of filled) list[Number(k)] = v;
      try {
        const out = await api<{ updated_at: string; editable: { main: string } }>(`/api/mail/drafts/${mail.id}`, { method: "PATCH", body: { body: fillGaps(mail.main, list), updated_at: mail.updated_at } });
        // The marks pointed into the old text; the next load brings them back for Relay's own changes.
        patchDraft(draftId, (d) => (d.mail ? withFills({ ...d, marks: [], mail: { ...d.mail, main: out.editable.main, updated_at: out.updated_at } }, d.fills) : d));
        // A filled gap leaves the text, so the gaps after it move up one. What was typed meanwhile follows its gap.
        const done = filled.map(([k]) => Number(k));
        setTyped((t) => {
          const left = Object.entries(t[draftId] ?? {}).filter(([k, v]) => !(done.includes(Number(k)) && values[Number(k)] === v));
          const moved = Object.fromEntries(left.map(([k, v]) => [Number(k) - done.filter((i) => i < Number(k)).length, v]));
          return { ...t, [draftId]: moved };
        });
      } catch (err) { say(message(err, "Couldn't save that.")); void load(); }
    });
    saves.current = run.catch(() => undefined);
    return run;
  };

  // ---- prices
  const setPrice = async (draftId: string, key: string, value: number | null) => {
    try {
      const { fills } = await api<{ fills: PriceFill[] }>(`/api/relay/drafts/${draftId}/fills`, { method: "PUT", body: { key, value } });
      patchDraft(draftId, (d) => withFills(d, fills));
      return true;
    } catch (err) { say(message(err, "Couldn't save the price.")); return false; }
  };
  const acceptPrice = async (draftId: string, key: string) => {
    try {
      const { fills } = await api<{ fills: PriceFill[] }>(`/api/relay/drafts/${draftId}/fills/accept`, { method: "POST", body: { key } });
      patchDraft(draftId, (d) => withFills(d, fills));
    } catch (err) { say(message(err, "Couldn't keep that price.")); }
  };
  const [repricing, setRepricing] = useState(false);
  const reprice = async () => {
    if (deskBusy) { say(DESK_HOLD); return; }
    const targets = (talkRef.current?.drafts ?? []).filter((d) => d.mail && d.state !== "sent" && !d.mail.scheduled && d.to_kind !== "supplier" && gapSpans(d.mail.main).some((g) => g.priceKey));
    if (!targets.length) { say("There's no price to work out in these emails."); return; }
    setRepricing(true);
    try {
      for (const d of targets) {
        const { fills } = await api<{ fills: PriceFill[] }>(`/api/relay/drafts/${d.id}/fills/price`, { method: "POST" });
        patchDraft(d.id, (x) => withFills(x, fills));
      }
      say("Re-priced. Your own prices stay as you set them.");
    } catch (err) { say(message(err, "Couldn't work out the prices.")); } finally { setRepricing(false); }
  };

  // ---- undo, linked emails
  const undo = async (draftId: string, redo: boolean) => {
    try { setDrafts((await api<{ drafts: TalkDraft[] }>(`/api/relay/drafts/${draftId}/undo`, { method: "POST", body: redo ? { redo: true } : {} })).drafts); }
    catch (err) { say(message(err, redo ? "Couldn't redo." : "Couldn't undo.")); }
  };
  const setLinked = async (draftId: string, patch: { included?: boolean; send_mode?: SendMode; send_at?: string | null }) => {
    try { setDrafts((await api<{ drafts: TalkDraft[] }>(`/api/relay/drafts/${draftId}/linked`, { method: "PATCH", body: patch })).drafts); return true; }
    catch (err) { say(message(err, "Couldn't change that.")); return false; }
  };

  // ---- sending
  const [busy, setBusy] = useState<"send" | "gmail" | "later" | "undo" | null>(null);
  const [sendRun, setRun] = useState<SendRun | null>(null);
  const toLabel = (d: TalkDraft | undefined) => {
    const to = d?.mail?.to_emails[0] ?? "";
    return item?.counterpart_email && to.toLowerCase() === item.counterpart_email.toLowerCase() && item.counterpart_name ? firstName(item.counterpart_name) : to || name;
  };
  const undoAll = async () => {
    setBusy("undo");
    try {
      const out = await api<{ results: SendOutcome[]; drafts: TalkDraft[] }>(`/api/relay/items/${itemId}/send-all`, { method: "DELETE" });
      setDrafts(out.drafts);
      setRun(null);
      const stuck = out.results.filter((r) => r.outcome === "failed");
      say(stuck.length ? `Couldn't stop ${stuck.map((r) => `“${r.title}”: ${r.why ?? "it may have gone"}`).join(" ")}` : "Stopped. They're drafts again.");
    } catch (err) { say(message(err, "Couldn't stop it.")); } finally { setBusy(null); }
  };
  const sendAll = async () => {
    if (deskBusy) { say(DESK_HOLD); return; }
    await saves.current;
    const now = talkRef.current?.drafts ?? [];
    const gate = sendGate(now, typedRef.current);
    if (!gate.ready) { say(gate.line); return; }
    setBusy("send");
    try {
      const out = await api<{ results: SendOutcome[]; drafts: TalkDraft[]; undo_seconds: number }>(`/api/relay/items/${itemId}/send-all`, { method: "POST", body: { confirm: true, updated_at: versionsOf(gate.going) } });
      setDrafts(out.drafts);
      const until = Date.now() + out.undo_seconds * 1000;
      setRun({ results: out.results, until });
      const failed = out.results.filter((r) => r.outcome === "failed").length;
      say(failed ? `Sending to ${toLabel(gate.going[0])}, but ${failed === 1 ? "one linked email" : `${failed} linked emails`} didn't queue. Undo in` : `Sending to ${toLabel(gate.going[0])}. Undo in`, { undo: undoAll, until });
      void refreshLists();
    } catch (err) { say(`Not sent: ${message(err, "something went wrong")}`); void load(); } finally { setBusy(null); }
  };
  // After the hold, watch the reply until it has gone or says why not.
  useEffect(() => {
    if (!sendRun) return;
    let tries = 0;
    const t = setInterval(async () => {
      if (Date.now() < sendRun.until || tries++ > 20) { if (tries > 20) clearInterval(t); return; }
      const next = await load();
      const reply = next?.drafts.find((d) => d.role === "primary");
      if (!reply) return;
      if (reply.state === "sent") { say(`Sent to ${toLabel(reply)}.`); clearInterval(t); }
      else if (reply.mail?.failure || reply.mail?.state === "failed" || reply.mail?.state === "unknown") { say(`Not sent: ${failureText(reply.mail.failure, reply.mail.state)}`); clearInterval(t); }
    }, 4000);
    return () => clearInterval(t);
  }, [sendRun]); // eslint-disable-line react-hooks/exhaustive-deps

  const seen = (d: TalkDraft) => d.fills.map((f) => ({ key: f.key, value: f.value }));
  const toGmail = async (d: TalkDraft) => {
    await saves.current;
    setBusy("gmail");
    try {
      const out = await api<{ url: string }>(`/api/relay/drafts/${d.id}/gmail`, { method: "POST", body: { fills: seen(d) } });
      say("In Gmail drafts, in alex@rebattery.io.", { action: { label: "Open Gmail", run: () => { window.open(out.url, "_blank", "noopener"); } } });
      void load();
    } catch (err) { say(message(err, "Couldn't reach Gmail.")); } finally { setBusy(null); }
  };
  const sendLater = async (d: TalkDraft, at: string) => {
    await saves.current;
    const latest = talkRef.current?.drafts.find((x) => x.id === d.id) ?? d;
    if (!latest.mail) return;
    setBusy("later");
    try {
      await api(`/api/relay/drafts/${d.id}/schedule`, { method: "POST", body: { confirm: true, updated_at: latest.mail.updated_at, send_at: at, fills: seen(latest) } });
      say(`The reply goes ${when(at)}. Linked emails stay as drafts.`);
      await load();
      void refreshLists();
    } catch (err) { say(message(err, "Couldn't schedule it.")); } finally { setBusy(null); }
  };
  const cancelLater = async (d: TalkDraft) => {
    setBusy("later");
    try { await api(`/api/relay/drafts/${d.id}/schedule`, { method: "DELETE" }); say("Cancelled. It's a draft again."); await load(); }
    catch (err) { say(message(err, "Couldn't cancel.")); } finally { setBusy(null); }
  };

  // ---- the chat
  // Each message, and the first draft on opening, is one turn of the email's desk (a Claude Code session, lib/relay-desk.ts).
  // The page follows the turn by reading the chat every second and a half: its work lines, its words and the drafts it
  // changed arrive together. The one-shot paths (talk, /draft) are only used when the desk can't start (503).
  const [pending, setPending] = useState<{ text: string; started: number; first: boolean; auto?: boolean } | null>(null);
  const [chatError, setChatError] = useState<{ text: string; mode: DeskMode; line: string; quiet?: boolean } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const draftsAtStart = useRef<Set<string>>(new Set());
  const [stopAsked, setStopAsked] = useState<string | null>(null);
  const hasReply = drafts.some((d) => d.mail);
  const jobBusy = !!job && JOB_BUSY.has(job.status);

  /** Starts a desk turn and follows it. "unavailable": the desk can't start here (503), so the caller uses the one-shot path. */
  const startDesk = async (mode: DeskMode, said: string, started: number): Promise<"started" | "unavailable"> => {
    const before = talkRef.current?.turns.map((t) => t.id) ?? [];
    draftsAtStart.current = new Set(talkRef.current?.drafts.filter((d) => d.mail).map((d) => d.id));
    try {
      const out = await api<{ run: { id: string } }>(`/api/relay/items/${itemId}/desk`, { method: "POST", body: mode === "chat" ? { text: said, mode } : { mode } });
      setFollowing({ runId: out.run.id, mode, text: said, startedAt: started, before, fromLoad: loads.current });
      void load();
      return "started";
    } catch (err) {
      if (statusOf(err) === 503) return "unavailable";
      throw err;
    }
  };

  const ask = async (raw: string) => {
    const said = raw.trim();
    if (!said || pending || deskBusy) return;
    const first = !talkRef.current?.drafts.some((d) => d.mail);
    if (first && jobBusy) { say("Relay is still working on the first reply."); return; }
    const started = Date.now();
    setPending({ text: said, started, first });
    setChatError(null);
    setNotice(null);
    setText("");
    try {
      if (await startDesk("chat", said, started) === "started") return;
      setNotice("The drafting session couldn't start, so Relay answered quickly instead.");
      if (first) {
        // The first message writes the reply and any follow-ons; a note that needs research starts a job instead.
        await api(`/api/relay/items/${itemId}/draft`, { method: "POST", body: { note: said } });
        await Promise.all([load(), refreshLists()]);
      } else {
        const target = all ? "all" : current?.id ?? "all";
        const before = new Set(talkRef.current?.drafts.map((d) => d.id));
        const next = await api<TalkState>(`/api/relay/items/${itemId}/talk`, { method: "POST", body: { text: said, target } });
        setTalk({ ...next, desk: null, claudeSession: talkRef.current?.claudeSession ?? null });
        // A new email Relay added opens in its tab, so Alex sees it at once.
        const added = next.drafts.find((d) => d.mail && !before.has(d.id));
        if (added) pickTab(added.id);
      }
    } catch (err) {
      setChatError({ text: said, mode: "chat", line: `That didn't go through: ${message(err, "Something went wrong. Try again.")}` });
      // Never lose what Alex wrote: it goes back in the box unless he has started something new.
      setText((t) => (t.trim() ? t : said));
      void load();
    } finally { setPending(null); }
  };

  /** Relay's first reply, written by the desk in quick mode (the one-shot /draft when the desk can't start). Shown as Relay's own work. */
  const firstDraft = () => {
    const started = Date.now();
    setPending({ text: "", started, first: true, auto: true });
    setChatError(null);
    startDesk("quick", "", started)
      .then(async (out) => {
        if (out === "started") return;
        await api(`/api/relay/items/${itemId}/draft`, { method: "POST", body: { note: AUTO_NOTE, mode: "quick" } });
        await Promise.all([load(), refreshLists()]);
      })
      // 409: a turn is already working on it (the background draft); the next load finds it and follows it.
      .catch((err) => (statusOf(err) === 409 ? void load() : say(message(err, "Relay couldn't write a first reply. Tell it how to answer instead."))))
      .finally(() => setPending(null));
  };
  // An email with no reply gets Relay's first draft as soon as it opens (once per visit), unless Alex has started typing.
  // The top of the list is usually drafted ahead of time (relay-prepare.ts); this covers the rest.
  const autoTried = useRef<string | null>(null);
  useEffect(() => {
    if (!autoDraft || !talk || hasReply || jobBusy || pending || talk.desk || following || autoTried.current === itemId || text.trim()) return;
    // A draft already waits on another of their emails: that one is the reply.
    if (reviewIds.some((id) => id !== itemId)) return;
    autoTried.current = itemId;
    firstDraft();
  }, [autoDraft, talk, hasReply, jobBusy, pending, following, itemId, text]); // eslint-disable-line react-hooks/exhaustive-deps

  // A turn already running when the email opens (the background draft, or one started before a reload) is followed too.
  useEffect(() => {
    if (followingRef.current || !talk) return;
    const found = foundRun(talk, fresh);
    if (!found) return;
    draftsAtStart.current = new Set(talk.drafts.filter((d) => d.mail).map((d) => d.id));
    setFollowing(found);
  }, [talk, fresh]);

  // While a turn runs, read the chat every second and a half: work lines, words and the drafts arrive together.
  const polling = keepPolling(following, talk, fresh);
  useEffect(() => {
    if (!polling) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => { await load(); if (live) timer = setTimeout(tick, DESK_POLL_MS); };
    timer = setTimeout(tick, DESK_POLL_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [polling, load]);

  // When the turn ends: a new email opens in its tab; a stopped or failed turn says so, and Alex's words go back in the box.
  useEffect(() => {
    const f = followingRef.current;
    if (!f || !run || run.kind === "running") return;
    setFollowing(null);
    setStopAsked(null);
    if (run.kind === "done") {
      const added = talkRef.current?.drafts.find((d) => d.mail && d.role === "follow" && !draftsAtStart.current.has(d.id));
      if (added) pickTab(added.id);
      void refreshLists();
      return;
    }
    setChatError({
      text: f.text, mode: f.mode, quiet: run.kind === "stopped",
      line: run.kind === "stopped" ? "Stopped. Anything Relay had already changed stays in the drafts, with Undo." : "Relay couldn't finish that. Anything it changed is in the drafts, with Undo.",
    });
    if (f.mode === "chat" && f.text) setText((t) => (t.trim() ? t : f.text));
  }, [run?.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const stopDesk = async () => {
    if (!following) return;
    setStopAsked(following.runId);
    try { await api(`/api/relay/items/${itemId}/desk/stop`, { method: "POST" }); }
    catch (err) { if (statusOf(err) !== 409) { setStopAsked(null); say(message(err, "Couldn't stop Relay.")); } }
    void load();
  };
  const retry = () => {
    if (!chatError) return;
    if (chatError.mode === "chat") void ask(chatError.text);
    else firstDraft();
  };

  // While a first-reply job researches, check on it every few seconds; when it finishes, bring the drafts in.
  useEffect(() => {
    if (!jobBusy) return;
    const t = setInterval(() => void refreshLists(), 5000);
    return () => clearInterval(t);
  }, [jobBusy, refreshLists]);
  const jobWas = useRef(job?.status);
  useEffect(() => {
    if (jobWas.current && JOB_BUSY.has(jobWas.current) && job && !JOB_BUSY.has(job.status)) void load();
    jobWas.current = job?.status;
  }, [job, load]);

  const createDeal = async () => {
    try { await api(`/api/relay/items/${itemId}/deal`, { method: "POST", body: { action: "create" } }); say("Matcha is creating the deal. It shows here when it's done."); void refreshLists(); }
    catch (err) { say(message(err, "Couldn't start the deal.")); }
  };
  const saveRule = async (rule: string) => {
    try { await api("/api/relay/rules", { method: "POST", body: { text: rule } }); say("Saved to Rules."); return true; }
    catch (err) { say(message(err, "Couldn't save the rule.")); return false; }
  };
  const prompt = (words: string) => { setText(words); requestAnimationFrame(() => { const el = composer.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }); };

  const edit = async (d: TalkDraft, changes: Parameters<SheetActions["edit"]>[1]) => {
    await saves.current;
    const latest = talkRef.current?.drafts.find((x) => x.id === d.id) ?? d;
    if (!latest.mail) return false;
    try {
      await api(`/api/relay/drafts/${d.id}/edit`, { method: "PATCH", body: { updated_at: latest.mail.updated_at, ...changes } });
      await load();
      return true;
    } catch (err) { say(message(err, "Couldn't save your edit.")); return false; }
  };
  const actions: SheetActions = { setPrice, acceptPrice, undo, setLinked, sendAll, undoAll, toGmail, sendLater, cancelLater, saveGaps, edit,
    typeGap: (draftId, index, value) => setTyped((t) => ({ ...t, [draftId]: { ...t[draftId], [index]: value } })) };

  const msg = item?.last_message;
  const late = waited != null && parseInt(waited, 10) >= 7;
  const deal = item?.bulk_listing_id ? item.deal_label ?? "Linked deal" : null;
  const dealBusy = !!item?.deal_job && JOB_BUSY.has(item.deal_job.status);

  return (
    <>
      <main className={w.main}>
        <button type="button" className={w.back} onClick={onBack}><ChevronLeft size={14} aria-hidden />Waiting on you</button>
        <section className={w.person} aria-label={name}>
          <div className={w.personTop}>
            <h1 title={name}>{name}</h1>
            {(onSnooze || onDone) && (
              <span className={w.actions}>
                {onSnooze && <SnoozeMenu onPick={onSnooze} />}
                {onDone && <button type="button" className={w.act} onClick={onDone}>No reply needed</button>}
              </span>
            )}
          </div>
          <div className={w.personMeta}>
            {waited && <span className={late ? w.lateText : w.waited}>{waited === "today" ? "Waiting since today" : `Waiting ${waited.replace(" d", waited === "1 d" ? " day" : " days")}`}</span>}
            {deal && item?.bulk_listing_id ? (
              <DealLineView label={deal} deal={"deal" in item ? item.deal ?? null : null} onOpen={onOpenDeal ? () => onOpenDeal(item.bulk_listing_id!, deal) : undefined} />
            ) : (
              <button type="button" className={w.dealNew} onClick={() => void createDeal()} disabled={dealBusy}>
                <Plus size={13} aria-hidden />{dealBusy ? "Matcha is creating the deal…" : "Create deal"}
              </button>
            )}
          </div>
        </section>

        {msg && (
          <section className={w.email} aria-label={`What ${firstOf(name)} wrote`}>
            <span className={w.meta}>{[when(msg.at), msg.from_email].filter(Boolean).join(", ")}{msg.direction === "outbound" ? ". Your last email, no reply since." : ""}</span>
            <NewestEmail text={thread?.[0]?.text || msg.text} onOriginal={thread?.[0] && onOpenMail ? () => onOpenMail(thread[0].id, `Email from ${name}`) : undefined} />
            {item?.attachment_message_id && <AttachmentStrip messageId={item.attachment_message_id} />}
            <Earlier rows={thread ? earlierRows(thread.slice(1), item?.earlier ?? [], firstOf(name)) : null} count={item?.earlier?.length ?? 0} onOpenMail={onOpenMail} />
          </section>
        )}
        {reviewIds.length > 0 && reviewIds[0] !== itemId && (
          <p className={w.muted}>A draft is ready on their earlier email. <button type="button" className={w.linkbtn} onClick={() => onOpen(reviewIds[0])}>Open it</button></p>
        )}

        {loadError && !talk && <p className={w.error} role="alert">{loadError} <button type="button" className={w.linkbtn} onClick={() => void load()}>Try again</button></p>}
        {!talk && !loadError && <p className={w.muted} role="status">Loading the reply…</p>}
        {talk && (
          <DraftSheet drafts={drafts} current={current} onTab={pickTab} name={name} typed={typed} stock={stock} busy={busy} run={sendRun} actions={actions}
            job={hasReply ? null : job} jobNote={item?.note ?? ""} pendingFirst={!!pending?.first || (deskBusy && !hasReply)} hold={deskBusy ? DESK_HOLD : null} />
        )}
      </main>
      <RelayChat talk={talk} name={name} drafts={drafts} current={current} all={all} onTarget={(id) => (id === "all" ? setAll(true) : pickTab(id))}
        pending={pending} error={chatError} onRetry={chatError && (chatError.mode !== "chat" || chatError.text) ? retry : null} text={text} setText={setText} onAsk={(t) => void ask(t)} composer={composer}
        desk={following && deskBusy ? { run: following.runId, startedAt: following.startedAt, stopping: run.kind === "running" && run.stopping || stopAsked === following.runId, onStop: () => void stopDesk() } : null}
        echo={following?.mode === "chat" && fresh <= following.fromLoad ? following.text : null} notice={notice} say={say}
        firstNote={hasReply || jobBusy ? item?.note ?? "" : ""} repricing={repricing}
        quick={{ followUp: () => prompt("Also email "), style: () => prompt("Change the style: "), reprice: () => void reprice(), deal: deal ? null : () => void createDeal() }}
        saveRule={saveRule} />
    </>
  );
}

/** An email as Alex reads it: cleaned (no quotes, signature block or disclaimer), in tight paragraphs. */
function EmailText({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cx(w.mailText, className)}>
      {emailParagraphs(text).map((p, k) => <p key={k}>{boldSpans(p).map((x, j) => (x.bold ? <b key={j}>{x.text}</b> : x.text))}</p>)}
    </div>
  );
}

function NewestEmail({ text, onOriginal }: { text: string; onOriginal?: () => void }) {
  const long = cleanEmail(text).length > 1200;
  const [open, setOpen] = useState(false);
  return (
    <>
      <EmailText text={text} className={long && !open ? w.clamp : undefined} />
      {(long || onOriginal) && (
        <span className={w.mailLinks}>
          {long && <button type="button" className={w.linkbtn} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Show less" : "Show the whole email"}</button>}
          {onOriginal && <button type="button" className={w.quietLink} onClick={onOriginal}>Open the original</button>}
        </span>
      )}
    </>
  );
}

/** The earlier emails: one line each (the scan's summary, or the email's first line), each opening to the full email. */
function Earlier({ rows, count, onOpenMail }: { rows: EarlierRow<ThreadEmail>[] | null; count: number; onOpenMail?: (id: string, title?: string) => void }) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const total = rows ? rows.length : count;
  if (!total) return null;
  return (
    <>
      {open && rows && (
        <ol className={w.older}>
          {rows.map(({ email, when, who, summary }) => {
            const on = !!shown[email.id];
            const line = summary ?? firstLine(email.text);
            return (
              <li key={email.id} className={on ? w.olderOpen : undefined}>
                <button type="button" className={w.olderRow} aria-expanded={on} onClick={() => setShown((m) => ({ ...m, [email.id]: !on }))}>
                  <ChevronRight size={13} aria-hidden className={w.olderChevron} />
                  <span className={w.meta}>{when}, {who}</span>
                  <span className={w.olderLine}>{line}</span>
                </button>
                {on && (
                  <div className={w.olderBody}>
                    <EmailText text={email.text} />
                    {onOpenMail && <button type="button" className={w.quietLink} onClick={() => onOpenMail(email.id, `Email from ${who}, ${when}`)}>Open the original</button>}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      <span><button type="button" className={w.linkbtn} aria-expanded={open} onClick={() => setOpen(!open)} disabled={!rows}>
        {open ? "Hide the earlier emails" : `${total} earlier ${total === 1 ? "email" : "emails"}`}
      </button></span>
    </>
  );
}

/**
 * The linked deal, one quiet line under the name: the kind of trade as a tag, the deal's short name, and the facts Alex
 * replies with (side, the lot's energy, the ask, where it is). The whole line opens the deal in a new CRM tab.
 */
function DealLineView({ label, deal, onOpen }: { label: string; deal: RelayItem["deal"]; onOpen?: () => void }) {
  const line = dealLine(deal, label);
  return (
    <div className={w.dealLine}>
      <span className={w.typeBulk} title="A bulk trade we're brokering"><span className={w.typeDot} aria-hidden />{line.type}</span>
      {line.market && (
        <a className={w.typeMarket} href={line.market.url} target="_blank" rel="noopener noreferrer" title="Open the live listing on rebattery.io">
          <span className={w.typeDot} aria-hidden />{line.market.label}<ArrowUpRight size={12} aria-hidden />
        </a>
      )}
      <button type="button" className={w.dealOpen} onClick={onOpen} disabled={!onOpen} title={onOpen ? `Open the deal: ${deal?.summary ?? line.name}` : line.name}>
        <span className={w.dealName}>{line.name}</span>
        {(line.facts.length > 0 || line.closed) && <span className={w.dealFacts}>{[...line.facts, ...(line.closed ? ["closed"] : [])].join(" · ")}</span>}
        {onOpen && <ArrowUpRight size={14} aria-hidden className={w.dealGo} />}
      </button>
    </div>
  );
}
