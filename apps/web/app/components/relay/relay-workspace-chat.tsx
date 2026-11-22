"use client";

import { useEffect, useRef, useState, type RefObject, type SetStateAction } from "react";
import { ArrowUp } from "lucide-react";
import type { TalkApplied, TalkDraft, TalkState, TalkTurn, TraceApplied } from "@/lib/relay-talk";
import { chatPieces, clock, openQuestion, workSummary, type DeskTalk } from "@/lib/relay-desk-view-core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ThinkingIndicator } from "@/app/components/chat-native/thinking";
import { isAutoNote } from "@/lib/relay-auto-note";
import { cx, firstOf } from "./relay-ui";
import type { Say } from "./relay-workspace-work";
import w from "./relay-workspace.module.css";

/** The desk turn in progress: when it started (this browser's clock), whether Stop was pressed, and Stop. */
type DeskNow = { run: string; startedAt: number; stopping: boolean; onStop: () => void };

type Quick = { followUp: () => void; style: () => void; reprice: () => void; deal: (() => void) | null };
const NUMBER = ["", "one", "two", "three", "four", "five", "six"];
const isTrace = (t: TalkTurn): t is TalkTurn & { applied: TraceApplied | null } => t.role === "trace";
const short = (text: string, max = 24) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/**
 * Relay's chat about this email, full height on the right: what Relay read before Alex opened it, the turns (his
 * bubbles, Relay's prose, the work as one quiet line each) and the composer pill with which email he means. While the
 * desk works, its lines arrive under the last turn with a running clock and Stop; a question it asks docks its answers
 * in the composer.
 */
