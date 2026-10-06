"use client";

import type { BulkTrade } from "@/lib/bulk-trades";
import { ErrorText, FormField, Modal, buttonClass, buttonStyle, darkButtonClass, darkButtonStyle, useForm } from "./trade-ui";

type Props = {
  trade: Pick<BulkTrade, "title" | "hold_until" | "hold_reason" | "trade_stage">;
  today: string;
  onClose: () => void;
  /** Saves the hold; the caller sends trade_stage "On hold" with these. */
  onSave: (hold: { hold_until: string; hold_reason: string }) => Promise<void>;
};

function addMonths(date: string, months: number) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + months);
  return next.toISOString().slice(0, 10);
}

function tomorrow(date: string) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/** Puts a trade on hold until a date, with the reason it waits; also used to change an existing hold. */
export function HoldDialog({ trade, today, onClose, onSave }: Props) {
  const changing = trade.trade_stage === "On hold";
  const form = useForm({ hold_until: trade.hold_until ?? "", hold_reason: trade.hold_reason ?? "" }, async (draft) => {
    if (!draft.hold_until || draft.hold_until <= today) throw new Error("Pick a resume date after today.");
    if (!draft.hold_reason.trim()) throw new Error("Say why it is on hold.");
    await onSave({ hold_until: draft.hold_until, hold_reason: draft.hold_reason.trim() });
  });
  const pick = (months: number) => form.setDraft((current) => ({ ...current, hold_until: addMonths(today, months) }));

  return (
    <Modal title={changing ? `Change hold: ${trade.title}` : `Put on hold: ${trade.title}`} onClose={onClose} onSubmit={form.submit}
      footer={<>
        <button type="button" onClick={onClose} className={`${buttonClass} h-9`} style={buttonStyle}>Cancel</button>
        <button type="submit" disabled={form.saving} className={`${darkButtonClass} h-9`} style={darkButtonStyle}>
          {changing ? "Save" : "Put on hold"}
        </button>
      </>}>
      <FormField label="Resume on">
        {form.input("hold_until", { type: "date", min: tomorrow(today), required: true })}
        <span className="flex gap-1.5">
          {[1, 3, 6].map((months) => (
            <button key={months} type="button" onClick={() => pick(months)} className={`${buttonClass} h-7 text-xs`} style={buttonStyle}>
              {months} {months === 1 ? "month" : "months"}
            </button>
          ))}
        </span>
      </FormField>
      <FormField label="Why it waits">
        {form.input("hold_reason", { placeholder: "e.g. Batteries can't leave site until removal in March", required: true })}
      </FormField>
      <p className="text-xs" style={{ color: "var(--bt-muted)" }}>
        It leaves the overdue lists and comes back in the 08:05 summary a week before the date. Emails about it are still read.
      </p>
      <ErrorText error={form.error} />
    </Modal>
  );
}
