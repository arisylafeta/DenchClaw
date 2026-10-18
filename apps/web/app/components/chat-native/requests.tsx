"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PendingRequest } from "@/lib/hermes-chat/reducer";
import type { ClarifyQuestion } from "@/lib/hermes-chat/events";
import type { ApprovalChoice, NativeTranscriptCallbacks } from "./types";

/** Prompts dock on top of the input and share its surface: faint grey fading into the box below. */
export const dockClass = "w-full overflow-y-auto text-[var(--color-text)] max-h-[60dvh]";
const dockGhostClass = "min-h-11 sm:min-h-7 rounded-md px-2 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-2 disabled:opacity-60";

export interface ApprovalCardProps {
  request: PendingRequest;
  onApproval: NativeTranscriptCallbacks["onApproval"];
  active?: boolean;
}
const dockButton = "h-8 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-[12px] font-medium shadow-[0_1px_1px_rgba(0,0,0,0.04)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-2";
export function ApprovalCard({ request, onApproval, active = true }: ApprovalCardProps) {
  const ref = useRef<HTMLElement>(null);
  const [confirm, setConfirm] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { if (active) ref.current?.focus(); }, [active]);
  const choose = async (choice: ApprovalChoice) => {
    setSubmitted(true); setError("");
    try { await onApproval(request, choice); } catch (cause) { setSubmitted(false); setError(cause instanceof Error ? cause.message : "Could not submit approval"); }
  };
  const p = request.payload;
  const offered = p.choices;
  const once = !offered?.length || offered.includes("once");
  return <section ref={ref} tabIndex={-1} aria-label="Approval required" className={`${dockClass} space-y-2 px-3 py-3 text-[13px]`}>
    <h3 className="text-[13px] font-semibold leading-5">Approval required</h3>
    <span aria-hidden="true" className="block h-[2px] w-5 rounded-full bg-[var(--color-text)]" />
    {p.tool_name || p.name ? <p className="text-[12px] text-[var(--color-text-muted)]">Tool: {p.tool_name || p.name}</p> : null}
    {p.description && <p>{p.description}</p>}{p.command && <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono text-[11px]">{p.command}</pre>}
    {!active ? <p role="status">Resolved or withdrawn</p> : submitted ? <p role="status">Response submitted</p> : <div className="flex flex-wrap gap-2">
      {once && <button type="button" className={dockButton} onClick={() => void choose("once")}>Run once</button>}
      {p.allow_session && (!offered?.length || offered.includes("session")) && <button type="button" className={dockButton} onClick={() => void choose("session")}>Allow for session</button>}
      {p.allow_permanent && (!offered?.length || offered.includes("always")) && <button type="button" className={dockButton} onClick={() => setConfirm(true)}>Always allow</button>}
      <button type="button" className={dockButton} onClick={() => void choose("deny")}>Deny</button>
      {confirm && <div className="w-full space-x-2"><p>Always allow this command in future sessions?</p><button type="button" className={dockButton} onClick={() => void choose("always")}>Confirm always allow</button><button type="button" className={dockButton} onClick={() => setConfirm(false)}>Cancel</button></div>}
    </div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
export interface ClarifyCardProps {
  request: PendingRequest;
  onClarify: NativeTranscriptCallbacks["onClarify"];
  active?: boolean;
  /** Undefined keeps the standalone input. Null waits for the shared composer slot. */
  composerTarget?: HTMLElement | null;
  disabled?: boolean;
}
export function ClarifyCard({ request, onClarify, active = true, composerTarget, disabled = false }: ClarifyCardProps) {
  const fieldId = useId();
  const freeRef = useRef<HTMLTextAreaElement>(null);
  const inFlight = useRef(false);
  const questions: ClarifyQuestion[] = request.payload.questions?.length ? request.payload.questions : [{ qid: "question", question: request.payload.question || "Please clarify", choices: request.payload.choices }];
  const locked = request.payload.answers ?? {};
  const [index, setIndex] = useState(() => Math.max(0, questions.findIndex(question => !Object.hasOwn(locked, question.qid))));
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const unlocked = questions.map((question, i) => !Object.hasOwn(locked, question.qid) ? i : -1).filter(i => i >= 0);
  const currentIndex = unlocked.includes(index) ? index : (unlocked[0] ?? 0);
  const nextIndex = unlocked.find(i => i > currentIndex);
  const previousIndex = unlocked.findLast(i => i < currentIndex);
  const q = questions[currentIndex];
  const values = selected[q.qid] ?? [];
  const submit = async (answers: Record<string, string | null>) => {
    if (disabled || inFlight.current) return;
    inFlight.current = true; setSubmitted(true); setError("");
    try { await onClarify(request, answers); } catch (cause) { inFlight.current = false; setSubmitted(false); setError(cause instanceof Error ? cause.message : "Could not submit answers"); }
  };
  const answers = (override?: string): Record<string, string | null> => Object.fromEntries(questions.map(question => {
    if (Object.hasOwn(locked, question.qid)) return [question.qid, locked[question.qid]];
    const choices = question.qid === q.qid && override !== undefined ? [override] : selected[question.qid] ?? [];
    const free = question.qid === q.qid && override !== undefined ? "" : other[question.qid]?.trim();
    return [question.qid, [...choices.filter(choice => choice.toLowerCase() !== "other"), ...(free ? [free] : [])].join(", ") || null];
  }));
  const chooseSingle = (choice: string) => {
    setSelected(previous => ({ ...previous, [q.qid]: [choice] }));
    if (choice.toLowerCase() === "other") { freeRef.current?.focus(); return; }
    setOther(previous => ({ ...previous, [q.qid]: "" }));
    if (nextIndex !== undefined) setIndex(nextIndex);
    else void submit(answers(choice));
  };
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!active || submitted || disabled) return;
    (sectionRef.current?.querySelector<HTMLButtonElement>("[data-ask-option]") ?? freeRef.current)?.focus();
  }, [active, submitted, disabled, currentIndex, composerTarget]);
  const choices = q.choices ?? [];
  const skip = () => { setSelected(previous => ({ ...previous, [q.qid]: [] })); setOther(previous => ({ ...previous, [q.qid]: "" })); if (nextIndex !== undefined) setIndex(nextIndex); else void submit({ ...answers(), [q.qid]: null }); };
  const finish = () => nextIndex !== undefined ? setIndex(nextIndex) : void submit(answers());
  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (disabled || submitted || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    const rows = Array.from(sectionRef.current?.querySelectorAll<HTMLButtonElement>("[data-ask-option]") ?? []);
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); rows[(at + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus(); }
    else if (/^[1-9]$/.test(event.key) && Number(event.key) <= choices.length) { event.preventDefault(); rows[Number(event.key) - 1]?.click(); }
    else if (event.key === "Escape") { event.preventDefault(); skip(); }
  };
  const total = questions.length;
  const optionClass = "group/option flex min-h-11 sm:min-h-9 w-full items-center gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-left text-[13px] font-medium text-[var(--color-text)] shadow-[0_1px_1px_rgba(0,0,0,0.04)] transition-colors motion-reduce:transition-none hover:bg-[var(--color-surface-hover)] focus-visible:outline-2 disabled:opacity-60";
  const canFinish = !!(other[q.qid] ?? "").trim() || values.some(value => value.toLowerCase() !== "other");
  /** The field stays owned by this exact request/qid even when rendered in the main composer. */
  const answerField = <div className="px-3 pb-3 pt-1" data-clarify-composer>
    <label htmlFor={fieldId} className="mb-1 block text-[12px] font-medium text-[var(--color-text-muted)]">{choices.length ? "Other" : "Your answer"}</label>
    <textarea ref={freeRef} id={fieldId} aria-describedby={`${fieldId}-question`} disabled={disabled || submitted}
      placeholder={choices.length ? "Or type your own answer…" : "Type your answer…"}
      className={`block min-h-16 max-h-48 w-full resize-y px-3 py-2 text-base sm:text-[13px] text-[var(--color-text)] focus-visible:outline-2 disabled:opacity-60 ${composerTarget === undefined ? "rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]" : "rounded-md border-0 bg-transparent"}`}
      value={other[q.qid] ?? ""} onChange={event => { setOther(previous => ({ ...previous, [q.qid]: event.target.value })); if (!q.multi_select) setSelected(previous => ({ ...previous, [q.qid]: [] })); }}
      onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (canFinish && !disabled && !submitted) finish(); } }} />
    <div className="mt-2 flex justify-end"><button type="button" className="min-h-11 sm:min-h-8 rounded-lg bg-[var(--color-text)] px-3.5 text-[12px] font-medium text-[var(--color-bg)] disabled:opacity-40 focus-visible:outline-2" disabled={disabled || submitted || !canFinish} onClick={finish}>{nextIndex !== undefined ? "Next" : "Submit answer"}</button></div>
  </div>;
  if (!active || submitted || unlocked.length === 0) return <section aria-label="Clarification" className={dockClass}><p role="status" className="px-3 py-2 text-[12px] text-[var(--color-text-muted)]">{!active ? "Resolved or withdrawn" : "Answers submitted"}</p></section>;
  return <section ref={sectionRef} aria-label="Clarification" className={dockClass} onKeyDown={onKeyDown}>
    <div className="px-3 pb-3 pt-3">
      <div className="flex items-start justify-between gap-3">
        <h3 id={`${fieldId}-question`} className="text-[13px] font-semibold leading-5 text-[var(--color-text)]">{q.question}</h3>
        <div className="-mr-1 flex shrink-0 items-center gap-1 text-[11px] tabular-nums text-[var(--color-text-muted)]">
          <button type="button" className={dockGhostClass} disabled={disabled} onClick={skip}>Skip</button>
          {total > 1 && <>{previousIndex !== undefined && <button type="button" className={dockGhostClass} disabled={disabled} onClick={() => setIndex(previousIndex)}>Previous</button>}<span className="pr-1">{currentIndex + 1} of {total}</span></>}
        </div>
      </div>
      <span aria-hidden="true" className="mb-2.5 mt-1.5 block h-[2px] w-5 rounded-full bg-[var(--color-text)]" />
      {Object.entries(locked).map(([qid, answer]) => <p key={qid} className="mb-1 text-[11px] text-[var(--color-text-muted)]">{questions.find(question => question.qid === qid)?.question ?? qid}: {answer ?? "Skipped"}</p>)}
      {questions.slice(0, currentIndex).filter(question => !Object.hasOwn(locked, question.qid)).map(question => <p key={question.qid} className="mb-1 text-[11px] text-[var(--color-text-muted)]">{question.question}: {answers()[question.qid] ?? "Skipped"}</p>)}
      <div role={q.multi_select ? "group" : "radiogroup"} aria-label={q.question} className="flex flex-col gap-1.5">
        {choices.map((choice, index) => {
          const on = values.includes(choice);
          return <button key={choice} type="button" data-ask-option disabled={disabled} role={q.multi_select ? "checkbox" : "radio"} aria-checked={on} className={`${optionClass} ${on ? "border-[var(--color-text)] bg-[var(--color-surface-hover)]" : ""}`}
            onClick={() => q.multi_select ? setSelected(previous => ({ ...previous, [q.qid]: on ? values.filter(value => value !== choice) : [...values, choice] })) : chooseSingle(choice)}>
            <span aria-hidden="true" className="w-3 shrink-0 text-center font-mono text-[12px] tabular-nums text-[var(--color-text-muted)]">{index + 1}</span>
            <span className="min-w-0 flex-1 whitespace-normal break-words">{choice}</span>
            {q.multi_select && <span aria-hidden="true" className={`flex size-4 shrink-0 items-center justify-center rounded-[4px] border-[1.5px] ${on ? "border-[var(--color-text)] bg-[var(--color-text)] text-[var(--color-bg)]" : "border-[var(--color-border)]"}`}>{on ? "✓" : ""}</span>}
          </button>;
        })}
      </div>
      {composerTarget === undefined ? answerField : null}
      {composerTarget ? createPortal(answerField, composerTarget) : null}
      {error && <p role="alert" className="mt-1 text-[11px] text-[var(--color-error)]">{error}</p>}
    </div>
  </section>;
}
