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
  request,
  tradeUrl,
  useForm,
} from "./trade-ui";

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
  const [track, setTrack] = useState(true);
  const [result, setResult] = useState<{ url: string; tracked_links: number } | null>(null);
  const form = useForm({ to, subject, body }, async (draft) => {
    setResult(await request<{ url: string; tracked_links: number }>(tradeUrl(trade.id, "/email-draft"), {
      method: "POST",
      body: JSON.stringify({ ...draft, buyer_id: buyerId, track_links: linkTracking && track }),
    }));
  });

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
      onSubmit={form.submit}
      footer={<button type="submit" disabled={form.saving} className={darkButtonClass} style={darkButtonStyle}>{form.saving ? "Creating draft" : "Create Gmail draft"}</button>}
    >
      <FormField label="To">{form.input("to", { placeholder: "name@company.com" })}</FormField>
      <FormField label="Subject">{form.input("subject", { required: true })}</FormField>
      <FormField label="Message">{form.textarea("body", { required: true, autoFocus: true, rows: 10 })}</FormField>
      {linkTracking && (
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={track} onChange={(event) => setTrack(event.target.checked)} className="accent-[var(--bt-text)]" />
          Track clicks on links in this email
        </label>
      )}
      <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>Saved as a draft in your Gmail. Nothing is sent from here.</p>
      <ErrorText error={form.error} />
    </Modal>
  );
}
