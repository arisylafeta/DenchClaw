"use client";

import { useState } from "react";
import { CHANNELS } from "@/lib/marketplace-pulse";
import {
  LEVER_STATUSES, STEPS, paidPerMonth, parsePlan, sendsPerMonth, waterfall,
  type Lever, type LeverStatus, type Plan, type Rates, type StepKey,
} from "@/lib/marketplace-pulse-plan";
import { ErrorText, FormField, Modal, buttonClass, buttonStyle, darkButtonClass, darkButtonStyle, inputClass, inputStyle } from "../bulk-trades/trade-ui";

type DraftLever = { id: string; name: string; owner: string; status: LeverStatus; steps: Record<StepKey, string> };
type DraftChannel = { goal: string; owner: string; action: string };

const blankSteps = () => Object.fromEntries(STEPS.map((s) => [s.key, ""])) as Record<StepKey, string>;
// Rates are edited as percentages; visitors as a number a month.
const toText = (key: StepKey, v: number | undefined) => (v === undefined ? "" : key === "visitors" ? String(Math.round(v)) : String(Math.round(v * 1000) / 10));
const fromText = (key: StepKey, text: string) => (text.trim() === "" ? undefined : key === "visitors" ? Number(text) : Number(text) / 100);

type Props = { plan: Plan; start: Rates; onClose: () => void; onSave: (plan: Plan) => Promise<void> };

