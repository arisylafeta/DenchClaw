"use client";

import { useEffect, useState } from "react";
import type { BulkTrade } from "@/lib/bulk-trades";
import {
  BID_UNITS,
  BUYER_SUBJECT,
  CURRENCIES,
  bidLabel,
  greeting,
  teaserText,
  type Buyer,
  type PersonMatch,
  type TradeField,
} from "@/lib/bulk-trade-details";
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
  useForm,
} from "./trade-ui";

const buyerUrl = (trade: BulkTrade, buyer: Buyer, path = "") => tradeUrl(trade.id, `/buyers/${buyer.id}${path}`);

export function BuyerDialog({ trade, buyer, onClose, onSaved, onEmail }: {
  trade: BulkTrade;
  buyer: Buyer | null;
  onClose: () => void;
  onSaved: (buyer: Buyer) => void;
  onEmail?: () => void;
}) {
  const [person, setPerson] = useState<{ id: string; label: string } | null>(
    buyer?.person_id ? { id: buyer.person_id, label: buyer.person_email ?? "Linked CRM person" } : null,
  );
  const form = useForm({
    name: buyer?.name ?? "", contact: buyer?.contact ?? "", wants: buyer?.wants ?? "",
    last_touch_on: buyer?.last_touch_on ?? "", last_touch_via: buyer?.last_touch_via ?? "", chase_on: buyer?.chase_on ?? "",
  }, async (draft) => {
    const body = JSON.stringify({ ...draft, person_id: person?.id ?? null });
    const saved = buyer
      ? await request<{ buyer: Buyer }>(buyerUrl(trade, buyer), { method: "PATCH", body })
      : await request<{ buyer: Buyer }>(tradeUrl(trade.id, "/buyers"), { method: "POST", body });
    onSaved(saved.buyer);
  });
  const text = form.input;

  return (
    <Modal
      title={buyer ? buyer.name : "Add buyer"}
      onClose={onClose}
      onSubmit={form.submit}
      footer={(
        <>
          {onEmail && <button type="button" onClick={onEmail} className={buttonClass} style={buttonStyle}>Email buyer</button>}
          <button type="submit" disabled={form.saving} className={darkButtonClass} style={darkButtonStyle}>{buyer ? "Save" : "Add buyer"}</button>
        </>
      )}
    >
      <FormField label="Buyer">{text("name", { required: true })}</FormField>
      <FormField label="Contact">{text("contact")}</FormField>
      <PersonPicker
        person={person}
        onPick={(match) => {
          setPerson(match && { id: match.id, label: [match.name, match.email].filter(Boolean).join(" · ") });
          if (match && !form.draft.contact) form.setDraft((current) => ({ ...current, contact: match.name }));
        }}
      />
      <FormField label="Wants">{text("wants", { placeholder: "36-pack pilot" })}</FormField>
      <div className="grid grid-cols-3 gap-3">
        <FormField label="Last touch">{text("last_touch_on", { type: "date" })}</FormField>
        <FormField label="Via">{text("last_touch_via", { placeholder: "Call" })}</FormField>
        <FormField label="Chase on">{text("chase_on", { type: "date" })}</FormField>
      </div>
      <ErrorText error={form.error} />
    </Modal>
  );
}

export function BidDialog({ trade, buyer, onClose, onSaved }: {
  trade: BulkTrade;
  buyer: Buyer;
  onClose: () => void;
  onSaved: (buyer: Buyer) => void;
}) {
  const last = buyer.latest_bid;
  const form = useForm({
    amount: "", unit: last?.unit ?? "kWh", currency: last?.currency ?? "EUR", firmness: "indicative",
    delivery_terms: last?.delivery_terms ?? "", payment_terms: last?.payment_terms ?? "", expires_on: "",
  }, async (draft) => {
    onSaved((await request<{ buyer: Buyer }>(buyerUrl(trade, buyer, "/bids"), { method: "POST", body: JSON.stringify(draft) })).buyer);
  });
  const { input: text, select } = form;

  return (
    <Modal
      title={`Bid from ${buyer.name}`}
      onClose={onClose}
      onSubmit={form.submit}
      footer={<button type="submit" disabled={form.saving} className={darkButtonClass} style={darkButtonStyle}>Save bid</button>}
    >
      {last && <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>Latest: {bidLabel(last)}. A new bid is added; earlier bids stay in the log.</p>}
      <div className="grid grid-cols-[1fr_90px_110px] gap-3">
        <FormField label="Amount">{text("amount", { required: true, type: "number", min: "0", step: "any", inputMode: "decimal" })}</FormField>
        <FormField label="Currency">{select("currency", CURRENCIES)}</FormField>
        <FormField label="Per">{select("unit", BID_UNITS)}</FormField>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Firm or indicative">{select("firmness", ["indicative", "firm"], { indicative: "Indicative", firm: "Firm" })}</FormField>
        <FormField label="Expires">{text("expires_on", { type: "date" })}</FormField>
        <FormField label="Delivery terms">{text("delivery_terms", { placeholder: "EXW Turin" })}</FormField>
        <FormField label="Payment terms">{text("payment_terms", { placeholder: "30% deposit" })}</FormField>
      </div>
      <ErrorText error={form.error} />
    </Modal>
  );
}

/**
 * Teaser draft for the selected buyers. It can make one Gmail draft per buyer with an email;
 * nothing is sent, and buyers move to "Teaser sent" only when Alex confirms.
 */