export function RelayChat({ talk, name, drafts, current, all, onTarget, pending, error, onRetry, text, setText, onAsk, composer, firstNote, repricing, quick, saveRule, desk, echo, notice, say }: {
  talk: DeskTalk | null; name: string; drafts: TalkDraft[]; current: TalkDraft | null; all: boolean; onTarget: (id: string) => void;
  pending: { text: string; started: number; first: boolean; auto?: boolean } | null; error: { text: string; line: string; quiet?: boolean } | null; onRetry: (() => void) | null;
  text: string; setText: (next: SetStateAction<string>) => void; onAsk: (text: string) => void; composer: RefObject<HTMLTextAreaElement | null>;
  firstNote: string; repricing: boolean; quick: Quick; saveRule: (rule: string) => Promise<boolean>;
  desk: DeskNow | null;
  /** What Alex just sent to the desk, shown until the chat has it. */
  echo: string | null;
  /** A quiet line under the turns, e.g. that the one-shot answered because the desk couldn't start. */
  notice: string | null;
  say: Say;
}) {
  const live = drafts.filter((d) => d.mail);
  const first = firstOf(name);
  const count = NUMBER[live.length] ?? String(live.length);
  const target = !live.length ? `${first}’s email` : all ? (live.length === 2 ? "both emails" : `all ${count} emails`) : current?.role === "primary" ? `your reply to ${first}` : current ? `the email “${current.title}”` : `${first}’s email`;
  const turns = talk?.turns ?? [];
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; }, [turns.length, !!pending, !!error, !!desk, !!echo]);
  const busy = !!pending || !!desk;

  // The newest question the desk asked, until Alex answers it: its options dock in the composer.
  const question = openQuestion(turns);

  // The newest rule Relay offered, until Alex saves it or says not now.
  const [ruleDone, setRuleDone] = useState<Record<string, "saved" | "skipped">>({});
  const offer = turns.toReversed().find((t) => t.role === "relay" && (t.applied as TalkApplied | null)?.ruleOffer);
  const rule = offer ? (offer.applied as TalkApplied).ruleOffer : null;
  const ruleState = offer ? ruleDone[offer.id] : undefined;

  const auto = isAutoNote(firstNote);
  const showNote = !auto && !!firstNote.trim() && !turns.some((t) => t.role === "alex" && t.text.trim() === firstNote.trim());
  const placeholder = desk ? "Relay is working. Type your next message and send it when it finishes."
    : !live.length ? `Say how to answer ${first}, like “offer the 62 kWh, and say we can get the mileage from the VIN”`
    : all ? `Change ${live.length === 2 ? "both" : `all ${count}`} at once, like “sign off as Alex and the team”`
    : `Change ${target}, or ask for another email: “also email Broekhuis”, “price the 62 kWh at 5k”`;
  const submit = () => { if (text.trim() && !busy) onAsk(text); };

  return (
    <aside className={w.chat} aria-label="Talk to Relay">
      <div className={w.chatScroll} ref={scroller}>
        <div className={w.chatTop}>
          <span className={w.chatHead}>Relay <span>on {target}</span></span>
          {talk?.claudeSession && <ContinueInClaude command={talk.claudeSession} say={say} />}
        </div>
        {talk && talk.read.items.length > 0 && <ReadLine read={talk.read} />}
        {auto && live.length > 0 && <p className={w.chatEmpty}>Relay wrote this reply before you opened it. Ask for any change, or another email to go with it.</p>}
        {showNote && <Mine text={firstNote} />}
        {chatPieces(turns).map((p) => (p.kind === "work" ? <DeskWork key={p.lines[0].id} lines={p.lines} running={desk?.run === p.run} />
          : p.turn.role === "alex" ? <Mine key={p.turn.id} text={p.turn.text} /> : isTrace(p.turn) ? <Trace key={p.turn.id} turn={p.turn} /> : <RelaySays key={p.turn.id} turn={p.turn} />))}
        {pending && !pending.auto && <Mine text={pending.text} />}
        {!pending && echo && <Mine text={echo} />}
        {notice && <span className={w.relayNote}>{notice}</span>}
        {(desk || pending) && <Working started={desk?.startedAt ?? pending!.started} desk={desk} />}
        {error && (
          <div className={cx(w.chatError, error.quiet && w.chatQuiet)} role={error.quiet ? "status" : "alert"}>
            <span>{error.line}</span>
            {onRetry && <button type="button" className={w.linkbtn} onClick={onRetry}>Try again</button>}
          </div>
        )}
        {!turns.length && !busy && !echo && !showNote && !(auto && live.length) && !error && talk && (
          <p className={w.chatEmpty}>{live.length ? "Ask for any change, or another email to go with the reply." : `Tell Relay how to answer ${first}. It has read the thread and their history first.`}</p>
        )}
      </div>

      <div className={w.dockWrap}>
        <div className={cx(w.pill, (question || (rule && !ruleState)) && w.asking)}>
          {question && (
            <div className={w.dock} role="group" aria-label={`Answer Relay: ${question.applied.ask.question}`}>
              <span className={w.muted}>{busy ? "Answer when Relay has finished." : "Tap an answer, or type your own."}</span>
              <span className={w.options}>
                {question.applied.ask.options.map((o) => <button key={o} type="button" className={w.option} disabled={busy} onClick={() => onAsk(o)}>{o}</button>)}
              </span>
            </div>
          )}
          {!question && rule && !ruleState && offer && (
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
            {live.length > 0 && <button type="button" className={w.qchip} disabled={repricing || !!desk} onClick={quick.reprice}>{repricing ? "Re-pricing…" : "Re-price"}</button>}
            {quick.deal && <button type="button" className={w.qchip} onClick={quick.deal}>Create the deal</button>}
            <button type="button" className={w.go} aria-label="Ask Relay" title={desk ? "Relay is working. Send when it finishes." : undefined} disabled={!text.trim() || busy} onClick={submit}><ArrowUp size={15} aria-hidden /></button>
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
      <div className={cx("chat-prose chat-message-font", w.prose, turn.text.startsWith("I didn't save ") && w.blocked)}>
        <RelayMarkdown text={turn.text} />
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

/**
 * Relay at work: a running clock, and Stop while a desk turn runs. A turn can take a few minutes; past twenty seconds
 * the line says Alex can carry on with another email.
 */
function Working({ started, desk }: { started: number; desk: DeskNow | null }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  const ms = Date.now() - started;
  return (
    <div className={w.working}>
      <span className={w.workingRow}>
        <ThinkingIndicator>{desk?.stopping ? "Stopping…" : "Working…"} {clock(ms)}</ThinkingIndicator>
        {desk && <button type="button" className={w.stop} disabled={desk.stopping} onClick={desk.onStop}>Stop</button>}
      </span>
      {ms >= 20_000 && !desk?.stopping && <span className={w.muted}>You can carry on with another email; the answer waits here.</span>}
    </div>
  );
}

/**
 * One desk turn's work: a quiet line per step while it runs, newest at the bottom; once it has finished, folded to how
 * long it took, with the steps one click away.
 */
function DeskWork({ lines, running }: { lines: (TalkTurn & { applied: TraceApplied })[]; running: boolean }) {
  const [open, setOpen] = useState(false);
  const sum = workSummary(lines);
  if (running) {
    return (
      <ol className={w.deskLines} aria-label="What Relay is doing" aria-live="polite">
        {lines.map((l) => <li key={l.id} className={cx(l.applied?.failed && w.blocked)}>{l.text}</li>)}
      </ol>
    );
  }
  return (
    <div className={cx(w.trace, sum.failed && w.failed)}>
      <button type="button" className={w.traceBtn} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{sum.text}</span><b className={w.traceMore}>{open ? "Hide" : "Show"}</b>
      </button>
      {open && <ol className={w.traceBody}>{lines.map((l) => <li key={l.id} className={cx(l.applied?.failed && w.blocked)}>{l.text}</li>)}</ol>}
    </div>
  );
}

/**
 * "Continue in Claude": the command that opens this email's desk session in Claude Code on the server. Copied to the
 * clipboard; when the browser refuses, the command shows to select by hand.
 */
function ContinueInClaude({ command, say }: { command: string; say: Say }) {
  const [shown, setShown] = useState(false);
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error("No clipboard");
      await navigator.clipboard.writeText(command);
      setShown(false);
      say("Copied. Run it in a terminal on the server to carry on this conversation in Claude Code.");
    } catch {
      // The browser said no (permissions, an insecure page): the command is still there to select.
      setShown(true);
    }
  };
  return (
    <>
      <button type="button" className={w.quietLink} onClick={() => void copy()}>Continue in Claude</button>
      {shown && (
        <div className={w.command}>
          <label htmlFor="relay-claude-command">Copy this and run it in a terminal on the server:</label>
          <textarea id="relay-claude-command" readOnly rows={3} value={command} autoFocus onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className={w.linkbtn} onClick={() => setShown(false)}>Done</button>
        </div>
      )}
    </>
  );
}

/**
 * Relay's answer as the desk wrote it: Markdown (bold, lists, tables, links), like the CRM chat. Links open in a new tab;
 * pictures show as their text only, since an answer can quote content from untrusted email.
 */
function RelayMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
      a: ({ href, children, node: _node, ...props }) => <a href={href} {...props} target="_blank" rel="noopener noreferrer">{children}</a>,
      img: ({ alt }) => (alt ? <span>{alt}</span> : null),
    }}>{text}</ReactMarkdown>
  );
}

