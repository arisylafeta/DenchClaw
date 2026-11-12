"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { RelayItem } from "@/lib/relay";
import { NEEDS_AGENT } from "@/lib/relay-checks";
import { leadTitle, oldestLead, sortLanes, theirWords, waited, type SuggestAnswer, type SuggestView } from "@/lib/relay-lanes-core";
import type { LeadCards as LeadCardList, LeadCardView } from "@/lib/relay-lead";
import { assembleLead, leadChips } from "@/lib/relay-lead-core";
import type { Suggestions } from "@/lib/relay-suggest";
import { api, cx } from "./relay-ui";
import { JulesFlag } from "./relay-jules-flag";
import n from "./relay-lanes.module.css";

/**
 * The Relay inbox: new leads with their reply ready, replies on a deal, and everything else that needs a reply, each
 * lane a table of briefed rows (who, what they want and their own words, the deal, how long it has waited). Under each
 * row one box says how to answer; the ways Relay suggests only fill that box. Writing a draft moves the email to
 * Review. Nothing here sends an email.
 */

/** What a row can do to its email: the same actions the old table uses. */
export type LaneActions = {
  busy: Record<string, boolean>;
  gone: Record<string, boolean>;
  /** suggested: the note is one Relay suggested, so it gets the plain draft and never the job that looks things up. */
  draft: (item: RelayItem, note: string, suggested?: boolean) => Promise<unknown>;
  draftAsk: (item: RelayItem) => Promise<unknown>;
  done: (item: RelayItem) => Promise<unknown>;
  dealJob: (item: RelayItem, action: "create" | "update") => Promise<unknown>;
};
type Say = (text: string) => void;

/** The suggested answers, kept fresh while the lanes show. Asking is what gets waiting emails read, two at a time, so
 * the page asks every few seconds while any is still to read and once a minute otherwise. */
export function useSuggestions(on: boolean) {
  const [data, setData] = useState<Suggestions | null>(null);
  const reload = useCallback(async () => {
    try { setData(await api<Suggestions>("/api/relay/suggestions")); } catch { /* the rows work without suggested answers */ }
  }, []);
  const pending = (data?.pending ?? 0) > 0;
  useEffect(() => {
    if (!on) { setData(null); return; }
    void reload();
    const t = setInterval(() => { if (document.visibilityState === "visible") void reload(); }, pending ? 5000 : 60_000);
    // Back on the tab after a while away: the answers may be for an email that has since had a newer one.
    const back = () => { if (document.visibilityState === "visible") void reload(); };
    document.addEventListener("visibilitychange", back);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", back); };
  }, [on, pending, reload]);
  return { data, reload };
}

const sentence = (text: string) => text.replace(/^./, (c) => c.toUpperCase());

const PRIORITY: Record<string, string> = { urgent: "Urgent", overdue: "Overdue", high: "High", medium: "Medium", low: "Low" };
const dealWorking = (i: RelayItem) => !!i.deal_job && ["queued", "running", "ready", "finalising"].includes(i.deal_job.status);

/** The column names. Each lane repeats them, so a lane reads on its own. */
const Head = () => <div className={cx(n.grid, n.thead)} aria-hidden><span>From</span><span>What they want</span><span>Deal</span><span>Waiting</span><span>Priority</span></div>;

const Priority = ({ of }: { of: string }) => <span className={n.prio}><span className={cx(n.pr, n[of])}>{PRIORITY[of] ?? sentence(of)}</span></span>;

/** A few of their own words from the newest email, or of Alex's when the newest is his. */
function Words({ message }: { message: RelayItem["last_message"] | undefined }) {
  const words = theirWords(message?.text);
  if (!words) return null;
  return <div className={n.words}><span>{message?.direction === "outbound" ? "Your last email" : "In their words"}</span><q>{words}</q></div>;
}

/** How Alex wants to answer, in his words or starting from a way Relay suggests. Picking a way only fills the box: a
 * draft is written when he presses Write the draft. A way that needs something only he knows waits until he adds it. */