export function TeaserDialog({ trade, fields, buyers, linkTracking, onClose, onMarked }: {
  trade: BulkTrade;
  fields: TradeField[];
  buyers: Buyer[];
  linkTracking: boolean;
  onClose: () => void;
  onMarked: (buyers: Buyer[]) => void;
}) {
  const [text, setText] = useState(() => teaserText(trade, fields));
  const [copied, setCopied] = useState(false);
  // Buyers whose draft already exists, so a retry after a failure never duplicates one.
  const [drafted, setDrafted] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  const form = useForm({}, async () => {});
  const emailable = buyers.filter((buyer) => buyer.person_email);
  const pending = emailable.filter((buyer) => !drafted.has(buyer.id));

  const copy = () => form.run(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      throw new Error("Copy failed. Select the text and copy it by hand.");
    }
  });

  const createDrafts = () => form.run(async () => {
    for (const buyer of pending) {
      try {
        await request(tradeUrl(trade.id, "/email-draft"), {
          method: "POST",
          body: JSON.stringify({
            to: buyer.person_email, subject: BUYER_SUBJECT,
            body: text.replace(/^Hi,/, greeting(buyer.contact ?? buyer.name)),
            buyer_id: buyer.id, track_links: linkTracking,
          }),
        });
      } catch (err) {
        throw new Error(`${err instanceof Error ? err.message : "Could not create the draft."} Retrying drafts only the ones not yet created.`);
      }
      setDrafted((current) => new Set(current).add(buyer.id));
    }
    setMessage(`${emailable.length} Gmail ${emailable.length === 1 ? "draft" : "drafts"} created. Send them from Gmail, then mark the buyers.`);
  });

  const markSent = () => form.run(async () => {
    onMarked(await Promise.all(buyers.map((buyer) =>
      request<{ buyer: Buyer }>(buyerUrl(trade, buyer), { method: "PATCH", body: JSON.stringify({ status: "Teaser sent" }) })
        .then((result) => result.buyer))));
  });

  const without = buyers.filter((buyer) => !buyer.person_email);
  return (
    <Modal
      wide
      title="Teaser draft"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className={buttonClass} style={buttonStyle} onClick={copy}>{copied ? "Copied" : "Copy text"}</button>
          {!!pending.length && (
            <button type="button" disabled={form.saving} className={buttonClass} style={buttonStyle} onClick={createDrafts}>
              Create {pending.length} Gmail {pending.length === 1 ? "draft" : "drafts"}
            </button>
          )}
          <button type="button" disabled={form.saving} className={darkButtonClass} style={darkButtonStyle} onClick={markSent}>
            Mark {buyers.length} as Teaser sent
          </button>
        </>
      )}
    >
      <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>
        For {buyers.map((buyer) => buyer.name).join(", ")}. Uses only data marked Teaser, never price, location or the seller.
        Nothing is sent from here: send it yourself, then mark the buyers.
      </p>
      <textarea aria-label="Teaser text" value={text} onChange={(event) => setText(event.target.value)} rows={12}
        className="w-full rounded-lg border px-3 py-2 text-sm leading-relaxed" style={inputStyle} />
      {!!without.length && (
        <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>
          No email for {without.map((buyer) => buyer.name).join(", ")}. Link them to a CRM person to draft for them.
        </p>
      )}
      {message && <p role="status" className="text-sm" style={{ color: "var(--bt-green)" }}>{message}</p>}
      <ErrorText error={form.error} />
    </Modal>
  );
}

/** Links a buyer to a CRM person so emails to them can be tracked on this trade. */
function PersonPicker({ person, onPick }: {
  person: { id: string; label: string } | null;
  onPick: (match: PersonMatch | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<PersonMatch[]>([]);

  useEffect(() => {
    if (query.trim().length < 2) {
      setMatches([]);
      return;
    }
    const timer = setTimeout(() => {
      request<{ people: PersonMatch[] }>(`/api/bulk-trades/people?q=${encodeURIComponent(query.trim())}`)
        .then((result) => setMatches(result.people))
        .catch(() => setMatches([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  if (person) {
    return (
      <FormField label="CRM person (for email tracking)">
        <div className="flex h-9 items-center gap-2 rounded-lg border px-2.5 text-sm" style={inputStyle}>
          <span className="flex-1 truncate">{person.label}</span>
          <button type="button" onClick={() => onPick(null)} className="text-xs" style={{ color: "var(--bt-muted)" }}>Unlink</button>
        </div>
      </FormField>
    );
  }
  return (
    <FormField label="CRM person (for email tracking)">
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name, email or company"
        className={inputClass} style={inputStyle} />
      {!!matches.length && (
        <ul role="listbox" aria-label="Matching people" className="max-h-48 overflow-y-auto rounded-lg border" style={{ borderColor: "var(--bt-border)" }}>
          {matches.map((match) => (
            <li key={match.id}>
              <button type="button" role="option" aria-selected="false" onClick={() => onPick(match)}
                className="flex w-full flex-col px-2.5 py-1.5 text-left hover:bg-[var(--bt-row-hover)]">
                <span className="text-sm" style={{ color: "var(--bt-text)" }}>{match.name}{match.company ? `, ${match.company}` : ""}</span>
                <span className="text-xs" style={{ color: "var(--bt-muted)" }}>
                  {match.email ?? "No email"}{match.opted_out ? " · opted out" : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </FormField>
  );
}
