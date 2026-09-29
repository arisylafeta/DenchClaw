"use client";

import { useState } from "react";
import type { BulkTrade } from "@/lib/bulk-trades";
import {
  ErrorText,
  FormField,
  Modal,
  buttonClass,
  buttonStyle,
  darkButtonClass,
  darkButtonStyle,
  inputClass,
  inputStyle,
  request,
  tradeUrl,
} from "./trade-ui";

/** Neutral subject for buyers: a trade title can name the seller. */
export const BUYER_SUBJECT = "Battery batch available";

type Props = {
  trade: BulkTrade;
  to: string;
  subject: string;
  body: string;
  buyerId?: string;
  linkTracking: boolean;
  onClose: () => void;
};

/** Makes a Gmail draft in the signed-in user's account. Nothing is sent from DenchClaw. */
export function EmailDialog({ trade, to, subject, body, buyerId, linkTracking, onClose }: Props) {
  const [draft, setDraft] = useState({ to, subject, body });
  const [track, setTrack] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ url: string; tracked_links: number } | null>(null);
  const set = (key: keyof typeof draft) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setDraft((current) => ({ ...current, [key]: event.target.value }));

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      setResult(await request<{ url: string; tracked_links: number }>(tradeUrl(trade.id, "/email-draft"), {
        method: "POST",
        body: JSON.stringify({ ...draft, buyer_id: buyerId, track_links: linkTracking && track }),
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the draft.");
      setSaving(false);
    }
  }

  if (result) {
    return (
      <Modal
        title="Draft ready in Gmail"
        onClose={onClose}
        footer={(
          <>
            <button type="button" className={buttonClass} style={buttonStyle} onClick={onClose}>Close</button>
            <a href={result.url} target="_blank" rel="noreferrer" className={darkButtonClass} style={darkButtonStyle}>Open in Gmail</a>
          </>
        )}
      >
        <p className="text-sm">The draft is in your Gmail drafts. Check it and send it from there.</p>
        {result.tracked_links > 0 && (
          <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>
            {result.tracked_links === 1 ? "1 link is" : `${result.tracked_links} links are`} tracked. Clicks show on this trade.
          </p>
        )}
      </Modal>
    );
  }

  return (
    <Modal
      wide
      title="Email draft"
      onClose={onClose}
      onSubmit={save}
      footer={<button type="submit" disabled={saving} className={darkButtonClass} style={darkButtonStyle}>{saving ? "Creating draft" : "Create Gmail draft"}</button>}
    >
      <FormField label="To"><input value={draft.to} onChange={set("to")} placeholder="name@company.com" className={inputClass} style={inputStyle} /></FormField>
      <FormField label="Subject"><input required value={draft.subject} onChange={set("subject")} className={inputClass} style={inputStyle} /></FormField>
      <FormField label="Message">
        <textarea required autoFocus rows={10} value={draft.body} onChange={set("body")}
          className="w-full rounded-lg border px-3 py-2 text-sm leading-relaxed" style={inputStyle} />
      </FormField>
      {linkTracking && (
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={track} onChange={(event) => setTrack(event.target.checked)} className="accent-[var(--bt-text)]" />
          Track clicks on links in this email
        </label>
      )}
      <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>Saved as a draft in your Gmail. Nothing is sent from here.</p>
      <ErrorText error={error} />
    </Modal>
  );
}