function AnswerBox({ item: i, view, queued, act, plain }: { item: RelayItem; view: SuggestView | undefined; queued: boolean; act: LaneActions; plain?: boolean }) {
  const [text, setText] = useState(i.note ?? "");
  const [base, setBase] = useState<{ text: string; fill: string | null } | null>(null);
  const [wide, setWide] = useState(!!(i.note ?? "").trim() || !!plain);
  const [ways, setWays] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const busy = !!act.busy[i.id];
  const name = i.counterpart_name || i.counterpart_email || "them";
  const answers = view?.status === "ready" ? view.answers : [];
  const unfilled = !!base?.fill && text.trim() === base.text.trim();
  const ready = !!text.trim() && !unfilled;
  // A way Relay suggested is words it wrote from the email, so it only ever gets the plain draft, never the job that looks things up.
  const write = () => { if (ready && !busy) void act.draft(i, text.trim(), !!base); };
  const pick = (a: SuggestAnswer) => {
    const next = a.fill ? `${a.note}\n${sentence(a.fill)}: ` : a.note;
    setText(next);
    setBase({ text: next, fill: a.fill });
    setWide(true);
    requestAnimationFrame(() => { const el = box.current; if (el) { el.focus(); el.setSelectionRange(next.length, next.length); } });
  };
  const save = () => {
    if (base || text === (i.note ?? "")) return;
    void api(`/api/relay/items/${i.id}`, { method: "PATCH", body: { note: text } }).catch(() => undefined);
  };
  const reading = view?.status === "preparing" || (!view && queued);

  return (
    <div className={n.answer}>
      <label htmlFor={`say-${i.id}`} className={cx(!wide && n.sr)}>{plain ? `Say how to answer ${firstOf(name)}` : "How do you want to answer?"}</label>
      <div className={n.say}>
        <textarea id={`say-${i.id}`} ref={box} rows={wide ? 3 : 1} value={text} disabled={busy}
          placeholder={wide ? "Say it in your own words. A few words is enough: Relay writes the email from them." : "How do you want to answer?"}
          onFocus={() => setWide(true)} onBlur={save}
          onChange={(e) => { setText(e.target.value); if (!e.target.value.trim()) setBase(null); }}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); write(); } }} />
        <div className={n.btns}>
          <button type="button" className={n.go} disabled={busy || !ready} onClick={write}>{busy ? "Drafting…" : "Write the draft"}</button>
          {!plain && <button type="button" className={n.ghost} disabled={busy} aria-label={`No reply needed for ${name}`} title="No reply needed: marks it read and labels it Sorted in Gmail" onClick={() => void act.done(i)}>No reply needed</button>}
        </div>
      </div>
      {unfilled && <span className={n.need}>Add {base?.fill} after the colon, then Write the draft.</span>}
      {!base && text.trim() && NEEDS_AGENT.test(text) && <span className={n.hint}>Relay will do the work first (research, lists, files), then draft. Takes a few minutes.</span>}
      {!plain && (
        <div className={n.links}>
          <button type="button" className={n.link} aria-expanded={ways} onClick={() => setWays(!ways)}>{ways ? "Hide ways to answer" : `Show ways to answer${answers.length ? ` · ${answers.length}` : ""}`}</button>
          {i.can_ask && <button type="button" className={n.link} disabled={busy} title="Drafts the playbook's ask for what the deal is still missing. You read it in Review and send." onClick={() => void act.draftAsk(i)}>Ask for what the deal is missing</button>}
        </div>
      )}
      {ways && (
        <div className={n.ways}>
          {answers.length ? (
            <>
              <span className={n.hint}>Start from one of these and change it. Picking one only fills the box. Nothing is written or sent.</span>
              {answers.map((a) => (
                <button key={a.label} type="button" className={cx(n.way, base?.text.startsWith(a.note) && n.on)} disabled={busy} onClick={() => pick(a)}>
                  <b>{a.label}</b><span>{a.note}{a.fill ? ` You add ${a.fill}.` : ""}</span>
                </button>
              ))}
            </>
          ) : <span className={n.hint} role="status">{reading ? "Relay is reading this email for ways to answer…" : view?.status === "none" && view.quiet ? "Relay thinks no reply is needed here." : "No ways to suggest for this one. Say it in your own words above."}</span>}
        </div>
      )}
    </div>
  );
}
const firstOf = (name: string) => name.split(/\s+/)[0];

