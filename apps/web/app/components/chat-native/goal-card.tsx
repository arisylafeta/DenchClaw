"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Check, ChevronRight, CircleAlert, FastForward, Hourglass, Pause, Play, Plus, RotateCw, Target, X } from "lucide-react";
import type { GoalAction, GoalSnapshot } from "@/lib/hermes-chat/goal";
import { formatElapsedDuration } from "@/lib/elapsed-duration";

export type GoalControl = (action: GoalAction, args?: { text?: string; index?: number }) => Promise<unknown>;

const CONTRACT: [keyof GoalSnapshot["contract"], string][] = [
  ["outcome", "Done when"], ["verification", "Verify"], ["constraints", "Keep"], ["boundaries", "Scope"], ["stop_when", "Stop if"],
];

/** Height-animating disclosure (same motion as the task card): stays mounted, inert while closed. */
function Collapse({ open, children }: { open: boolean; children: React.ReactNode }) {
  return <div data-open={open} className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none ${open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`} aria-hidden={!open} inert={!open}>
    <div className="min-h-0 overflow-hidden">{children}</div>
  </div>;
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!active) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [active]);
  return now;
}

/** One short phrase for where the goal stands. */
export function goalStatus(goal: GoalSnapshot, now = Date.now()): { label: string; tone: "active" | "waiting" | "paused" | "done" | "blocked" } {
  const barrier = goal.wait_barrier;
  if (goal.status === "done") return { label: `Done in ${goal.turns_used} ${goal.turns_used === 1 ? "turn" : "turns"}`, tone: "done" };
  if (goal.status === "paused") {
    const budget = goal.turns_used >= goal.max_turns || /budget/i.test(goal.paused_reason ?? "");
    return { label: goal.last_verdict === "blocked" ? "Blocked" : budget ? "Paused · budget used" : "Paused", tone: goal.last_verdict === "blocked" ? "blocked" : "paused" };
  }
  if (barrier) {
    const left = barrier.type === "until" ? Math.max(0, barrier.until_at * 1000 - now) / 1000 : 0;
    return { label: barrier.type === "until" ? `Waiting · ${formatElapsedDuration(left)}` : barrier.type === "session" ? "Waiting on a process" : "Waiting on a process", tone: "waiting" };
  }
  return { label: `Turn ${Math.min(goal.turns_used + 1, goal.max_turns)} of ${goal.max_turns}`, tone: "active" };
}

const VERDICT_ICON = { continue: RotateCw, done: Check, blocked: CircleAlert, wait: Hourglass } as const;

export interface GoalCardProps { goal: GoalSnapshot; busy?: boolean; onControl: GoalControl }

/**
 * The chat's standing goal, docked above the input like the task card: one line with status and turn budget,
 * opening into the contract, extra criteria, gates and the judge's latest verdict. Flat: no borders or shadows.
 */
export function GoalCard({ goal, busy = false, onControl }: GoalCardProps) {
  const finished = goal.status === "done";
  const [open, setOpen] = useState<boolean | null>(null);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const now = useNow(goal.wait_barrier?.type === "until");
  const expanded = open ?? false;
  const status = goalStatus(goal, now);
  const contract = CONTRACT.filter(([key]) => goal.contract[key]?.trim());
  const verdictKey = (goal.last_verdict ?? "") as keyof typeof VERDICT_ICON;
  const VerdictIcon = VERDICT_ICON[verdictKey];
  const live = status.tone === "active" && busy;
  const run = async (action: GoalAction, args?: { text?: string; index?: number }) => {
    setPending(action); setError("");
    try { await onControl(action, args); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Goal update failed"); return false; }
    finally { setPending(null); }
  };
  const add = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (text && await run("subgoal.add", { text })) { setDraft(""); setAdding(false); }
  };
  const iconButton = "flex size-6 shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] focus-visible:outline-2 disabled:opacity-40";
  const toneText = status.tone === "blocked" ? "text-[var(--color-error)]" : status.tone === "done" || status.tone === "paused" ? "text-[var(--color-text-muted)]" : "text-[var(--color-accent)]";
  return <section aria-label="Goal" data-goal-status={goal.status} data-open={expanded} className="px-3 pb-1 pt-2.5 text-[13px] leading-5">
    <header className="flex items-center gap-2">
      <button type="button" aria-expanded={expanded} aria-label="Goal" onClick={() => setOpen(!expanded)} className="flex min-w-0 flex-1 items-center gap-2 rounded text-left focus-visible:outline-2">
        <ChevronRight aria-hidden="true" className={`size-3 shrink-0 text-[var(--color-text-muted)] transition-transform motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`} />
        <span aria-hidden="true" className={`flex size-4 shrink-0 items-center justify-center rounded-full ${finished ? "bg-[var(--color-accent)] text-[var(--color-accent-foreground,#fff)]" : toneText} ${live ? "todo-node-active" : ""}`}>
          {finished ? <Check className="size-2.5" strokeWidth={3.5} /> : <Target className="size-3.5" />}
        </span>
        <span className="shrink-0 text-[13px] font-semibold">Goal</span>
        <span data-goal-state={status.tone} className={`shrink-0 font-mono text-[11px] ${toneText}`}>{status.label}</span>
        <span className={`min-w-0 truncate text-[12px] ${finished ? "text-[var(--color-text-muted)]" : ""}`} title={goal.title}>{goal.title}</span>
      </button>
      {!finished && <div role="progressbar" aria-label="Goal turn budget" aria-valuemin={0} aria-valuemax={goal.max_turns} aria-valuenow={goal.turns_used} className="h-1 w-14 shrink-0 overflow-hidden rounded-full bg-[var(--color-border)]">
        <span className={`block h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-300 ${live ? "todo-seg-active" : ""}`} style={{ width: `${Math.min(100, (goal.turns_used / Math.max(1, goal.max_turns)) * 100)}%` }} />
      </div>}
      {goal.status === "active" && goal.wait_barrier && <button type="button" className={iconButton} aria-label="Stop waiting" title="Continue now" disabled={pending !== null} onClick={() => void run("goal.unwait")}><FastForward className="size-3.5" /></button>}
      {goal.status === "active" && <button type="button" className={iconButton} aria-label="Pause goal" title="Pause" disabled={pending !== null} onClick={() => void run("goal.pause")}><Pause className="size-3.5" /></button>}
      {goal.status === "paused" && <button type="button" className={iconButton} aria-label="Resume goal" title="Resume" disabled={pending !== null} onClick={() => void run("goal.resume")}><Play className="size-3.5" /></button>}
      <button type="button" className={iconButton} aria-label={finished ? "Dismiss goal" : "Clear goal"} title={finished ? "Dismiss" : "Clear"} disabled={pending !== null} onClick={() => void run("goal.clear")}><X className="size-3.5" /></button>
    </header>
    {error && <p role="alert" className="mt-1 pl-5 text-[11px] text-[var(--color-error)]">{error}</p>}
    <Collapse open={expanded}>
      <div className="max-h-[40dvh] space-y-3 overflow-y-auto pb-2 pl-5 pr-1 pt-2">
        <p className="whitespace-pre-wrap break-words font-medium">{goal.title}</p>
        {goal.last_reason && <div data-goal-verdict={goal.last_verdict ?? undefined} className={`flex gap-2 text-[12px] leading-5 ${goal.last_verdict === "blocked" ? "text-[var(--color-error)]" : "text-[var(--color-text-muted)]"}`}>
          {VerdictIcon ? <VerdictIcon aria-hidden="true" className="mt-[3px] size-3.5 shrink-0" /> : null}
          <p className="min-w-0 break-words"><span className="sr-only">Latest check: </span>{goal.last_reason}</p>
        </div>}
        {goal.wait_barrier?.reason && <p className="flex gap-2 text-[12px] text-[var(--color-text-muted)]"><Hourglass aria-hidden="true" className="mt-[3px] size-3.5 shrink-0" />{goal.wait_barrier.reason}</p>}
        {goal.status === "paused" && goal.paused_reason && goal.paused_reason !== "user-paused" && <p className="text-[12px] text-[var(--color-text-muted)]">Paused: {goal.paused_reason}</p>}
        {contract.length > 0 && <dl className="grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1 text-[12px]">
          {contract.map(([key, label]) => <div key={key} className="contents"><dt className="text-[var(--color-text-muted)]">{label}</dt><dd className="min-w-0 break-words">{goal.contract[key]}</dd></div>)}
        </dl>}
        {(goal.subgoals.length > 0 || !finished) && <div>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">Also required</p>
          <ul className="space-y-0.5">
            {goal.subgoals.map((text, index) => <li key={`${index}-${text}`} className="group/sub flex min-h-6 items-start gap-2 text-[12px]">
              <span aria-hidden="true" className="mt-[7px] size-1.5 shrink-0 rounded-full bg-[var(--color-border)]" />
              <span className="min-w-0 flex-1 break-words">{text}</span>
              {!finished && <button type="button" className={`${iconButton} opacity-0 group-hover/sub:opacity-100 focus-visible:opacity-100`} aria-label={`Remove: ${text}`} disabled={pending !== null} onClick={() => void run("subgoal.remove", { index: index + 1 })}><X className="size-3" /></button>}
            </li>)}
          </ul>
          {!finished && (adding
            ? <form onSubmit={add} className="mt-1 flex items-center gap-2">
              <input autoFocus aria-label="New requirement" value={draft} maxLength={2000} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { setAdding(false); setDraft(""); } }}
                placeholder="Another thing that must be true" className="min-w-0 flex-1 rounded-md bg-[var(--color-surface-hover)] px-2 py-1 text-[12px] outline-none placeholder:text-[var(--color-text-muted)] focus-visible:outline-2" />
              <button type="submit" disabled={!draft.trim() || pending !== null} className="rounded-md px-2 py-1 text-[12px] font-medium text-[var(--color-accent)] hover:bg-[var(--color-surface-hover)] disabled:opacity-40">Add</button>
            </form>
            : <button type="button" onClick={() => setAdding(true)} className="mt-0.5 flex items-center gap-1.5 rounded px-1 py-0.5 text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] focus-visible:outline-2"><Plus aria-hidden="true" className="size-3" />Add requirement</button>)}
        </div>}
        {goal.gates.length > 0 && <div>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">Must pass</p>
          <ul className="space-y-1">{goal.gates.map((gate, index) => {
            const state = gate.last_exit_code == null ? "pending" : gate.last_exit_code === 0 ? "pass" : "fail";
            return <li key={`${index}-${gate.command}`} data-gate={state} className="flex items-center gap-2 text-[12px]">
              <span className={`shrink-0 rounded px-1.5 font-mono text-[10px] ${state === "pass" ? "bg-[var(--color-accent)]/15 text-[var(--color-accent)]" : state === "fail" ? "bg-[var(--color-error)]/15 text-[var(--color-error)]" : "bg-[var(--color-surface-hover)] text-[var(--color-text-muted)]"}`}>{state === "pass" ? "passed" : state === "fail" ? `exit ${gate.last_exit_code}` : "not run"}</span>
              <code className="min-w-0 truncate font-mono text-[11px]" title={gate.command}>{gate.command}</code>
              {gate.attempts > 0 && <span className="ml-auto shrink-0 text-[11px] text-[var(--color-text-muted)]">{gate.attempts}/{gate.max_retries}</span>}
            </li>;
          })}</ul>
        </div>}
      </div>
    </Collapse>
  </section>;
}
