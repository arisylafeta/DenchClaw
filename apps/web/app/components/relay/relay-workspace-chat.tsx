"use client";

import { useEffect, useRef, useState, type RefObject, type SetStateAction } from "react";
import { ArrowUp } from "lucide-react";
import type { TalkApplied, TalkDraft, TalkState, TalkTurn, TraceApplied } from "@/lib/relay-talk";
import { ThinkingIndicator } from "@/app/components/chat-native/thinking";
import { cx, firstOf } from "./relay-ui";
import w from "./relay-workspace.module.css";

type Quick = { followUp: () => void; style: () => void; reprice: () => void; deal: (() => void) | null };
const NUMBER = ["", "one", "two", "three", "four", "five", "six"];
const isTrace = (t: TalkTurn): t is TalkTurn & { applied: TraceApplied | null } => t.role === "trace";
const short = (text: string, max = 24) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/**
 * Relay's chat about this email, full height on the right: what Relay read before Alex opened it, the turns (his
 * bubbles, Relay's prose, the work as one quiet line each) and the composer pill with which email he means.
 */
export function RelayChat({ talk, name, drafts, current, all, onTarget, pending, error, onRetry, text, setText, onAsk, composer, firstNote, repricing, quick, saveRule }: {
  talk: TalkState | null; name: string; drafts: TalkDraft[]; current: TalkDraft | null; all: boolean; onTarget: (id: string) => void;
  pending: { text: string; started: number; first: boolean } | null; error: { text: string; message: string } | null; onRetry: () => void;
  text: string; setText: (next: SetStateAction<string>) => void; onAsk: (text: string) => void; composer: RefObject<HTMLTextAreaElement | null>;
  firstNote: string; repricing: boolean; quick: Quick; saveRule: (rule: string) => Promise<boolean>;
}) {
  const live = drafts.filter((d) => d.mail);
  const first = firstOf(name);
  const count = NUMBER[live.length] ?? String(live.length);
  const target = !live.length ? `${first}’s email` : all ? (live.length === 2 ? "both emails" : `all ${count} emails`) : current?.role === "primary" ? `your reply to ${first}` : current ? `the email “${current.title}”` : `${first}’s email`;
  const turns = talk?.turns ?? [];
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; }, [turns.length, !!pending, !!error]);

  // The newest rule Relay offered, until Alex saves it or says not now.
  const [ruleDone, setRuleDone] = useState<Record<string, "saved" | "skipped">>({});
  const offer = turns.toReversed().find((t) => t.role === "relay" && (t.applied as TalkApplied | null)?.ruleOffer);
  const rule = offer ? (offer.applied as TalkApplied).ruleOffer : null;
  const ruleState = offer ? ruleDone[offer.id] : undefined;

  const showNote = !!firstNote.trim() && !turns.some((t) => t.role === "alex" && t.text.trim() === firstNote.trim());
  const placeholder = !live.length ? `Say how to answer ${first}, like “offer the 62 kWh, and say we can get the mileage from the VIN”`
    : all ? `Change ${live.length === 2 ? "both" : `all ${count}`} at once, like “sign off as Alex and the team”`
    : `Change ${target}, or ask for another email: “also email Broekhuis”, “price the 62 kWh at 5k”`;
  const submit = () => { if (text.trim() && !pending) onAsk(text); };

  return (
    <aside className={w.chat} aria-label="Talk to Relay">
      <div className={w.chatScroll} ref={scroller}>
        <span className={w.chatHead}>Relay <span>on {target}</span></span>
        {talk && talk.read.items.length > 0 && <ReadLine read={talk.read} />}
        {showNote && <Mine text={firstNote} />}
        {turns.map((t) => (t.role === "alex" ? <Mine key={t.id} text={t.text} /> : isTrace(t) ? <Trace key={t.id} turn={t} /> : <RelaySays key={t.id} turn={t} />))}
        {pending && (
          <>
            <Mine text={pending.text} />
            <Working started={pending.started} first={pending.first} />
          </>
        )}
        {error && (
          <div className={w.chatError} role="alert">
            <span>That didn't go through: {error.message}</span>
            <button type="button" className={w.linkbtn} onClick={onRetry}>Try again</button>
          </div>
        )}
        {!turns.length && !pending && !showNote && !error && talk && (
          <p className={w.chatEmpty}>{live.length ? "Ask for any change, or another email to go with the reply." : `Tell Relay how to answer ${first}. It has read the thread and their history first.`}</p>
        )}
      </div>

      <div className={w.dockWrap}>
        <div className={cx(w.pill, rule && !ruleState && w.asking)}>
          {rule && !ruleState && offer && (
            <div className={w.dock}>
              <span>{rule.why ? `${rule.why}. ` : ""}Save a rule: <b>{rule.text}</b>?</span>
              <span className={w.dockBtns}>
                <button type="button" className={w.save} onClick={async () => { if (await saveRule(rule.text)) setRuleDone((m) => ({ ...m, [offer.id]: "saved" })); }}>Save rule</button>
                <button type="button" className={w.qchip} onClick={() => setRuleDone((m) => ({ ...m, [offer.id]: "skipped" }))}>Not now</button>
              </span>
            </div>
          )}
          {ruleState === "saved" && <span className={w.dockDone}>Saved to Rules. New drafts follow it from now on.</span>}
          {live.length > 1 && (
            <div className={w.targets} role="group" aria-label="Which email">
              {live.map((d) => (
                <button key={d.id} type="button" className={w.target} aria-pressed={!all && current?.id === d.id} onClick={() => onTarget(d.id)}>
                  {d.role === "primary" ? "Reply" : short(d.title, 20)}
                </button>
              ))}
              <button type="button" className={w.target} aria-pressed={all} onClick={() => onTarget("all")}>{live.length === 2 ? "Both" : `All ${count}`}</button>
            </div>
          )}
          <label htmlFor="relay-say" className={w.sr}>What do you want to say, or change?</label>
          <textarea id="relay-say" ref={composer} rows={3} className={w.say} value={text} placeholder={placeholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />
          <div className={w.chips}>
            {live.length > 0 && <button type="button" className={cx(w.qchip, live.length === 1 && w.lead)} onClick={quick.followUp}>Add a follow-up email</button>}
            {live.length > 0 && <button type="button" className={w.qchip} onClick={quick.style}>Change the style</button>}
            {live.length > 0 && <button type="button" className={w.qchip} disabled={repricing} onClick={quick.reprice}>{repricing ? "Re-pricing…" : "Re-price"}</button>}
            {quick.deal && <button type="button" className={w.qchip} onClick={quick.deal}>Create the deal</button>}
            <button type="button" className={w.go} aria-label="Ask Relay" disabled={!text.trim() || !!pending} onClick={submit}><ArrowUp size={15} aria-hidden /></button>
          </div>
        </div>
      </div>
    </aside>
  );
}