/** A new lead: its card is ready to check, still being read, or could not be read. */
function LeadRow({ card, item, first, answers, act, onLead, reloadCards, say }: {
  card: LeadCardView; item: RelayItem | undefined; first: boolean; answers: Record<string, string>; act: LaneActions;
  onLead: (cardId: string) => void; reloadCards: () => Promise<void>; say: Say;
}) {
  const [own, setOwn] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const data = card.status === "ready" ? card.data : null;
  const choices = useMemo(() => (data ? assembleLead(data, card.state, answers).open.length : 0), [data, card.state, answers]);
  const named = leadTitle(data?.facts ?? [], card.headline || data?.summary || "New email");
  const role = data?.role === "broker" ? "Broker for the owner" : data?.role === "owner" ? "Owner" : null;
  const company = card.who.company && card.who.company !== card.who.name ? card.who.company : item?.counterpart_email ?? null;
  const retry = async () => {
    setRetrying(true);
    try { await api(`/api/relay/cards/${card.id}`, { method: "PATCH", body: { retry: true } }); say("Reading it again."); }
    catch (err) { say(err instanceof Error ? err.message : "Something went wrong. Try again."); }
    finally { setRetrying(false); void reloadCards(); }
  };

  return (
    <div className={cx(n.trow, data ? first && n.first : n.soft)}>
      <div className={n.grid}>
        <div className={n.from}>
          <b>{card.who.name}</b>
          {company && <span>{company}</span>}
          {role && <span>{role}</span>}
          <span className={cx(n.chip, n.hot)}>New lead{data ? ` · ${data.side}` : ""}</span>
        </div>
        <div className={n.what}>
          <b className={n.head}>{named.title}</b>
          {data ? data.summary && data.summary !== named.title && <p>{data.summary}</p>
            : <p>{card.status === "preparing" ? "Relay is reading this email and drafting the reply. About a minute." : card.error ?? "Relay couldn't read this email."}</p>}
          <Words message={item?.last_message} />
          {data && (
            <div className={n.chips}>
              <span className={cx(n.chip, n.ok)}>Reply ready</span>
              {choices > 0 && <span className={cx(n.chip, n.blue)}>{choices} {choices === 1 ? "choice" : "choices"} for you</span>}
              {item?.inbox && <span className={cx(n.chip, n.grey)}>to {item.inbox}@</span>}
              {leadChips(named.rest).slice(0, 2).map((fact) => <span key={fact} className={cx(n.chip, n.grey)}>{fact}</span>)}
              <JulesFlag jules={item?.jules} compact />
            </div>
          )}
        </div>
        <div className={n.dealc}>{card.deal_label ? <span className={cx(n.chip, n.ok)}>{card.deal_label}</span> : <span className={n.dim}>No deal yet</span>}</div>
        <span className={n.wait}>{waited(card.who.at) || "–"}</span>
        <Priority of="urgent" />
      </div>
      <div className={n.answer}>
        <div className={n.links}>
          {data && <button type="button" className={n.go} aria-label={`Review reply to ${card.who.name}`} onClick={() => onLead(card.id)}>Review reply →</button>}
          {card.status === "failed" && <button type="button" className={n.link} disabled={retrying} aria-label={`Try again: read the email from ${card.who.name}`} onClick={() => void retry()}>Try again</button>}
          {item && <button type="button" className={n.link} aria-expanded={own} aria-label={`Write it myself: reply to ${card.who.name}`} onClick={() => setOwn(!own)}>{own ? "Cancel" : "Write it myself"}</button>}
        </div>
      </div>
      {own && item && <AnswerBox item={item} view={undefined} queued={false} act={act} plain />}
    </div>
  );
}

