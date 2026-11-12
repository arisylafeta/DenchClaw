"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { RelayItem } from "@/lib/relay";
import { leadIsLate, leadTitle, oldestLead, sortLanes, waited, type SuggestAnswer, type SuggestView } from "@/lib/relay-lanes-core";
import type { LeadCards as LeadCardList, LeadCardView } from "@/lib/relay-lead";
import { assembleLead, leadChips } from "@/lib/relay-lead-core";
import type { Suggestions } from "@/lib/relay-suggest";
import { api, colour, cx, initials } from "./relay-ui";
import { JulesFlag } from "./relay-jules-flag";
import n from "./relay-lanes.module.css";

/**
 * The Relay inbox as lanes: new leads with their reply ready, replies on a deal, and everything else that needs a reply,
 * each with the answers Alex is most likely to give. One click on an answer and Relay drafts it into Review; an answer
 * that needs something only Alex knows asks him for it first. Nothing here sends an email.
 */

/** What a row can do to its email: the same actions the old table uses. */
export type LaneActions = {
  busy: Record<string, boolean>;
  gone: Record<string, boolean>;
  /** suggested: the note is one Relay suggested, so it gets the plain draft and never the job that looks things up. */
  draft: (item: RelayItem, note: string, suggested?: boolean) => Promise<unknown>;
  draftAsk: (item: RelayItem) => Promise<unknown>;
  done: (item: RelayItem) => Promise<unknown>;
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

const who = (name: string, company: string | null) => (company && company !== name ? `${name}, ${company}` : name);
const sentence = (text: string) => text.replace(/^./, (c) => c.toUpperCase());

/** Alex's own words for a reply (no base), a suggested answer shown for him to check (a base, no fill), or one that
 * still needs something only he knows (a base and a fill). */
type Own = { text: string; base: string; fill: string | null };

function OwnWords({ id, own, busy, onChange, onDraft, onCancel }: { id: string; own: Own; busy: boolean; onChange: (text: string) => void; onDraft: () => void; onCancel: () => void }) {
  // A suggested answer that needs something from Alex is not drafted until he has added it.
  const ready = !!own.text.trim() && (!own.fill || own.text.trim() !== own.base.trim());
  return (
    <div className={n.own}>
      <label htmlFor={id}>{own.fill ? `Add ${own.fill}. Relay writes the reply around it.` : own.base ? "This is what Relay will be told to say. Check it, change it if you like." : "Say it in your words. Relay writes the reply."}</label>
      <textarea id={id} value={own.text} rows={3}
        ref={(el) => { if (el && !el.dataset.placed) { el.dataset.placed = "1"; el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && ready && !busy) { e.preventDefault(); onDraft(); } }} />
      <div className={n.ownbtns}>
        <button type="button" className={n.go} disabled={busy || !ready} onClick={onDraft}>{busy ? "Drafting…" : "Draft reply →"}</button>
        <button type="button" className={n.link} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/** A new lead: its card is ready to check, still being read, or could not be read. */
function LeadRow({ card, item, first, answers, act, onLead, reloadCards, say }: {
  card: LeadCardView; item: RelayItem | undefined; first: boolean; answers: Record<string, string>; act: LaneActions;
  onLead: (cardId: string) => void; reloadCards: () => Promise<void>; say: Say;
}) {
  const [own, setOwn] = useState<Own | null>(null);
  const [retrying, setRetrying] = useState(false);
  const data = card.status === "ready" ? card.data : null;
  const choices = useMemo(() => (data ? assembleLead(data, card.state, answers).open.length : 0), [data, card.state, answers]);
  const busy = !!(item && act.busy[item.id]);
  const named = leadTitle(data?.facts ?? [], card.headline || data?.summary || "New email");
  const role = data?.role === "broker" ? "broker for the owner" : data?.role === "owner" ? "owner" : null;
  const sub = [who(card.who.name, card.who.company), role, item?.inbox ? `to ${item.inbox}@` : null].filter(Boolean).join(" · ");
  // Past two working hours without an answer: the age shows in red (and the lane already put it on top).
  const late = leadIsLate(card.who.at);
  const age = waited(card.who.at);
  const retry = async () => {
    setRetrying(true);
    try { await api(`/api/relay/cards/${card.id}`, { method: "PATCH", body: { retry: true } }); say("Reading it again."); }
    catch (err) { say(err instanceof Error ? err.message : "Something went wrong. Try again."); }
    finally { setRetrying(false); void reloadCards(); }
  };
  const myself = item && <button type="button" className={n.link} aria-expanded={!!own} aria-label={`Write it myself: reply to ${card.who.name}`} onClick={() => setOwn(own ? null : { text: item.note ?? "", base: "", fill: null })}>Write it myself</button>;

  return (
    <div className={cx(n.row, data ? first && n.first : n.soft)}>
      <div className={n.line}>
        <div className={cx(n.av, !data && n.grey)} style={data ? { background: colour(card.who.name) } : undefined} aria-hidden>{initials(card.who.name)}</div>
        <div className={n.body}>
          <div className={n.title}>{named.title}</div>
          <div className={n.sub}>{sub}{age && <>{sub ? " · " : ""}<span className={cx(late && n.ageLate)} title={late ? "Waiting over 2 working hours (Monday to Friday, 9 to 6 London)" : undefined}>{age} ago</span></>}</div>
          <div className={n.chips}>
            {data ? (
              <>
                <span className={cx(n.chip, n.hot)}>New lead · {data.side}</span>
                <span className={cx(n.chip, n.ok)}>Reply ready</span>
                {choices > 0 && <span className={cx(n.chip, n.blue)}>{choices} {choices === 1 ? "choice" : "choices"} for you</span>}
                {card.deal_label && <span className={cx(n.chip, n.ok)}>Deal linked</span>}
                {leadChips(named.rest).slice(0, 2).map((fact) => <span key={fact} className={cx(n.chip, n.grey)}>{fact}</span>)}
                <JulesFlag jules={item?.jules} compact />
              </>
            ) : card.status === "preparing" ? <span className={cx(n.chip, n.grey)}>Relay is reading this email and drafting the reply</span>
              : <span className={cx(n.chip, n.amber)}>{card.error ?? "Relay couldn't read this email"}</span>}
          </div>
        </div>
        <div className={n.side}>
          {data ? <button type="button" className={n.go} aria-label={`Review reply to ${card.who.name}`} onClick={() => onLead(card.id)}>Review reply →</button>
            : card.status === "preparing" ? <><span>About a minute</span>{myself}</>
            : <><button type="button" className={n.link} disabled={retrying} aria-label={`Try again: read the email from ${card.who.name}`} onClick={() => void retry()}>Try again</button>{myself}</>}
        </div>
      </div>
      {own && item && <OwnWords id={`own-${item.id}`} own={own} busy={busy} onChange={(text) => setOwn({ ...own, text })} onCancel={() => setOwn(null)} onDraft={() => void act.draft(item, own.text.trim())} />}
    </div>
  );
}

/** An email that needs a reply: what it is, the answers to pick from, and the email itself one click away. */
function ReplyRow({ item: i, view, queued, act, detail, onOpenListing }: {
  item: RelayItem; view: SuggestView | undefined; queued: boolean; act: LaneActions; detail: (item: RelayItem) => ReactNode; onOpenListing?: (id: string, title?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [own, setOwn] = useState<Own | null>(null);
  const busy = !!act.busy[i.id];
  const name = i.counterpart_name || i.counterpart_email || "Unknown";
  const hot = i.priority === "urgent" || i.priority === "overdue";
  const wait = waited(i.waiting_since ?? i.last_message?.at);
  const meta = [hot ? sentence(i.priority) : i.contact_type ? sentence(i.contact_type) : null, wait].filter(Boolean).join(" · ");
  const answers = view?.status === "ready" ? view.answers : [];
  const fromAnswer = !!own?.base;
  const pick = (a: SuggestAnswer) => {
    // One click drafts a plain answer. One that carries a number from the email, or needs something only Alex knows,
    // shows what Relay will be told to say first, so nothing with a figure in it is drafted unseen.
    if (!a.fill && !/\d/.test(a.note)) { setOwn(null); void act.draft(i, a.note, true); return; }
    const base = a.fill ? `${a.note}\n${sentence(a.fill)}: ` : a.note;
    setOwn(own?.base === base ? null : { text: base, base, fill: a.fill });
  };

  return (
    <div className={n.row}>
      <div className={n.top}>
        <button type="button" className={n.open} aria-expanded={open} title={open ? "Hide the email" : "Read the email"} onClick={() => setOpen(!open)}>
          {i.headline} <span>· {who(name, i.company)}</span>
        </button>
        <span className={cx(n.meta, hot && n.hot)}>{meta}</span>
      </div>
      {i.bulk_listing_id && (
        <button type="button" className={n.deal} title={`Open deal: ${i.deal_label ?? ""}`} onClick={() => onOpenListing?.(i.bulk_listing_id!, i.deal_label ?? undefined)}>
          <span>{i.deal_label || "Deal"}</span>
        </button>
      )}
      <JulesFlag jules={i.jules} />
      {view?.status === "ready" && view.ask && <div className={n.sub}>{view.ask}</div>}
      <div className={n.pills}>
        {i.can_ask && <button type="button" className={n.pill} disabled={busy} title="Drafts the playbook's ask for what the deal is still missing. You read it in Review and send." onClick={() => void act.draftAsk(i)}>Ask for what the deal is missing</button>}
        {answers.map((a) => (
          <button key={a.label} type="button" className={cx(n.pill, fromAnswer && own?.base.startsWith(a.note) && n.on)} disabled={busy} title={a.note} onClick={() => pick(a)}>{a.label}{a.fill || /\d/.test(a.note) ? " …" : ""}</button>
        ))}
        {view?.status === "preparing" ? <span className={n.reading} role="status">Relay is reading this email…</span>
          : !view && queued ? <span className={n.reading}>Answers on the way…</span>
          : view?.status === "none" ? <span className={n.reading}>{view.quiet ? "Looks like no reply is needed." : "No answers to suggest for this one."}</span> : null}
        <button type="button" className={cx(n.pill, n.else, own && !fromAnswer && n.on)} disabled={busy} aria-expanded={!!own && !fromAnswer} aria-label={`Something else: reply to ${name} in your words`} onClick={() => setOwn(own && !fromAnswer ? null : { text: i.note ?? "", base: "", fill: null })}>Something else…</button>
        <button type="button" className={n.quiet} disabled={busy} aria-label={`No reply needed for ${name}`} title="No reply needed: marks it read and labels it Sorted in Gmail" onClick={() => void act.done(i)}>No reply needed</button>
      </div>
      {own && <OwnWords key={own.base} id={`own-${i.id}`} own={own} busy={busy} onChange={(text) => setOwn({ ...own, text })} onCancel={() => setOwn(null)} onDraft={() => void act.draft(i, own.text.trim(), fromAnswer)} />}
      {open && <div className={n.detail}>{detail(i)}</div>}
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
        <div className={n.stat}><b>{lanes.replies.length}</b><span>Need a reply · {pending ? `reading ${pending} for answers` : "answers suggested"}</span></div>
        <div className={n.stat}><b className={cx(oldest?.late && n.late)}>{oldest?.waited ?? "–"}</b><span>Oldest lead waiting · goal 2 working hours</span></div>
      </div>

      <section className={n.lane} aria-label="New leads">
        <div className={n.lhead}>
          <h2>New leads <span>· reply drafted, yours to check</span></h2>
          {lanes.leads.length > 0 && <span className={n.badge}>URGENT · OLDEST FIRST</span>}
        </div>
        {cardsError && <p className={n.none} role="alert">{cardsError}</p>}
        {lanes.leads.map((card) => <LeadRow key={card.id} card={card} item={byId.get(card.item_id)} first={card.id === firstReady} answers={cards?.answers ?? {}} act={act} onLead={onLead} reloadCards={reloadCards} say={say} />)}
        {!lanes.leads.length && !cardsError && <p className={n.none}>{cards ? "No new leads waiting. A first email from a new seller or buyer shows here with its reply ready." : "Loading the leads…"}</p>}
      </section>

      <section className={n.lane} aria-label="Deal replies">
        <div className={n.lhead}><h2>Deal replies <span>· on a deal you already have</span></h2></div>
        {rows(lanes.deals, allDeals, () => setAllDeals(true))}
        {!lanes.deals.length && <p className={n.none}>No replies waiting on a deal.</p>}
      </section>

      <section className={n.lane} aria-label="Need a reply">
        <div className={n.lhead}><h2>Need a reply <span>· pick what to say, Relay writes it</span></h2></div>
        {rows(lanes.replies, allReplies, () => setAllReplies(true))}
        {!lanes.replies.length && <p className={n.none}>Nothing else needs a reply.</p>}
        {lanes.replies.length > 0 && <p className={n.foot}>{suggested(lanes.replies)} of {lanes.replies.length} with suggested answers{pending ? ` · Relay is still reading ${pending}` : ""}. Every draft waits in Review for you to send.</p>}
      </section>

      <div className={n.tiles}>
        <button type="button" className={n.tile} onClick={() => onGo("todos")}><b>To-dos from email <span>· {counts.todos}</span></b><span>Things to do that are not a reply.</span></button>
        <button type="button" className={n.tile} onClick={() => onGo("follow")}><b>Follow-ups due <span>· {counts.follow}</span></b><span>No answer to your last email. Write a chase, or Don&apos;t chase.</span></button>
        <button type="button" className={n.tile} onClick={() => onGo("other")}><b>No reply needed <span>· {counts.other}</span></b><span>Thanks, receipts, pitches. Out of the way, one click back.</span></button>
      </div>
    </div>
  );
}
