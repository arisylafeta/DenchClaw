"use client";

import { useState } from "react";
import { draftFor, type FollowUp, type WaitingItem } from "@/lib/marketplace-pulse";
import { ErrorText, FormField, Modal, buttonClass, buttonStyle, darkButtonClass, darkButtonStyle, request, useForm } from "../bulk-trades/trade-ui";

const dateLabel = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" });

/** "in 2 days", "in 5 hours", "expired". */
function untilLabel(iso: string, now = Date.now()): string {
  const hours = Math.round((Date.parse(iso) - now) / 3_600_000);
  if (hours <= 0) return "expired";
  return hours < 48 ? `in ${hours} hour${hours === 1 ? "" : "s"}` : `in ${Math.round(hours / 24)} days`;
}

function sinceLabel(iso: string, now = Date.now()): string {
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000);
  return days < 1 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`;
}

const linkStyle = { color: "var(--bt-link)" };

export function WaitingOnUs({ items }: { items: WaitingItem[] }) {
  return (
    <section aria-label="Waiting on us" className="border" style={{ background: "var(--bt-amber-tint)", borderColor: "var(--bt-amber-border)" }}>
      <div className="flex items-baseline gap-3 border-b px-4 py-3" style={{ borderColor: "var(--bt-amber-border)" }}>
        <h2 className="text-[15px] font-semibold">Waiting on us</h2>
        <span className="text-xs" style={{ color: "var(--bt-muted)" }}>Offers no one has answered, and accepted deals unpaid for over two days</span>
      </div>
      <ul>
        {items.map((item, i) => (
          <li key={i} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-t px-4 py-2 text-[13px] first:border-t-0" style={{ borderColor: "var(--bt-amber-border)" }}>
            <span className="font-medium">{item.buyer}</span>
            <span>{item.text}</span>
            {item.listing_title && (
              item.listing_url
                ? <a href={item.listing_url} target="_blank" rel="noreferrer" style={linkStyle}>{item.listing_title}</a>
                : <span>{item.listing_title}</span>
            )}
            {item.seller && <span style={{ color: "var(--bt-muted)" }}>seller {item.seller}</span>}
            <span className="flex-1" />
            <strong style={{ color: "var(--bt-amber)" }}>
              {item.expires_at ? `Expires ${untilLabel(item.expires_at)}` : `Unpaid since ${sinceLabel(item.at)}`}
            </strong>
          </li>
        ))}
      </ul>
    </section>
  );
}

type FollowUpsProps = {
  list: FollowUp[];
  error: string | null;
  sender: string;
  onOpenPerson: (id: string) => void;
  onChange: (next: FollowUp) => void;
};

export function FollowUps({ list, error, sender, onOpenPerson, onChange }: FollowUpsProps) {
  const [drafting, setDrafting] = useState<FollowUp | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const waiting = list.filter((f) => !f.contacted_since).length;

  async function addToCrm(f: FollowUp) {
    setActionError(null);
    setAdding(f.key);
    try {
      const saved = await request<{ person_id: string; subscribed: boolean }>("/api/marketplace-pulse/buyers", {
        method: "POST", body: JSON.stringify({ email: f.email, name: f.name }),
      });
      onChange({ ...f, person_id: saved.person_id, subscribed: saved.subscribed });
    } catch (err) {
      setActionError(`Could not add ${f.name}: ${err instanceof Error ? err.message : "unknown error"}`);
    }
    setAdding(null);
  }

  return (
    <section aria-label="Follow up" className="border" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
      <div className="flex items-baseline gap-3 border-b px-4 py-3" style={{ borderColor: "var(--bt-divider)" }}>
        <h2 className="text-[15px] font-semibold">Follow up</h2>
        <span className="text-xs" style={{ color: "var(--bt-muted)" }}>
          Buyers who showed intent in the last 30 days without a paid deal · {waiting} not contacted since
        </span>
      </div>
      {error && <p className="px-4 py-3 text-[13px]" style={{ color: "var(--bt-amber)" }}>{error}</p>}
      {actionError && <div className="px-4 pt-3"><ErrorText error={actionError} /></div>}
      {!error && !list.length && <p className="px-4 py-3 text-[13px]">No buyer activity in the last 30 days.</p>}
      {!!list.length && (
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-xs" style={{ color: "var(--bt-muted)", background: "var(--bt-table-head)" }}>
              <th className="px-4 py-2 font-medium">Buyer</th>
              <th className="px-4 py-2 font-medium">Latest</th>
              <th className="px-4 py-2 font-medium">When</th>
              <th className="px-4 py-2 font-medium">Last contact</th>
              <th className="px-4 py-2 font-medium"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {list.map((f) => (
              <tr key={f.key} className="border-t align-top" style={{ borderColor: "var(--bt-divider)" }}>
                <td className="px-4 py-2">
                  {f.person_id ? (
                    <button type="button" onClick={() => onOpenPerson(f.person_id!)} className="font-medium hover:underline" style={linkStyle}>{f.name}</button>
                  ) : <span className="font-medium">{f.name}</span>}
                  {f.email && <div className="text-xs" style={{ color: "var(--bt-muted)" }}>{f.email}</div>}
                </td>
                <td className="px-4 py-2">
                  {f.latest.text}
                  {f.latest.listing_title && (
                    <div className="text-xs">
                      {f.latest.listing_url
                        ? <a href={f.latest.listing_url} target="_blank" rel="noreferrer" style={linkStyle}>{f.latest.listing_title}</a>
                        : f.latest.listing_title}
                    </div>
                  )}
                  {f.more > 0 && <div className="text-xs" style={{ color: "var(--bt-muted)" }}>+{f.more} more in 30 days</div>}
                </td>
                <td className="whitespace-nowrap px-4 py-2">{dateLabel(f.latest.at)}</td>
                <td className="whitespace-nowrap px-4 py-2">
                  {f.contacted_since
                    ? <span style={{ color: "var(--bt-green)" }}>{dateLabel(f.last_contact!)}</span>
                    : <span style={{ color: "var(--bt-amber)" }}>{f.last_contact ? `${dateLabel(f.last_contact)}, before this` : f.person_id ? "Never" : "Not in CRM"}</span>}
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-right">
                  <div className="flex justify-end gap-1.5">
                    {f.email && !f.subscribed && (
                      <button type="button" disabled={adding === f.key} onClick={() => void addToCrm(f)} className={`${buttonClass} h-7`} style={buttonStyle}>
                        {f.person_id ? "Add to supply updates" : "Add to CRM"}
                      </button>
                    )}
                    {f.subscribed && <span className="self-center text-xs" style={{ color: "var(--bt-green)" }}>On supply updates</span>}
                    <button type="button" onClick={() => setDrafting(f)} className={`${buttonClass} h-7`} style={buttonStyle}>Draft email</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {drafting && <DraftDialog followUp={drafting} sender={sender} onClose={() => setDrafting(null)} />}
    </section>
  );
}

/** Makes a Gmail draft in the signed-in user's account. Nothing is sent from DenchClaw. */
function DraftDialog({ followUp, sender, onClose }: { followUp: FollowUp; sender: string; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const form = useForm(draftFor(followUp, sender), async (draft) => {
    setUrl((await request<{ url: string }>("/api/marketplace-pulse/email-draft", { method: "POST", body: JSON.stringify(draft) })).url);
  });
  if (url) {
    return (
      <Modal title="Draft ready in Gmail" onClose={onClose}
        footer={(
          <>
            <button type="button" className={buttonClass} style={buttonStyle} onClick={onClose}>Close</button>
            <a href={url} target="_blank" rel="noreferrer" className={darkButtonClass} style={darkButtonStyle}>Open in Gmail</a>
          </>
        )}>
        <p className="text-sm">The draft is in your Gmail drafts. Check it and send it from there.</p>
      </Modal>
    );
  }
  return (
    <Modal wide title={`Email ${followUp.name}`} onClose={onClose} onSubmit={form.submit}
      footer={<button type="submit" disabled={form.saving} className={darkButtonClass} style={darkButtonStyle}>{form.saving ? "Creating draft" : "Create Gmail draft"}</button>}>
      <FormField label="To">{form.input("to", { placeholder: "name@company.com" })}</FormField>
      <FormField label="Subject">{form.input("subject", { required: true })}</FormField>
      <FormField label="Message">{form.textarea("body", { required: true, autoFocus: true, rows: 12 })}</FormField>
      <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>Saved as a draft in your Gmail. Nothing is sent from here.</p>
      <ErrorText error={form.error} />
    </Modal>
  );
}
