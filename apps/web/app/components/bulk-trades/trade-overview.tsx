"use client";

import { useState } from "react";
import { TRADE_KINDS, dueLabel, type BulkTrade, type TradePatch } from "@/lib/bulk-trades";
import {
  missingItems,
  shortDate,
  type Buyer,
  type Contact,
  type TradeDetail,
} from "@/lib/bulk-trade-details";
import { BuyersTable } from "./buyers-table";
import { EmailDialog } from "./email-dialog";
import {
  Card,
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

type Props = {
  detail: TradeDetail;
  today: string;
  onTradePatch: (patch: TradePatch) => Promise<void>;
  onBuyer: (buyer: Buyer) => void;
  onContacts: (contacts: Contact[]) => void;
};

const firstName = (name: string) => name.trim().split(/\s+/)[0];

/** First contact with an email address, else the first contact. */
function emailContact(contacts: Contact[]) {
  return contacts.find((contact) => contact.email) ?? contacts[0];
}

function addDays(date: string, days: number) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

export function TradeOverview({ detail, today, onTradePatch, onBuyer, onContacts }: Props) {
  const { trade, contacts } = detail;
  return (
    <div className="flex flex-col gap-6">
      <NextStepBar trade={trade} contact={emailContact(contacts)} today={today} linkTracking={!!detail.link_tracking} onTradePatch={onTradePatch} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <BuyersTable trade={trade} buyers={detail.buyers} fields={detail.fields} today={today} linkTracking={!!detail.link_tracking} onBuyer={onBuyer} />
        <div className="flex flex-col gap-4 self-start">
          <MissingCard detail={detail} onTradePatch={onTradePatch} />
          <ShippingCard trade={trade} />
          <ContactsCard trade={trade} contacts={contacts} onContacts={onContacts} />
        </div>
      </div>
    </div>
  );
}

function NextStepBar({ trade, contact, today, linkTracking, onTradePatch }: {
  trade: BulkTrade;
  contact: Contact | undefined;
  today: string;
  linkTracking: boolean;
  onTradePatch: Props["onTradePatch"];
}) {
  const [setting, setSetting] = useState(false);
  const [snoozing, setSnoozing] = useState(false);
  const [emailing, setEmailing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const barButton = "inline-flex h-10 items-center rounded-lg border px-4 text-sm font-medium";
  const barButtonStyle = { borderColor: "var(--bt-bar-border)", color: "var(--bt-on-bar)" };

  async function snooze(days: number) {
    setSnoozing(false);
    setError(null);
    try {
      await onTradePatch({ next_step_due: addDays(trade.next_step_due && trade.next_step_due > today ? trade.next_step_due : today, days) });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not snooze.");
    }
  }

  return (
    <section
      aria-label="Next step"
      className="flex flex-wrap items-center gap-4 rounded-[14px] px-5 py-[18px]"
      style={{ background: "var(--bt-bar)", color: "var(--bt-on-bar)" }}
    >
      <div className="min-w-[240px] flex-1">
        <div className="text-xs font-semibold uppercase tracking-[0.04em]" style={{ color: "var(--bt-accent)" }}>
          Next step · {dueLabel(trade, today)}
        </div>
        <div className="mt-1 text-[17px] font-semibold">
          {trade.next_step ?? "No next step. Set one so this trade comes back at the right time."}
        </div>
        <ErrorText error={error} />
      </div>
      <button
        type="button"
        onClick={() => setEmailing(true)}
        className="inline-flex h-10 items-center rounded-lg px-4 text-sm font-semibold hover:bg-[var(--bt-accent-hover)]"
        style={{ background: "var(--bt-accent)", color: "var(--bt-on-accent)" }}
      >
        Email
      </button>
      <button type="button" onClick={() => setSetting(true)} className={`${barButton} text-[13px]`} style={barButtonStyle}>
        {trade.next_step ? "Done, set next" : "Set next step"}
      </button>
      <div className="relative">
        <button
          type="button"
          aria-expanded={snoozing}
          onClick={() => setSnoozing((open) => !open)}
          className="h-10 px-3 text-[13px] font-medium"
          style={{ color: "var(--bt-bar-muted)" }}
        >
          Snooze
        </button>
        {snoozing && (
          <div
            role="menu"
            className="absolute right-0 top-11 z-10 flex w-40 flex-col rounded-lg border py-1 shadow-lg"
            style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)", color: "var(--bt-text)" }}
          >
            {[["Tomorrow", 1], ["In 3 days", 3], ["Next week", 7]].map(([label, days]) => (
              <button key={label} type="button" role="menuitem" onClick={() => snooze(days as number)}
                className="px-3 py-2 text-left text-sm hover:bg-[var(--bt-row-hover)]">
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      {emailing && (
        <EmailDialog
          trade={trade}
          to={contact?.email ?? ""}
          subject={trade.title}
          body={`${contact ? `Hi ${firstName(contact.name)},` : "Hi,"}\n\n`}
          linkTracking={linkTracking}
          onClose={() => setEmailing(false)}
        />
      )}
      {setting && (
        <SetNextDialog trade={trade} today={today} onClose={() => setSetting(false)} onTradePatch={onTradePatch} />
      )}
    </section>
  );
}

function SetNextDialog({ trade, today, onClose, onTradePatch }: {
  trade: BulkTrade;
  today: string;
  onClose: () => void;
  onTradePatch: Props["onTradePatch"];
}) {
  const [draft, setDraft] = useState({ next_step: "", next_step_due: addDays(today, 1), waiting_on: "us" as "us" | "them" });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onTradePatch({ ...draft, last_touched: today });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
      setSaving(false);
    }
  }

  return (
    <Modal
      title={trade.next_step ? "Done. What's next?" : "Set next step"}
      onClose={onClose}
      onSubmit={save}
      footer={<button type="submit" disabled={saving} className={darkButtonClass} style={darkButtonStyle}>Save next step</button>}
    >
      {trade.next_step && (
        <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>Done: {trade.next_step}</p>
      )}
      <FormField label="Next step">
        <textarea required autoFocus rows={2} value={draft.next_step}
          onChange={(event) => setDraft((current) => ({ ...current, next_step: event.target.value }))}
          className="w-full rounded-lg border px-2.5 py-2 text-sm" style={inputStyle} />
      </FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Due">
          <input type="date" value={draft.next_step_due}
            onChange={(event) => setDraft((current) => ({ ...current, next_step_due: event.target.value }))}
            className={inputClass} style={inputStyle} />
        </FormField>
        <FormField label="Waiting on">
          <select value={draft.waiting_on}
            onChange={(event) => setDraft((current) => ({ ...current, waiting_on: event.target.value as "us" | "them" }))}
            className={inputClass} style={inputStyle}>
            <option value="us">Us</option>
            <option value="them">Them</option>
          </select>
        </FormField>
      </div>
      <ErrorText error={error} />
    </Modal>
  );
}

function MissingCard({ detail, onTradePatch }: { detail: TradeDetail; onTradePatch: Props["onTradePatch"] }) {
  const { trade, fields, files, contacts } = detail;
  const contact = emailContact(contacts);
  const [asking, setAsking] = useState(false);
  const items = trade.trade_kind ? missingItems(trade.trade_kind, fields, files) : [];
  const ask = [
    contact ? `Hi ${firstName(contact.name)},` : "Hi,",
    "",
    `For the ${trade.title} batch, could you send:`,
    ...items.map((item) => `- ${item.label}`),
    "",
    "Thanks",
  ].join("\n");

  return (
    <Card label="Missing" className="flex flex-col gap-1 px-5 py-[18px]">
      <div className="mb-1.5 flex items-center">
        <h2 className="flex-1 text-base font-semibold">Missing</h2>
        {!!items.length && <span className="text-xs" style={{ color: "var(--bt-muted)" }}>needed for</span>}
      </div>
      {!trade.trade_kind ? (
        <FormField label="Pick the trade kind to see what data it needs">
          <select defaultValue="" onChange={(event) => { if (event.target.value) void onTradePatch({ trade_kind: event.target.value as BulkTrade["trade_kind"] }); }}
            className={inputClass} style={inputStyle}>
            <option value="" disabled>Choose…</option>
            {TRADE_KINDS.map((kind) => <option key={kind} value={kind}>{kind[0].toUpperCase() + kind.slice(1)}</option>)}
          </select>
        </FormField>
      ) : items.length ? (
        <>
          {items.map((item) => (
            <div key={item.key} className="flex items-center gap-2.5 border-t py-2 text-sm" style={{ borderColor: "var(--bt-divider)" }}>
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: "var(--bt-red)" }} aria-hidden="true" />
              <span className="flex-1">{item.label}</span>
              <span className="text-xs" style={{ color: "var(--bt-muted)" }}>{item.neededFor}</span>
            </div>
          ))}
          <button type="button" onClick={() => setAsking(true)} className={`${buttonClass} mt-2`} style={buttonStyle}>
            {contact ? `Ask ${firstName(contact.name)} for all ${items.length}` : `Ask for all ${items.length}`}
          </button>
          {asking && (
            <EmailDialog trade={trade} to={contact?.email ?? ""} subject={trade.title} body={ask}
              linkTracking={!!detail.link_tracking} onClose={() => setAsking(false)} />
          )}
        </>
      ) : (
        <p className="text-sm" style={{ color: "var(--bt-muted)" }}>Nothing missing.</p>
      )}
    </Card>
  );
}

function ShippingCard({ trade }: { trade: BulkTrade }) {
  const row = (label: string, value: React.ReactNode, color?: string) => (
    <div className="flex justify-between gap-3 text-sm">
      <span style={{ color: "var(--bt-muted)" }}>{label}</span>
      <span className="text-right font-semibold" style={color ? { color } : undefined}>{value}</span>
    </div>
  );
  const tfs = { yes: "Yes", no: "No", unknown: "Unknown" }[trade.tfs_needed];
  return (
    <Card label="Shipping" className="flex flex-col gap-2 px-5 py-[18px]">
      <h2 className="mb-1 text-base font-semibold">Shipping</h2>
      {row("Warehouse clear by", trade.clear_by ? shortDate(trade.clear_by) : "Not set", trade.clear_by ? undefined : "var(--bt-muted)")}
      {row("Ship by", trade.ship_by ? shortDate(trade.ship_by) : "Not set", trade.ship_by ? undefined : "var(--bt-muted)")}
      {row("Transport class", trade.transport_class ?? "Unknown", trade.transport_class ? undefined : "var(--bt-red)")}
      {row("Waste permit (TFS) needed", tfs, trade.tfs_needed === "unknown" ? "var(--bt-amber)" : undefined)}
    </Card>
  );
}

function ContactsCard({ trade, contacts, onContacts }: {
  trade: BulkTrade;
  contacts: Contact[];
  onContacts: (contacts: Contact[]) => void;
}) {
  const [editing, setEditing] = useState<Contact | "new" | null>(null);
  return (
    <Card label="Contacts" className="flex flex-col gap-1.5 px-5 py-[18px]">
      <div className="mb-1 flex items-center">
        <h2 className="flex-1 text-base font-semibold">Contacts</h2>
        <button type="button" onClick={() => setEditing("new")} className="text-[13px] font-medium" style={{ color: "var(--bt-link)" }}>Add</button>
      </div>
      {contacts.map((contact) => (
        <button key={contact.id} type="button" onClick={() => setEditing(contact)} className="text-left text-sm leading-relaxed hover:underline">
          {[contact.name, contact.company].filter(Boolean).join(", ")}
        </button>
      ))}
      {!contacts.length && <p className="text-sm" style={{ color: "var(--bt-muted)" }}>No contacts yet.</p>}
      {editing && (
        <ContactDialog
          trade={trade}
          contact={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            if (editing === "new") onContacts([...contacts, saved!]);
            else if (saved) onContacts(contacts.map((contact) => (contact.id === saved.id ? saved : contact)));
            else onContacts(contacts.filter((contact) => contact.id !== (editing as Contact).id));
            setEditing(null);
          }}
        />
      )}
    </Card>
  );
}

/** onSaved(null) means the contact was removed. */
function ContactDialog({ trade, contact, onClose, onSaved }: {
  trade: BulkTrade;
  contact: Contact | null;
  onClose: () => void;
  onSaved: (contact: Contact | null) => void;
}) {
  const [draft, setDraft] = useState({
    name: contact?.name ?? "", company: contact?.company ?? "", email: contact?.email ?? "", phone: contact?.phone ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (key: keyof typeof draft) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setDraft((current) => ({ ...current, [key]: event.target.value }));

  async function run(action: () => Promise<Contact | null>) {
    setSaving(true);
    setError(null);
    try {
      onSaved(await action());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
      setSaving(false);
    }
  }

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    void run(async () => (contact
      ? (await request<{ contact: Contact }>(tradeUrl(trade.id, `/contacts/${contact.id}`), { method: "PATCH", body: JSON.stringify(draft) })).contact
      : (await request<{ contact: Contact }>(tradeUrl(trade.id, "/contacts"), { method: "POST", body: JSON.stringify(draft) })).contact));
  };

  const remove = () => run(async () => {
    const response = await fetch(tradeUrl(trade.id, `/contacts/${contact!.id}`), { method: "DELETE" });
    if (!response.ok) throw new Error(`Could not remove (${response.status})`);
    return null;
  });

  return (
    <Modal
      title={contact ? contact.name : "Add contact"}
      onClose={onClose}
      onSubmit={save}
      footer={(
        <>
          {contact && <button type="button" disabled={saving} onClick={remove} className={buttonClass} style={{ ...buttonStyle, color: "var(--bt-red)" }}>Remove</button>}
          <button type="submit" disabled={saving} className={darkButtonClass} style={darkButtonStyle}>{contact ? "Save" : "Add contact"}</button>
        </>
      )}
    >
      <FormField label="Name"><input required value={draft.name} onChange={set("name")} className={inputClass} style={inputStyle} /></FormField>
      <FormField label="Company"><input value={draft.company} onChange={set("company")} className={inputClass} style={inputStyle} /></FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Phone"><input type="tel" value={draft.phone} onChange={set("phone")} placeholder="+39 347 …" className={inputClass} style={inputStyle} /></FormField>
        <FormField label="Email"><input type="email" value={draft.email} onChange={set("email")} className={inputClass} style={inputStyle} /></FormField>
      </div>
      <ErrorText error={error} />
    </Modal>
  );
}