/** An email that needs a reply: who, what they want in Relay's words and theirs, the deal, and the box to answer it. */
function ReplyRow({ item: i, view, queued, act, detail, onOpenListing }: {
  item: RelayItem; view: SuggestView | undefined; queued: boolean; act: LaneActions; detail: (item: RelayItem) => ReactNode; onOpenListing?: (id: string, title?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const busy = !!act.busy[i.id];
  const name = i.counterpart_name || i.counterpart_email || "Unknown";
  const company = i.company && i.company !== name ? i.company : i.counterpart_name ? i.counterpart_email : null;
  const late = i.priority === "overdue";

  return (
    <div className={n.trow}>
      <div className={n.grid}>
        <div className={n.from}>
          <b>{name}</b>
          {company && <span>{company}</span>}
          {(i.contact_type || i.inbox) && <span className={cx(n.chip, n.grey)}>{[i.contact_type && sentence(i.contact_type), i.inbox && `to ${i.inbox}@`].filter(Boolean).join(" · ")}</span>}
        </div>
        <div className={n.what}>
          <b className={n.head}>{i.headline}</b>
          {i.context && <p>{i.context}</p>}
          <Words message={i.last_message} />
          <JulesFlag jules={i.jules} />
          <button type="button" className={n.link} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide the full email" : "Read the full email"}</button>
        </div>
        <div className={n.dealc}>
          {i.bulk_listing_id
            ? <button type="button" className={n.deal} title={`Open deal: ${i.deal_label ?? ""}`} onClick={() => onOpenListing?.(i.bulk_listing_id!, i.deal_label ?? undefined)}><span>{i.deal_label || "Deal"}</span></button>
            : dealWorking(i) ? <span className={n.dim}>Matcha working…</span>
            : i.dismantler ? <span className={n.dim}>Dismantler · {i.dismantler.name}</span>
            : i.deal_action === "create"
              ? <button type="button" className={n.mkdeal} disabled={busy} title={`Matcha creates the deal from this ${i.inbox === "buy" ? "buyer" : i.inbox === "supply" ? "seller" : ""} email and fills the card`} onClick={() => void act.dealJob(i, "create")}>+ Create deal</button>
              : <span className={n.dim}>No deal linked</span>}
        </div>
        <span className={cx(n.wait, late && n.late)}>{waited(i.waiting_since ?? i.last_message?.at) || "–"}</span>
        <Priority of={i.priority} />
      </div>
      {open && <div className={n.detail}>{detail(i)}</div>}
      <AnswerBox item={i} view={view} queued={queued} act={act} />
    </div>
  );
}

/** Rows shown before "+ N more". */
const FIRST = 6;

export function Lanes({ items, counts, cards, cardsError, reloadCards, suggest, act, detail, say, onLead, onOpenListing, onGo }: {
  items: RelayItem[]; counts: { todos: number; follow: number; other: number };
  cards: LeadCardList | null; cardsError: string | null; reloadCards: () => Promise<void>;
  suggest: Suggestions | null; act: LaneActions; detail: (item: RelayItem) => ReactNode; say: Say;
  onLead: (cardId: string) => void; onOpenListing?: (id: string, title?: string) => void; onGo: (page: "todos" | "follow" | "other") => void;
}) {
  const [allDeals, setAllDeals] = useState(false);
  const [allReplies, setAllReplies] = useState(false);
  const waiting = useMemo(() => items.filter((i) => !act.gone[i.id]), [items, act.gone]);
  const lanes = useMemo(() => sortLanes(waiting, cards?.cards ?? []), [waiting, cards]);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const ready = lanes.leads.filter((c) => c.status === "ready").length;
  const oldest = oldestLead(lanes.leads);
  const pending = suggest?.pending ?? 0;
  const queued = useMemo(() => new Set(suggest?.queued ?? []), [suggest]);
  const suggested = (list: RelayItem[]) => list.filter((i) => suggest?.suggestions[i.id]?.status === "ready").length;
  const firstReady = lanes.leads.find((c) => c.status === "ready")?.id;

  const rows = (list: RelayItem[], all: boolean, showAll: () => void) => (
    <>
      {(all ? list : list.slice(0, FIRST)).map((i) => <ReplyRow key={i.id} item={i} view={suggest?.suggestions[i.id]} queued={queued.has(i.id)} act={act} detail={detail} onOpenListing={onOpenListing} />)}
      {!all && list.length > FIRST && <button type="button" className={n.more} onClick={showAll}>+ {list.length - FIRST} more</button>}
    </>
  );

  return (
    <div className={n.lanes}>
      <div className={n.stats}>
        <div className={n.stat}><b>{lanes.leads.length}</b><span>New leads · {ready} {ready === 1 ? "reply" : "replies"} ready</span></div>
        <div className={n.stat}><b>{lanes.deals.length}</b><span>Deal replies · on a deal you have</span></div>
        <div className={n.stat}><b>{lanes.replies.length}</b><span>Need a reply · {pending ? `reading ${pending} for ways to answer` : "ways to answer suggested"}</span></div>
        <div className={n.stat}><b className={cx(oldest?.late && n.late)}>{oldest?.waited ?? "–"}</b><span>Oldest lead waiting · goal 2 working hours</span></div>
      </div>

      <section className={n.lane} aria-label="New leads">
        <div className={n.lhead}>
          <h2>New leads <span>· reply drafted, yours to check</span></h2>
          {lanes.leads.length > 0 && <span className={n.badge}>URGENT · OLDEST FIRST</span>}
        </div>
        {cardsError && <p className={n.none} role="alert">{cardsError}</p>}
        {lanes.leads.length > 0 && <Head />}
        {lanes.leads.map((card) => <LeadRow key={card.id} card={card} item={byId.get(card.item_id)} first={card.id === firstReady} answers={cards?.answers ?? {}} act={act} onLead={onLead} reloadCards={reloadCards} say={say} />)}
        {!lanes.leads.length && !cardsError && <p className={n.none}>{cards ? "No new leads waiting. A first email from a new seller or buyer shows here with its reply ready." : "Loading the leads…"}</p>}
      </section>

      <section className={n.lane} aria-label="Deal replies">
        <div className={n.lhead}><h2>Deal replies <span>· on a deal you already have</span></h2></div>
        {lanes.deals.length > 0 && <Head />}
        {rows(lanes.deals, allDeals, () => setAllDeals(true))}
        {!lanes.deals.length && <p className={n.none}>No replies waiting on a deal.</p>}
      </section>

      <section className={n.lane} aria-label="Need a reply">
        <div className={n.lhead}><h2>Need a reply <span>· say how to answer, Relay writes it</span></h2></div>
        {lanes.replies.length > 0 && <Head />}
        {rows(lanes.replies, allReplies, () => setAllReplies(true))}
        {!lanes.replies.length && <p className={n.none}>Nothing else needs a reply.</p>}
        {lanes.replies.length > 0 && <p className={n.foot}>{suggested(lanes.replies)} of {lanes.replies.length} with ways to answer{pending ? ` · Relay is still reading ${pending}` : ""}. Every draft waits in Review for you to send.</p>}
      </section>

      <div className={n.tiles}>
        <button type="button" className={n.tile} onClick={() => onGo("todos")}><b>To-dos from email <span>· {counts.todos}</span></b><span>Things to do that are not a reply.</span></button>
        <button type="button" className={n.tile} onClick={() => onGo("follow")}><b>Follow-ups due <span>· {counts.follow}</span></b><span>No answer to your last email. Write a chase, or Don&apos;t chase.</span></button>
        <button type="button" className={n.tile} onClick={() => onGo("other")}><b>No reply needed <span>· {counts.other}</span></b><span>Thanks, receipts, pitches. Out of the way, one click back.</span></button>
      </div>
    </div>
  );
}
