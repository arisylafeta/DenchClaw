"use client";

import { useEffect, useRef, useState } from "react";
import type { PendingRequest } from "@/lib/hermes-chat/reducer";
import type { ClarifyQuestion } from "@/lib/hermes-chat/events";
import type { ApprovalChoice, NativeTranscriptCallbacks } from "./types";
import { buttonClass, cardClass } from "./tool-run";

export interface ApprovalCardProps {
  request: PendingRequest;
  onApproval: NativeTranscriptCallbacks["onApproval"];
  active?: boolean;
}
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
  return <section ref={ref} tabIndex={-1} aria-label="Approval required" className={cardClass}>
    <h3>Approval required</h3>
    {p.tool_name || p.name ? <p>Tool: {p.tool_name || p.name}</p> : null}
    {p.description && <p>{p.description}</p>}{p.command && <pre className="overflow-auto whitespace-pre-wrap">{p.command}</pre>}
    {!active ? <p role="status">Resolved or withdrawn</p> : submitted ? <p role="status">Response submitted</p> : <div className="flex flex-wrap gap-2">
      {once && <button type="button" className={buttonClass} onClick={() => void choose("once")}>Run once</button>}
      {p.allow_session && (!offered?.length || offered.includes("session")) && <button type="button" className={buttonClass} onClick={() => void choose("session")}>Allow for session</button>}
      {p.allow_permanent && (!offered?.length || offered.includes("always")) && <button type="button" className={buttonClass} onClick={() => setConfirm(true)}>Always allow</button>}
      <button type="button" className={buttonClass} onClick={() => void choose("deny")}>Deny</button>
      {confirm && <div className="w-full space-x-2"><p>Always allow this command in future sessions?</p><button type="button" className={buttonClass} onClick={() => void choose("always")}>Confirm always allow</button><button type="button" className={buttonClass} onClick={() => setConfirm(false)}>Cancel</button></div>}
    </div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
export interface ClarifyCardProps {
  request: PendingRequest;
  onClarify: NativeTranscriptCallbacks["onClarify"];
  active?: boolean;
}
export function ClarifyCard({ request, onClarify, active = true }: ClarifyCardProps) {
  const questions: ClarifyQuestion[] = request.payload.questions?.length ? request.payload.questions : [{ qid: "question", question: request.payload.question || "Please clarify", choices: request.payload.choices }];
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const q = questions[Math.min(index, questions.length - 1)];
  const values = selected[q.qid] ?? [];
  const submit = async (answers: Record<string, string | null>) => {
    setSubmitted(true); setError("");
    try { await onClarify(request, answers); } catch (cause) { setSubmitted(false); setError(cause instanceof Error ? cause.message : "Could not submit answers"); }
  };
  const answers = (override?: string): Record<string, string | null> => Object.fromEntries(questions.map(question => {
    const choices = question.qid === q.qid && override !== undefined ? [override] : selected[question.qid] ?? [];
    const free = other[question.qid]?.trim();
    return [question.qid, [...choices.filter(choice => choice.toLowerCase() !== "other"), ...(free ? [free] : [])].join(", ") || null];
  }));
  const chooseSingle = (choice: string) => {
    setSelected(previous => ({ ...previous, [q.qid]: [choice] }));
    if (choice.toLowerCase() === "other") return;
    if (index < questions.length - 1) setIndex(index + 1);
    else void submit(answers(choice));
  };
  return <section aria-label="Clarification" className={cardClass}>
    <h3>Clarification</h3>
    {!active ? <p role="status">Resolved or withdrawn</p> : submitted ? <p role="status">Answers submitted</p> : <>
      <p>Question {index + 1} of {questions.length}</p>
      <fieldset className="space-y-2"><legend>{q.question}</legend>
        <div className="flex flex-wrap gap-2">{q.choices?.map(choice => q.multi_select ? <label key={choice} className="flex items-center gap-2"><input type="checkbox" checked={values.includes(choice)} onChange={event => setSelected(previous => ({ ...previous, [q.qid]: event.target.checked ? [...values, choice] : values.filter(value => value !== choice) }))} />{choice}</label> : <button type="button" key={choice} className={buttonClass} aria-pressed={values.includes(choice)} onClick={() => chooseSingle(choice)}>{choice}</button>)}</div>
        <label className="block">{q.choices?.length ? "Other" : "Your answer"}<input className="block w-full rounded border border-[var(--color-border)] bg-transparent p-2" value={other[q.qid] ?? ""} onChange={event => setOther(previous => ({ ...previous, [q.qid]: event.target.value }))} /></label>
      </fieldset>
      <div className="flex gap-2">{index > 0 && <button type="button" className={buttonClass} onClick={() => setIndex(index - 1)}>Previous</button>}
        <button type="button" className={buttonClass} onClick={() => index < questions.length - 1 ? setIndex(index + 1) : void submit(answers())}>{index < questions.length - 1 ? "Next" : "Submit"}</button>
        <button type="button" className={buttonClass} onClick={() => { setSelected(previous => ({ ...previous, [q.qid]: [] })); setOther(previous => ({ ...previous, [q.qid]: "" })); if (index < questions.length - 1) setIndex(index + 1); else void submit({ ...answers(), [q.qid]: null }); }}>Skip</button>
      </div>
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
