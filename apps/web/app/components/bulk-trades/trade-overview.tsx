"use client";

import { useEffect, useRef, useState } from "react";
import { dueLabel, type BulkTrade, type TradePatch } from "@/lib/bulk-trades";
import {
  firstName,
  greeting,
  isImage,
  missingItems,
  shortDate,
  type Buyer,
  type Contact,
  type TradeDetail,
  type TradeFile,
} from "@/lib/bulk-trade-details";
import { BuyersTable } from "./buyers-table";
import { EmailDialog } from "./email-dialog";
import { FileLink, FileThumb } from "./file-preview";
import {
  Card,
  ErrorText,
  FormField,
  KindPicker,
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
  detail: TradeDetail;
  today: string;
  onTradePatch: (patch: TradePatch) => Promise<void>;
  onBuyer: (buyer: Buyer) => void;
  onContacts: (contacts: Contact[]) => void;
  onProposalDecided: () => void;
};

/** Proposals shown on the Overview; field and file proposals live on Data and files. */
const OVERVIEW_KINDS = new Set(["buyer_update", "new_buyer", "next_step", "needs_triage", "link_contact"]);

/** First contact with an email address, else the first contact. */
function emailContact(contacts: Contact[]) {
  return contacts.find((contact) => contact.email) ?? contacts[0];
}

function addDays(date: string, days: number) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

export function TradeOverview({ detail, today, onTradePatch, onBuyer, onContacts, onProposalDecided }: Props) {
  const { trade, contacts } = detail;
  return (
    <div className="flex flex-col gap-6">
      <NextStepBar trade={trade} contact={emailContact(contacts)} today={today} linkTracking={!!detail.link_tracking} onTradePatch={onTradePatch} />
      <BuyersTable
        trade={trade}
        buyers={detail.buyers}
        fields={detail.fields}
        today={today}
        linkTracking={!!detail.link_tracking}
        proposals={(detail.proposals ?? []).filter((proposal) => OVERVIEW_KINDS.has(proposal.kind))}
        onProposalDecided={onProposalDecided}
        onBuyer={onBuyer}
      />
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
        <MissingCard detail={detail} onTradePatch={onTradePatch} />
        <ShippingCard trade={trade} />
      </div>
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
        <ContactsCard trade={trade} contacts={contacts} onContacts={onContacts} />
        <FilesCard trade={trade} files={detail.files} />
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
  const snoozeMenu = useRef<HTMLDivElement>(null);
  const barButton = "inline-flex h-10 items-center rounded-lg border px-4 text-sm font-medium";

  useEffect(() => {
    if (!snoozing) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !snoozeMenu.current?.contains(event.target as Node)) {
        setSnoozing(false);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [snoozing]);
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
      <div ref={snoozeMenu} className="relative">
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
          body={`${greeting(contact?.name)}\n\n`}
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
  const form = useForm({ next_step: "", next_step_due: addDays(today, 1), waiting_on: "us" }, async (draft) => {
    await onTradePatch({ ...draft, waiting_on: draft.waiting_on as "us" | "them", last_touched: today });
    onClose();
  });

  return (
    <Modal
      title={trade.next_step ? "Done. What's next?" : "Set next step"}
      onClose={onClose}
      onSubmit={form.submit}
      footer={<button type="submit" disabled={form.saving} className={darkButtonClass} style={darkButtonStyle}>Save next step</button>}
    >
      {trade.next_step && <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>Done: {trade.next_step}</p>}
      <FormField label="Next step">{form.textarea("next_step", { required: true, autoFocus: true, rows: 2 })}</FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Due">{form.input("next_step_due", { type: "date" })}</FormField>
        <FormField label="Waiting on">{form.select("waiting_on", ["us", "them"], { us: "Us", them: "Them" })}</FormField>
      </div>
      <ErrorText error={form.error} />
    </Modal>
  );
}

function MissingCard({ detail, onTradePatch }: { detail: TradeDetail; onTradePatch: Props["onTradePatch"] }) {
  const { trade, fields, files, contacts } = detail;
  const contact = emailContact(contacts);
  const [asking, setAsking] = useState(false);
  const items = trade.trade_kind ? missingItems(trade.trade_kind, fields, files) : [];
  const ask = [
    greeting(contact?.name),
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
        <KindPicker label="Pick the trade kind to see what data it needs" onPick={(kind) => void onTradePatch({ trade_kind: kind })} />
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
            {firstName(contact?.name) ? `Ask ${firstName(contact?.name)}` : "Ask"} for all {items.length}
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
  const url = tradeUrl(trade.id, contact ? `/contacts/${contact.id}` : "/contacts");
  const form = useForm({
    name: contact?.name ?? "", company: contact?.company ?? "", email: contact?.email ?? "", phone: contact?.phone ?? "",
  }, async (draft) => {
    onSaved((await request<{ contact: Contact }>(url, { method: contact ? "PATCH" : "POST", body: JSON.stringify(draft) })).contact);
  });
  const remove = () => form.run(async () => {
    await request(url, { method: "DELETE" });
    onSaved(null);
  });

  return (
    <Modal
      title={contact ? contact.name : "Add contact"}
      onClose={onClose}
      onSubmit={form.submit}
      footer={(
        <>
          {contact && <button type="button" disabled={form.saving} onClick={remove} className={buttonClass} style={{ ...buttonStyle, color: "var(--bt-red)" }}>Remove</button>}
          <button type="submit" disabled={form.saving} className={darkButtonClass} style={darkButtonStyle}>{contact ? "Save" : "Add contact"}</button>
        </>
      )}
    >
      <FormField label="Name">{form.input("name", { required: true })}</FormField>
      <FormField label="Company">{form.input("company")}</FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Phone">{form.input("phone", { type: "tel", placeholder: "+39 347 …" })}</FormField>
        <FormField label="Email">{form.input("email", { type: "email" })}</FormField>
      </div>
      <ErrorText error={form.error} />
    </Modal>
  );
}

/** Files at a glance: photos as thumbnails, documents as badges. PDFs and images open in a new tab. */
function FilesCard({ trade, files }: { trade: BulkTrade; files: TradeFile[] }) {
  const photos = files.filter((file) => isImage(file.file_name));
  const documents = files.filter((file) => !isImage(file.file_name));
  return (
    <Card label="Files" className="flex flex-col gap-3 px-5 py-[18px]">
      <div className="flex items-center">
        <h2 className="flex-1 text-base font-semibold">Files</h2>
        <span className="text-xs" style={{ color: "var(--bt-muted)" }}>{files.length} · manage in Data and files</span>
      </div>
      {!!photos.length && (
        <div className="flex flex-wrap gap-2">
          {photos.map((file) => (
            <FileLink key={file.id} trade={trade} file={file} className="rounded-lg hover:opacity-80">
              <FileThumb trade={trade} file={file} size={64} />
              <span className="sr-only">{file.file_name}</span>
            </FileLink>
          ))}
        </div>
      )}
      {documents.map((file) => (
        <FileLink key={file.id} trade={trade} file={file} className="flex min-w-0 items-center gap-2.5 text-sm hover:underline">
          <FileThumb trade={trade} file={file} size={28} />
          <span className="flex-1 truncate">{file.file_name}</span>
          <span className="shrink-0 text-xs" style={{ color: "var(--bt-muted)" }}>{file.file_type}</span>
        </FileLink>
      ))}
      {!files.length && <p className="text-sm" style={{ color: "var(--bt-muted)" }}>No files yet.</p>}
    </Card>
  );
}