function Mine({ text }: { text: string }) {
  return <div className={w.me}><span>{text}</span></div>;
}

/** Relay's answer as plain prose, no bubble. A change it refused to save reads in the error tone. */
function RelaySays({ turn }: { turn: TalkTurn }) {
  const applied = turn.applied as TalkApplied | null;
  const notes = [
    applied?.guard,
    applied?.todo && `Added a to-do: ${applied.todo.title}.`,
    applied?.research && (applied.research.started ? `Looking into it: ${applied.research.ask}` : `Couldn't start the research: ${applied.research.why ?? "try again"}`),
  ].filter((n): n is string => !!n);
  return (
    <div className={w.relayTurn}>
      <div className={cx("chat-prose chat-message-font", w.prose)}>
        {turn.text.split(/\n{2,}/).map((p, k) => <p key={k} className={cx(p.startsWith("I didn't save ") && w.blocked)}>{p}</p>)}
      </div>
      {notes.map((n, k) => <span key={k} className={w.relayNote}>{n}</span>)}
    </div>
  );
}

/** The quiet work line: what Relay read and did, collapsed to one line with its duration. */
function Trace({ turn }: { turn: TalkTurn & { applied: TraceApplied | null } }) {
  const [open, setOpen] = useState(false);
  const a = turn.applied;
  const secs = a ? Math.max(1, Math.round(a.ms / 1000)) : null;
  const detail = [...(a?.notes ?? []), ...(a?.read.items ?? []).map((i) => `${i.label}: ${i.text}`)];
  return (
    <div className={cx(w.trace, a?.failed && w.failed)}>
      <button type="button" className={w.traceBtn} aria-expanded={detail.length ? open : undefined} disabled={!detail.length} onClick={() => setOpen(!open)}>
        <span>{turn.text}</span>{secs != null && <span className={w.chip}>{secs}s</span>}
      </button>
      {open && <ul className={w.traceBody}>{detail.map((d, k) => <li key={k}>{d}</li>)}</ul>}
    </div>
  );
}

/** "Read before you opened it", with what was read one click away. */
function ReadLine({ read }: { read: TalkState["read"] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={w.read}>
      <button type="button" className={w.readBtn} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{read.line}</span><b>{open ? "Hide" : "Show"}</b>
      </button>
      {open && <dl className={w.readList}>{read.items.map((i) => <div key={i.key}><dt>{i.label}</dt><dd>{i.text}</dd></div>)}</dl>}
    </div>
  );
}

/** A model turn takes up to a minute: say so, and count. */
function Working({ started, first }: { started: number; first: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  const secs = Math.round((Date.now() - started) / 1000);
  return (
    <div className={w.working}>
      <ThinkingIndicator>{first ? "Writing the reply" : "Reading and changing the drafts"} {secs}s</ThinkingIndicator>
      {secs >= 20 && <span className={w.muted}>This can take a minute. You can carry on with another email; the answer waits here.</span>}
    </div>
  );
}