/** Edits the plan: target, fixes in order with the step rates each one should reach, and channel goals. */
export function PlanEditor({ plan, start, onClose, onSave }: Props) {
  const [target, setTarget] = useState(String(plan.target_paid));
  const [date, setDate] = useState(plan.target_date);
  const [restart, setRestart] = useState(false);
  const [levers, setLevers] = useState<DraftLever[]>(plan.levers.map((l) => ({
    ...l, steps: { ...blankSteps(), ...Object.fromEntries(Object.entries(l.steps).map(([k, v]) => [k, toText(k as StepKey, v)])) },
  })));
  const [channels, setChannels] = useState<Record<string, DraftChannel>>(Object.fromEntries(CHANNELS.map((c) => {
    const goal = plan.channels.find((x) => x.channel === c);
    return [c, { goal: goal ? String(goal.goal) : "", owner: goal?.owner ?? "", action: goal?.action ?? "" }];
  })));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draft: Plan = {
    target_paid: Number(target),
    target_date: date,
    start: restart ? { date: new Date().toISOString().slice(0, 10), paid: Math.round(paidPerMonth(start) * 10) / 10 } : plan.start,
    levers: levers.map((l) => ({
      id: l.id, name: l.name, owner: l.owner, status: l.status,
      steps: Object.fromEntries(STEPS.flatMap(({ key }) => {
        const v = fromText(key, l.steps[key]);
        return v === undefined ? [] : [[key, v]];
      })) as Lever["steps"],
    })),
    channels: CHANNELS.filter((c) => channels[c].goal.trim() !== "" || channels[c].action.trim() !== "")
      .map((c) => ({ channel: c, goal: Number(channels[c].goal || 0), owner: channels[c].owner, action: channels[c].action })),
  };
  const parsed = parsePlan(draft);
  const preview = "plan" in parsed ? waterfall(start, parsed.plan.levers).final : null;
  const goals = draft.channels.reduce((sum, c) => sum + c.goal, 0);

  const update = (i: number, change: Partial<DraftLever>) => setLevers((all) => all.map((l, j) => (j === i ? { ...l, ...change } : l)));
  const move = (i: number, by: number) => setLevers((all) => {
    const next = [...all];
    const [item] = next.splice(i, 1);
    next.splice(Math.max(0, Math.min(next.length, i + by)), 0, item);
    return next;
  });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if ("error" in parsed) return setError(parsed.error);
    setSaving(true);
    setError(null);
    try {
      await onSave(parsed.plan);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the plan.");
      setSaving(false);
    }
  }

  const small = `${inputClass} h-8 px-2 text-[13px]`;
  return (
    <Modal wide title="Edit plan" onClose={onClose} onSubmit={submit}
      footer={(
        <>
          <span className="mr-auto text-xs" style={{ color: "var(--bt-muted)" }}>
            {preview ? `Adds up to ${Math.round(paidPerMonth(preview) * 10) / 10} paid deals a month · channel goals ${Math.round(goals)} sends, model needs ${Math.round(sendsPerMonth(preview))}` : "Fix the errors to see what the plan adds up to"}
          </span>
          <button type="submit" disabled={saving} className={darkButtonClass} style={darkButtonStyle}>{saving ? "Saving" : "Save as new version"}</button>
        </>
      )}>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Paid deals a month">
          <input aria-label="Target paid deals a month" type="number" min="0" step="0.5" value={target} onChange={(e) => setTarget(e.target.value)} className={inputClass} style={inputStyle} />
        </FormField>
        <FormField label="By">
          <input aria-label="Target date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputClass} style={inputStyle} />
        </FormField>
      </div>
      <label className="flex items-center gap-2 text-xs" style={{ color: "var(--bt-text-2)" }}>
        <input type="checkbox" checked={restart} onChange={(e) => setRestart(e.target.checked)} />
        Start the plan path again from today ({Math.round(paidPerMonth(start) * 10) / 10} a month)
      </label>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-xs font-medium" style={{ color: "var(--bt-muted)" }}>
          Fixes, in order. Leave a step blank if the fix does not change it. Rates in %, visitors a month.
        </legend>
        {levers.map((l, i) => (
          <div key={l.id} role="group" aria-label={`Fix ${i + 1}`} className="flex flex-col gap-1.5 border p-2" style={{ borderColor: "var(--bt-divider)" }}>
            <div className="flex gap-1.5">
              <input aria-label="Fix" value={l.name} onChange={(e) => update(i, { name: e.target.value })} className={small} style={inputStyle} placeholder="What we will do" />
              <input aria-label="Owner" value={l.owner} onChange={(e) => update(i, { owner: e.target.value })} className={`${small} w-24`} style={inputStyle} placeholder="Owner" />
              <select aria-label="Status" value={l.status} onChange={(e) => update(i, { status: e.target.value as LeverStatus })} className={`${small} w-28`} style={inputStyle}>
                {LEVER_STATUSES.map((s) => <option key={s}>{s}</option>)}
              </select>
            </div>
            <div className="flex flex-wrap items-end gap-1.5">
              {STEPS.map(({ key, label }) => (
                <label key={key} className="flex w-[86px] flex-col text-[10px]" style={{ color: "var(--bt-muted)" }}>
                  {label}
                  <input aria-label={`${label} target`} inputMode="decimal" value={l.steps[key]} placeholder={toText(key, start[key])}
                    onChange={(e) => update(i, { steps: { ...l.steps, [key]: e.target.value } })} className={small} style={inputStyle} />
                </label>
              ))}
              <span className="flex-1" />
              <button type="button" aria-label={`Move fix ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)} className={`${buttonClass} h-8 px-2`} style={buttonStyle}>↑</button>
              <button type="button" aria-label={`Move fix ${i + 1} down`} disabled={i === levers.length - 1} onClick={() => move(i, 1)} className={`${buttonClass} h-8 px-2`} style={buttonStyle}>↓</button>
              <button type="button" aria-label={`Remove fix ${i + 1}`} onClick={() => setLevers((all) => all.filter((_, j) => j !== i))} className={`${buttonClass} h-8 px-2`} style={buttonStyle}>Remove</button>
            </div>
          </div>
        ))}
        <button type="button" className={`${buttonClass} self-start`} style={buttonStyle}
          onClick={() => setLevers((all) => [...all, { id: `fix-${Date.now()}`, name: "", owner: "", status: "Planned", steps: blankSteps() }])}>
          Add a fix
        </button>
      </fieldset>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-xs font-medium" style={{ color: "var(--bt-muted)" }}>Channel goals: messages and offers sent a month</legend>
        {CHANNELS.map((c) => (
          <div key={c} className="grid grid-cols-[110px_64px_80px_1fr] items-center gap-1.5 text-[13px]">
            <span>{c}</span>
            <input aria-label={`${c} goal`} inputMode="decimal" value={channels[c].goal} onChange={(e) => setChannels((all) => ({ ...all, [c]: { ...all[c], goal: e.target.value } }))} className={small} style={inputStyle} />
            <input aria-label={`${c} owner`} value={channels[c].owner} onChange={(e) => setChannels((all) => ({ ...all, [c]: { ...all[c], owner: e.target.value } }))} className={small} style={inputStyle} placeholder="Owner" />
            <input aria-label={`${c} next action`} value={channels[c].action} onChange={(e) => setChannels((all) => ({ ...all, [c]: { ...all[c], action: e.target.value } }))} className={small} style={inputStyle} placeholder="Next action" />
          </div>
        ))}
      </fieldset>
      <ErrorText error={error} />
    </Modal>
  );
}
