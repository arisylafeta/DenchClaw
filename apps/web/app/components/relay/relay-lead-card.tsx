"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { assembleLead, cleanAnswer, cleanLeadState, leadChips, priceWarning, questionId, type LeadBlock, type LeadData, type LeadState } from "@/lib/relay-lead-core";
import type { LeadCards as LeadCardList, LeadCardView } from "@/lib/relay-lead";
import { undoSecondsLeft } from "@/lib/relay-send-time";
import { api, cx } from "./relay-ui";
import c from "./relay-lead-card.module.css";

/**
 * Relay lead cards: one prepared card per new seller or buyer email. The card shows what they sent, what the reply asks
 * for, and the reply itself, put together from fixed parts and Alex's own answers (`assembleLead`). A blue question is
 * something they asked that only Alex can answer; Send waits for it. Nothing here writes a sentence of its own, but for
 * "Add & polish", which has Relay write out the gist he typed and shows it in the reply for him to check.
 */

type Say = (text: string, undo?: () => void, action?: undefined, until?: number) => void;
type ReadyCard = LeadCardView & { data: LeadData };
type Sent = { cardId: string; draftId: string; name: string; until: number };

/** A card is one prepared email: a newer email from them is a new card under the same id, with none of the old choices. */
const cardKey = (card: LeadCardView) => `${card.id}:${card.message_id}`;
/** "Sun 18:26" this week, "Sun 8 Nov, 18:26" for anything older. */
function arrived(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const time = at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const recent = Date.now() - at.getTime() < 6 * 86_400_000;
  return recent ? `${at.toLocaleDateString("en-GB", { weekday: "short" })} ${time}` : `${at.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}, ${time}`;
}

/** The lead cards and Alex's saved answers, kept fresh while the switch is on. Asking is what gets new emails read, so
 * the page asks every few seconds while a card is being prepared and once a minute otherwise. */
export function useLeadCards(on: boolean) {
  const [data, setData] = useState<LeadCardList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setData(await api<LeadCardList>("/api/relay/cards"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load the lead cards.");
    }
  }, []);
  const preparing = !!data?.cards.some((x) => x.status === "preparing");
  useEffect(() => {
    if (!on) { setData(null); setError(null); return; }
    void reload();
    const t = setInterval(() => { if (document.visibilityState === "visible") void reload(); }, preparing ? 5000 : 60_000);
    return () => clearInterval(t);
  }, [on, preparing, reload]);
  return { data, error, reload };
}

// ---------------------------------------------------------------- one card

type QuestionProps = {
  block: Extract<LeadBlock, { kind: "question" }>;
  /** What the box starts with: the answer he is changing. */
  initial?: string;
  onAnswer: (text: string | null, remember: boolean, polished?: boolean) => void;
  /** His gist, written out in full in his style. Rejects with the reason when Relay can't. */
  onPolish: (gist: string) => Promise<string>;
};

/** A blue question: something they asked that only Alex can answer. He picks a wording, writes his own, or leaves it out.
 * "Add & polish" takes the gist he typed and puts it in the reply written out in full. */
