import type { AskApplied, TalkState, TalkTurn, TraceApplied } from "./relay-talk";
import type { DeskView } from "./relay-desk";
import { ACTIVE_STATUSES, type DeskMode } from "./relay-desk-core";
import type { ListingProposalView } from "./relay-listings-core";

/**
 * Relay's chat while the desk works, the pure part. The page starts a desk turn, then reads GET .../talk every second and a
 * half until the turn has ended. The talk answer only carries the run while it is active, so how a run ended is read from
 * what it left in the chat: its "Stopped." line, a failed line, or its work and words. Nothing here fetches.
 */

/** GET .../talk: the chat and drafts, plus the desk turn in progress and the "Continue in Claude" command. */
export type DeskTalk = TalkState & { desk?: DeskView["run"]; claudeSession?: string | null; listings?: ListingProposalView | null };

/** The desk turn the page is following: one it started, or one it found running when the email opened. */
export type Following = {
  runId: string; mode: DeskMode;
  /** What Alex typed (chat), kept so a failed or stopped turn can put it back in the box. */
  text: string;
  /** When it started, in this browser's clock (the server's clock may differ). */
  startedAt: number;
  /** Turns already in the chat when it started: anything else is this run's. */
  before: string[];
  /** The page's load counter when the run was known: only a load started after this can say it has ended. */
  fromLoad: number;
};

export type RunState =
  | { kind: "running"; stopping: boolean }
  | { kind: "done" }
  | { kind: "failed" }
  | { kind: "stopped" };

const deskOf = (t: TalkTurn) => (t.role === "trace" ? (t.applied as TraceApplied | null)?.desk ?? null : null);
const askOf = (t: TalkTurn) => (t.role === "relay" ? (t.applied as AskApplied | null)?.ask ?? null : null);

/**
 * Where the followed run stands. `freshLoad` is the counter of the load that produced `talk`: until a load that began after
 * the run was known comes back, the run counts as running (an older answer can't show it yet). Once it has left the talk
 * answer: a "stop" line means stopped, a failed line means failed, and a run that left nothing at all (its runner never
 * started) failed too. A run that timed out says so in its own words, so it reads as done.
 */
export function runState(f: Following, talk: DeskTalk | null, freshLoad: number): RunState {
  if (!talk || freshLoad <= f.fromLoad) return { kind: "running", stopping: false };
  if (talk.desk && talk.desk.id === f.runId && ACTIVE_STATUSES.includes(talk.desk.status)) return { kind: "running", stopping: talk.desk.status === "stopping" };
  const before = new Set(f.before);
  const mine = talk.turns.filter((t) => deskOf(t)?.run === f.runId || askOf(t)?.run === f.runId);
  if (mine.some((t) => deskOf(t)?.tool === "stop")) return { kind: "stopped" };
  if (mine.some((t) => (t.applied as TraceApplied | null)?.failed)) return { kind: "failed" };
  const said = talk.turns.some((t) => t.role === "relay" && !before.has(t.id));
  return mine.length || said ? { kind: "done" } : { kind: "failed" };
}

/**
 * The run to follow when the page has none of its own: the talk answer shows a turn in progress (one the page started
 * before a reload, or the background first draft). started_at is the server's Postgres text; it is only used to count the
 * time, so a bad or missing one counts from now.
 */
export function foundRun(talk: DeskTalk, load: number, now = Date.now()): Following | null {
  const run = talk.desk;
  if (!run || !ACTIVE_STATUSES.includes(run.status)) return null;
  const started = pgTime(run.started_at);
  // A chat turn's words are Alex's newest message, so Try again after a failure can send them again.
  const text = run.mode === "chat" ? talk.turns.findLast((t) => t.role === "alex")?.text ?? "" : "";
  return { runId: run.id, mode: run.mode, text, startedAt: started != null && started <= now ? started : now, before: talk.turns.map((t) => t.id), fromLoad: load - 1 };
}

/** A Postgres timestamptz as text ("2026-11-22 10:15:02.123+00") in milliseconds, or null. */
export function pgTime(text: string | null | undefined): number | null {
  if (!text) return null;
  const iso = text.trim().replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00").replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** "0:42", "12:05": the time a turn has run. */
export function clock(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

/**
 * The question Alex still has to answer: the newest turn with a question, if he hasn't written since. Only that one docks
 * in the composer; older questions stay as prose in the chat.
 */
export function openQuestion(turns: TalkTurn[]): (TalkTurn & { applied: AskApplied }) | null {
  for (let k = turns.length - 1; k >= 0; k--) {
    const t = turns[k];
    if (t.role === "alex") return null;
    if (askOf(t)?.options.length) return t as TalkTurn & { applied: AskApplied };
  }
  return null;
}

/** The chat as the page lays it out: each turn, with one desk run's work lines kept together as one block. */
export type ChatPiece = { kind: "turn"; turn: TalkTurn } | { kind: "work"; run: string; lines: (TalkTurn & { applied: TraceApplied })[] };

export function chatPieces(turns: TalkTurn[]): ChatPiece[] {
  const out: ChatPiece[] = [];
  for (const t of turns) {
    const run = deskOf(t)?.run;
    const last = out[out.length - 1];
    if (!run) out.push({ kind: "turn", turn: t });
    else if (last?.kind === "work" && last.run === run) last.lines.push(t as TalkTurn & { applied: TraceApplied });
    else out.push({ kind: "work", run, lines: [t as TalkTurn & { applied: TraceApplied }] });
  }
  return out;
}

/** A finished run's work, folded to one line: how long it took, how many steps, and whether it stopped or went wrong. */
export function workSummary(lines: (TalkTurn & { applied: TraceApplied })[]): { text: string; failed: boolean } {
  const ms = Math.max(0, ...lines.map((l) => l.applied?.ms ?? 0));
  const stopped = lines.some((l) => l.applied?.desk?.tool === "stop");
  const failed = lines.some((l) => l.applied?.failed);
  const steps = lines.filter((l) => !l.applied?.failed && !["stop", "error"].includes(l.applied?.desk?.tool ?? "")).length;
  const count = steps ? `, ${steps} ${steps === 1 ? "step" : "steps"}` : "";
  if (stopped) return { text: `Stopped after ${clock(ms)}${count}`, failed: false };
  if (failed) return { text: `Went wrong after ${clock(ms)}${count}`, failed: true };
  return { text: `Worked for ${clock(ms)}${count}`, failed: false };
}

/** Whether the page should keep reading the chat: while the run it follows, or one the server shows, is still going. */
export function keepPolling(f: Following | null, talk: DeskTalk | null, freshLoad: number): boolean {
  if (!f) return !!talk?.desk && ACTIVE_STATUSES.includes(talk.desk.status);
  return runState(f, talk, freshLoad).kind === "running";
}