function Question({ block, initial, onAnswer, onPolish }: QuestionProps) {
  const [writing, setWriting] = useState(!block.options.length || !!initial);
  const [own, setOwn] = useState(initial ?? "");
  const [remember, setRemember] = useState(block.remember);
  const [polishing, setPolishing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const typed = cleanAnswer(own);
  const polish = async () => {
    setPolishing(true);
    setProblem(null);
    try {
      const text = await onPolish(typed);
      if (mounted.current) onAnswer(text, remember && block.remember, true);
    } catch (err) {
      if (mounted.current) setProblem(err instanceof Error ? err.message : "Relay couldn't polish that. Your own words are still in the box.");
    } finally {
      if (mounted.current) setPolishing(false);
    }
  };
  return (
    <div className={c.q} role="group" aria-label={block.prompt}>
      <span className={c.qprompt}>{block.prompt}</span>
      <span className={c.qquote}>“{block.quote}”</span>
      <div className={c.opts}>
        {block.options.map((o) => (
          <button key={o.line} type="button" className={c.pill} title={o.line} disabled={polishing} onClick={() => onAnswer(o.line, remember && block.remember)}>{o.label}</button>
        ))}
        {!writing && <button type="button" className={cx(c.pill, c.quiet)} onClick={() => setWriting(true)}>Write my own</button>}
        <button type="button" className={cx(c.pill, c.quiet)} disabled={polishing} onClick={() => onAnswer(null, false)}>Leave it out</button>
      </div>
      {writing && (
        <>
          <textarea className={c.own} value={own} readOnly={polishing} onChange={(e) => { setOwn(e.target.value); setProblem(null); }} placeholder="Your answer as it should read, or just the gist of it" aria-label="Your answer" />
          <div className={c.opts}>
            <button type="button" className={c.use} disabled={!typed || polishing} onClick={() => onAnswer(typed, remember && block.remember)}>Use this</button>
            <button type="button" className={c.polish} disabled={typed.length < 3 || polishing} aria-busy={polishing}
              title="Relay writes your point out in full, in your style, and puts it in the reply. It adds nothing you didn't say. Check it before you send."
              onClick={() => void polish()}>{polishing ? "Polishing…" : "Add & polish"}</button>
          </div>
          {problem && <span className={c.warnline} role="alert">{problem}</span>}
        </>
      )}
      <div className={c.qnote}>
        {block.remember
          ? <><label><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />Remember this</label><span>{remember ? "Saved when you send. You won't be asked again." : "Used for this reply only."}</span></>
          : <span>Used for this reply only.</span>}
      </div>
    </div>
  );
}

export type LeadCardProps = {
  card: ReadyCard;
  answers: Record<string, string>;
  state: LeadState;
  onState: (next: LeadState) => void;
  onSend: () => void;
  onEdit: () => void;
  onSkip: () => void;
  onDismiss: () => void;
  busy?: boolean;
  /** Start with the email shown (used by the preview). */
  emailOpen?: boolean;
};

export function LeadCard({ card, answers, state, onState, onSend, onEdit, onSkip, onDismiss, busy, emailOpen }: LeadCardProps) {
  const { data, who } = card;
  const [showEmail, setShowEmail] = useState(!!emailOpen);
  const reply = useMemo(() => assembleLead(data, state, answers), [data, state, answers]);
  const chips = leadChips(data.facts);
  const price = priceWarning(reply, data);
  const name = data.firstName ?? who.name;

  const toggleAsk = (key: string) => onState({ ...state, off: state.off.includes(key) ? state.off.filter((k) => k !== key) : [...state.off, key] });
  // A polished answer comes back after a wait: it is added to the choices as they are then, not as they were on the click.
  const latest = useRef(state);
  latest.current = state;
  const answer = (id: string, text: string | null, remember: boolean, polished?: boolean) =>
    onState({ ...latest.current, picks: { ...latest.current.picks, [id]: { text, remember, ...(text && polished ? { polished: true } : {}) } } });
  /** The answer being changed, so the question opens with it in the box. */
  const [changing, setChanging] = useState<Record<string, string>>({});
  /** Back to the blue question, whether the line was a saved answer or one picked on this card. */
  const change = (id: string, text = "") => {
    const { [id]: _dropped, ...picks } = state.picks;
    setChanging((was) => ({ ...was, [id]: text }));
    onState({ ...state, picks, reopened: answers[id] ? [...new Set([...state.reopened, id])] : state.reopened });
  };
  const polish = (id: string, gist: string) =>
    api<{ text: string }>(`/api/relay/cards/${card.id}/polish`, { method: "POST", body: { question: id, text: gist } }).then((r) => r.text);
  const quoteOf = (id: string) => data.asked.find((a) => questionId(a) === id)?.quote ?? data.other.find((o) => o.id === id)?.quote ?? "";
  const leftOut = Object.entries(state.picks).filter(([, pick]) => !pick.text).map(([id]) => id);

  return (
    <article className={c.card} aria-label={`Lead from ${who.name}`}>
      <div className={c.head}>
        <div className={c.tagrow}>
          <span className={cx(c.tag, data.side === "buyer" && c.buyer)}>New {data.side} lead{data.deal ? " · deal linked" : ""}</span>
          <span className={c.from}>{who.name}{who.company && who.company !== who.name ? `, ${who.company}` : ""} · {arrived(who.at)}</span>
        </div>
        <h1 className={c.h1}>{card.headline}</h1>
        <div className={c.rows}>
          {chips.length > 0 && (
            <div className={c.row}>
              <span className={c.rowlabel}>We have</span>
              {chips.map((chip) => <span key={chip} className={c.have}>{chip}</span>)}
            </div>
          )}
          {reply.asks.length > 0 && (
            <div className={c.row}>
              <span className={c.rowlabel}>Reply asks</span>
              {reply.asks.map((a) => (a.on
                ? <span key={a.key} className={c.ask}>{a.label}<button type="button" onClick={() => toggleAsk(a.key)} aria-label={`Stop asking for ${a.label}`}>×</button></span>
                : <button key={a.key} type="button" className={c.askoff} onClick={() => toggleAsk(a.key)} aria-label={`Ask for ${a.label} again`}>+ {a.label}</button>))}
            </div>
          )}
        </div>
        <div className={c.coverrow}>
          <span className={cx(c.cover, reply.cover.tone === "warn" && c.warn)}>{reply.cover.text}</span>
          <button type="button" className={c.linkbtn} onClick={() => setShowEmail((v) => !v)} aria-expanded={showEmail}>{showEmail ? "Hide the email" : "See the email"}</button>
        </div>
      </div>

      {showEmail && (
        <div className={c.email}>
          <b>{data.email.subject || "(no subject)"}</b>
          {data.email.text.split(/\n{2,}/).map((part, i) => <p key={i}>{part.trim()}</p>)}
          {data.email.files.length > 0 && <span className={c.files}>{data.email.files.length} attached: {data.email.files.join(", ")}</span>}
        </div>
      )}

      <div className={c.reply}>
        <span className={c.label}>Your reply · from {card.identity ?? "alex"}@</span>
        <span className={c.to}>To {who.email}{card.cc.length > 0 && <> · <b>Cc {card.cc.join(", ")}</b></>}</span>
        {reply.blocks.map((block, i) => {
          if (block.kind === "question") return <Question key={block.id} block={block} initial={changing[block.id]} onAnswer={(text, remember, polished) => answer(block.id, text, remember, polished)} onPolish={(gist) => polish(block.id, gist)} />;
          if (block.kind === "asks") return <div key={`asks-${i}`}><p>{block.intro}</p>{block.bullets.length > 0 && <ul>{block.bullets.map((b) => <li key={b}>{b}</li>)}</ul>}</div>;
          const own = block.spans.filter((span) => span.answer);
          return (
            <div key={`para-${i}`} style={{ display: "contents" }}>
              <p>{block.spans.map((span) => span.text).join(" ")}</p>
              {own.map((span) => {
                const pick = state.picks[span.answer!.id];
                return (
                  <span key={span.answer!.id} className={c.note}>
                    {span.answer!.saved ? "Using your saved answer" : `${pick?.polished ? "Polished from your words" : "Your answer"} · ${pick?.remember ? "saved when you send" : "this reply only"}`}
                    <span aria-hidden>·</span>
                    <button type="button" onClick={() => change(span.answer!.id, span.text)}>Change</button>
                  </span>
                );
              })}
            </div>
          );
        })}
        {leftOut.map((id) => (
          <span key={id} className={c.note} style={{ marginTop: 0 }}>
            Left out: “{quoteOf(id)}”
            <span aria-hidden>·</span>
            <button type="button" onClick={() => change(id)}>Answer it</button>
          </span>
        ))}
        {price && <span className={c.warnline}>! {price}</span>}
      </div>

      <div className={c.actions}>
        <div className={c.left}>
          <button type="button" className={c.ghost} onClick={onEdit} disabled={busy}>Edit <kbd>E</kbd></button>
          <button type="button" className={c.ghost} onClick={onSkip} disabled={busy}>Skip <kbd>→</kbd></button>
          <button type="button" className={c.ghost} onClick={onDismiss} disabled={busy}>Not a lead</button>
        </div>
        <button type="button" className={c.send} onClick={onSend} disabled={busy || reply.open.length > 0}>
          {reply.open.length > 1 ? "Answer the blue questions to send" : reply.open.length ? "Answer the blue question to send" : busy ? "Sending…" : `Send to ${name}${card.cc.length ? ` +${card.cc.length} on copy` : ""}  ↵`}
        </button>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------- the page

/** After Send: the email is held for the undo window, then goes. Relay reports the outcome in the toast either way. */
function SentPanel({ sent, next, onNext, onUndo }: { sent: Sent; next: string | null; onNext: () => void; onUndo: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);
  const left = undoSecondsLeft(new Date(sent.until));
  return (
    <div className={c.panel} role="status">
      <h2>{left > 0 ? `Sending to ${sent.name} in ${left} s.` : `On its way to ${sent.name}.`}</h2>
      <p>Relay tells you when it has gone. A reply from them comes back to your inbox; if they stay quiet, the thread moves to Follow up.</p>
      <div className={c.btns}>
        <button type="button" className={c.next} onClick={onNext}>{next ? `Next lead: ${next} →` : "Back to the inbox →"}</button>
        {left > 0 && <button type="button" className={c.plainbtn} onClick={onUndo}>Undo ({left} s)</button>}
      </div>
    </div>
  );
}

export function LeadCards({ data, error, reload, say, start, onInbox, onReview, onQueued, onUndone }: {
  data: LeadCardList | null; error: string | null; reload: () => Promise<void>; say: Say; onInbox: () => void; onReview: () => void;
  /** The card to open first: the one whose row was clicked in the inbox. */
  start?: string | null;
  /** A card's reply is held for sending: the page watches it and reports the outcome. */
  onQueued: (draftId: string, toLabel: string) => void | Promise<void>;
  onUndone: (draftId: string) => void;
}) {
  const [at, setAt] = useState<string | null>(start ?? null);
  const [edits, setEdits] = useState<Record<string, LeadState>>({});
  const [sent, setSent] = useState<Sent | null>(null);
  const [busy, setBusy] = useState(false);
  const saves = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const work = useMemo(() => (data?.cards ?? []).filter((x) => x.status !== "preparing"), [data]);
  const reading = (data?.cards.length ?? 0) - work.length;
  const current = work.find((x) => x.id === at) ?? work[0] ?? null;
  const index = current ? work.indexOf(current) : -1;
  const ready = current?.status === "ready" && current.data ? (current as ReadyCard) : null;
  const state = ready ? edits[cardKey(ready)] ?? ready.state : null;
  const label = (card: LeadCardView) => card.who.company || card.who.name;

  // Choices show at once and are saved a moment later, so a reload finds the card as Alex left it.
  const setState = (card: ReadyCard, next: LeadState) => {
    setEdits((m) => ({ ...m, [cardKey(card)]: next }));
    clearTimeout(saves.current[card.id]);
    saves.current[card.id] = setTimeout(() => void api(`/api/relay/cards/${card.id}`, { method: "PATCH", body: { state: next } }).catch(() => undefined), 400);
  };
  const skip = useCallback(() => {
    if (!current || work.length < 2) return;
    void api(`/api/relay/cards/${current.id}`, { method: "PATCH", body: { skip: true } }).catch(() => undefined);
    setAt(work[(index + 1) % work.length].id);
  }, [current, work, index]);

  const send = useCallback(async (mode: "send" | "edit") => {
    if (!ready || !state || !data || busy || sent) return;
    const clean = cleanLeadState(state, ready.data);
    const reply = assembleLead(ready.data, clean, data.answers);
    if (mode === "send" && reply.open.length) return;
    clearTimeout(saves.current[ready.id]);
    const name = ready.data.firstName ?? ready.who.name;
    setBusy(true);
    try {
      const held = await api<{ draft_id: string; send_at: string | null; undo_seconds: number }>(`/api/relay/cards/${ready.id}/send`, { method: "POST", body: { confirm: true, state: clean, body: reply.body, mode } });
      if (mode === "edit") {
        say(`The reply to ${name} is a draft in Review.`);
        onReview();
      } else {
        // The hold runs from the server's send time, never past the window as this clock counts it.
        const until = Math.min(Date.now() + held.undo_seconds * 1000, held.send_at ? Date.parse(held.send_at) || Infinity : Infinity);
        setSent({ cardId: ready.id, draftId: held.draft_id, name, until });
        await onQueued(held.draft_id, name);
      }
    } catch (err) {
      say(`Not sent: ${err instanceof Error ? err.message : "something went wrong"}`);
    } finally {
      setBusy(false);
      void reload();
    }
  }, [ready, state, data, busy, sent, say, onReview, onQueued, reload]);

  const undo = useCallback(async (s: Sent) => {
    try {
      await api(`/api/relay/cards/${s.cardId}/undo`, { method: "POST" });
      onUndone(s.draftId);
      setSent((now) => (now?.cardId === s.cardId ? null : now));
      setAt(s.cardId);
      say(`Stopped. The reply to ${s.name} is back on its card.`);
    } catch (err) {
      say(err instanceof Error ? err.message : "Couldn't stop it.");
    }
    void reload();
  }, [onUndone, say, reload]);

  // Moving on inside the undo window keeps Undo within reach, in the toast.
  const next = () => {
    if (!sent) return;
    if (sent.until > Date.now()) say(`Sending to ${sent.name}`, () => void undo(sent), undefined, sent.until);
    setSent(null);
    if (!work.length) onInbox();
  };

  const act = async (card: LeadCardView, body: { dismiss: true } | { retry: true }, done: string) => {
    setBusy(true);
    try {
      await api(`/api/relay/cards/${card.id}`, { method: "PATCH", body });
      say(done);
    } catch (err) {
      say(err instanceof Error ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
      void reload();
    }
  };

  // Enter sends, E edits, → skips: only when Alex is not typing or on a button of his own.
  useEffect(() => {
    if (!ready || sent) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || e.repeat) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(el.tagName))) return;
      if (e.key === "Enter") { e.preventDefault(); void send("send"); }
      else if (e.key.toLowerCase() === "e") { e.preventDefault(); void send("edit"); }
      else if (e.key === "ArrowRight") { e.preventDefault(); skip(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ready, sent, send, skip]);

  return (
    <div className={c.lead}>
      <div className={c.toprow}>
        <button type="button" className={c.back} onClick={onInbox}>← Inbox</button>
        {!sent && current && (
          <div className={c.progress} aria-label={`Lead ${index + 1} of ${work.length}`}>
            {work.length <= 10 && work.map((x, i) => <i key={x.id} className={cx(i === index && c.on)} />)}
            <span>Lead {index + 1} of {work.length}</span>
          </div>
        )}
      </div>

      {error && <p className={c.warnline} role="alert">{error}</p>}
      {sent ? (
        <SentPanel sent={sent} next={work[0] ? label(work[0]) : null} onNext={next} onUndo={() => void undo(sent)} />
      ) : ready && state ? (
        <LeadCard key={cardKey(ready)} card={ready} answers={data?.answers ?? {}} state={state} busy={busy} onState={(nextState) => setState(ready, nextState)}
          onSend={() => void send("send")} onEdit={() => void send("edit")} onSkip={skip}
          onDismiss={() => void act(ready, { dismiss: true }, "Card removed. The email is still in your inbox.")} />
      ) : current ? (
        <div className={c.panel}>
          <div className={c.tagrow}><span className={cx(c.tag, c.plain)}>Not read</span><span className={c.from}>{current.who.name}{current.who.company ? `, ${current.who.company}` : ""}</span></div>
          <h2>{current.headline || "Relay couldn't read this email"}</h2>
          <p>{current.error ?? "Relay couldn't read this email. Try again."}</p>
          <div className={c.btns}>
            <button type="button" className={c.next} disabled={busy} onClick={() => void act(current, { retry: true }, "Reading it again.")}>Try again</button>
            {work.length > 1 && <button type="button" className={c.plainbtn} onClick={skip}>Skip</button>}
            <button type="button" className={c.plainbtn} disabled={busy} onClick={() => void act(current, { dismiss: true }, "Card removed. The email is still in your inbox.")}>Not a lead</button>
          </div>
        </div>
      ) : (
        <div className={c.panel} role="status">
          <h2>{!data && !error ? "Loading the lead cards…" : reading ? `Relay is reading ${reading} new ${reading === 1 ? "email" : "emails"}.` : "No new leads waiting."}</h2>
          <p>{reading ? "Each one shows here as a card as soon as it is ready." : "A first email from a new seller or buyer shows here as a card, with the reply ready to send."}</p>
          <div className={c.btns}><button type="button" className={c.plainbtn} onClick={onInbox}>Back to the inbox</button></div>
        </div>
      )}
      {reading > 0 && current && !sent && <span className={c.reading} role="status">Relay is reading {reading} more {reading === 1 ? "email" : "emails"}.</span>}
    </div>
  );
}
