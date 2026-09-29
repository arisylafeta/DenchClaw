"use client";

import { useEffect, useState } from "react";
import type { BulkTrade } from "@/lib/bulk-trades";
import {
  BID_UNITS,
  BUYER_STATUSES,
  CURRENCIES,
  bidLabel,
  shortDate,
  teaserText,
  trackingLabel,
  type Buyer,
  type PersonMatch,
  type BuyerStatus,
  type TradeField,
} from "@/lib/bulk-trade-details";
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

const COLUMNS = "grid-cols-[24px_minmax(0,1fr)_110px_150px_100px_90px_110px]";

type Props = {
  trade: BulkTrade;
  buyers: Buyer[];
  fields: TradeField[];
  today: string;
  onBuyer: (buyer: Buyer) => void;
};

export function BuyersTable({ trade, buyers, fields, today, onBuyer }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Buyer | "new" | null>(null);
  const [bidFor, setBidFor] = useState<Buyer | null>(null);
  const [teaser, setTeaser] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bids = buyers.filter((buyer) => buyer.latest_bid).length;

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function changeStatus(buyer: Buyer, status: BuyerStatus) {
    setError(null);
    onBuyer({ ...buyer, status });
    try {
      const saved = await request<{ buyer: Buyer }>(tradeUrl(trade.id, `/buyers/${buyer.id}`), {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      onBuyer(saved.buyer);
    } catch (err) {
      onBuyer(buyer);
      setError(`Could not update ${buyer.name}: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  }

  return (
    <Card label="Buyers" className="self-start overflow-hidden">
      <header className="flex flex-wrap items-center gap-3 border-b px-5 py-4" style={{ borderColor: "var(--bt-column)" }}>
        <h2 className="text-base font-semibold">Buyers</h2>
        <span className="text-[13px]" style={{ color: "var(--bt-muted)" }}>
          {buyers.length} {buyers.length === 1 ? "buyer" : "buyers"} · {bids} {bids === 1 ? "bid" : "bids"}
        </span>
        <span className="flex-1" />
        <button type="button" className={buttonClass} style={buttonStyle} onClick={() => setEditing("new")}>Add buyer</button>
        <button
          type="button"
          className={darkButtonClass}
          style={darkButtonStyle}
          disabled={!selected.size}
          onClick={() => setTeaser(true)}
        >
          Send teaser to selected
        </button>
      </header>

      <div className="overflow-x-auto">
        <div className="min-w-[760px]">
          <div
            className={`grid ${COLUMNS} gap-3.5 border-b px-5 py-2.5 text-xs font-semibold`}
            style={{ color: "var(--bt-muted)", background: "var(--bt-table-head)", borderColor: "var(--bt-column)" }}
          >
            <span /><span>Buyer</span><span>Wants</span><span>Status</span><span>Last touch</span><span>Chase on</span><span>Bid</span>
          </div>
          {buyers.map((buyer) => (
            <div key={buyer.id} className={`grid ${COLUMNS} items-center gap-3.5 border-b px-5 py-3.5 text-sm`} style={{ borderColor: "var(--bt-column)" }}>
              <input
                type="checkbox"
                aria-label={`Select ${buyer.name}`}
                checked={selected.has(buyer.id)}
                onChange={() => toggle(buyer.id)}
                className="h-[18px] w-[18px] accent-[var(--bt-text)]"
              />
              <button type="button" className="min-w-0 text-left" onClick={() => setEditing(buyer)}>
                <div className="truncate font-semibold hover:underline">{buyer.name}</div>
                {buyer.contact && <div className="mt-0.5 truncate text-xs" style={{ color: "var(--bt-muted)" }}>{buyer.contact}</div>}
                <TrackingLine buyer={buyer} />
              </button>
              <span className="text-[13px]" style={{ color: "var(--bt-text-2)" }}>{buyer.wants ?? "—"}</span>
              <select
                aria-label={`Status for ${buyer.name}`}
                value={buyer.status}
                onChange={(event) => changeStatus(buyer, event.target.value as BuyerStatus)}
                className="h-[34px] rounded-lg border px-1.5 text-[13px]"
                style={inputStyle}
              >
                {BUYER_STATUSES.map((status) => <option key={status}>{status}</option>)}
              </select>
              <span className="text-[13px]" style={{ color: "var(--bt-text-2)" }}>
                {buyer.last_touch_on
                  ? [buyer.last_touch_via, shortDate(buyer.last_touch_on)].filter(Boolean).join(" · ")
                  : "—"}
              </span>
              <span
                className="text-[13px]"
                style={{ color: buyer.chase_on && buyer.chase_on <= today ? "var(--bt-red)" : "var(--bt-muted)" }}
              >
                {buyer.chase_on ? shortDate(buyer.chase_on) : "—"}
              </span>
              {buyer.latest_bid ? (
                <button
                  type="button"
                  onClick={() => setBidFor(buyer)}
                  title="Add a newer bid"
                  className="bt-mono h-[34px] truncate rounded-lg border px-2 text-[13px] font-medium"
                  style={{ borderColor: "var(--bt-border)" }}
                >
                  {bidLabel(buyer.latest_bid)}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setBidFor(buyer)}
                  className="h-[34px] rounded-lg border border-dashed text-[13px]"
                  style={{ borderColor: "var(--bt-dashed)", color: "var(--bt-muted)", background: "var(--bt-surface)" }}
                >
                  Add bid
                </button>
              )}
            </div>
          ))}
          {!buyers.length && (
            <p className="px-5 py-6 text-sm" style={{ color: "var(--bt-muted)" }}>No buyers yet. Add the first one to start tracking outreach.</p>
          )}
        </div>
      </div>
      <div className="px-5 py-2"><ErrorText error={error} /></div>

      {editing && (
        <BuyerDialog
          trade={trade}
          buyer={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(buyer) => { onBuyer(buyer); setEditing(null); }}
        />
      )}
      {bidFor && (
        <BidDialog trade={trade} buyer={bidFor} onClose={() => setBidFor(null)} onSaved={(buyer) => { onBuyer(buyer); setBidFor(null); }} />
      )}
      {teaser && (
        <TeaserDialog
          trade={trade}
          fields={fields}
          buyers={buyers.filter((buyer) => selected.has(buyer.id))}
          onClose={() => setTeaser(false)}
          onMarked={(saved) => { saved.forEach(onBuyer); setSelected(new Set()); setTeaser(false); }}
        />
      )}
    </Card>
  );
}

function BuyerDialog({ trade, buyer, onClose, onSaved }: {
  trade: BulkTrade;
  buyer: Buyer | null;
  onClose: () => void;
  onSaved: (buyer: Buyer) => void;
}) {
  const [person, setPerson] = useState<{ id: string; label: string } | null>(
    buyer?.person_id ? { id: buyer.person_id, label: buyer.person_email ?? "Linked CRM person" } : null,
  );
  const [draft, setDraft] = useState({
    name: buyer?.name ?? "", contact: buyer?.contact ?? "", wants: buyer?.wants ?? "",
    last_touch_on: buyer?.last_touch_on ?? "", last_touch_via: buyer?.last_touch_via ?? "", chase_on: buyer?.chase_on ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (key: keyof typeof draft) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setDraft((current) => ({ ...current, [key]: event.target.value }));

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const body = JSON.stringify({ ...draft, person_id: person?.id ?? null });
    try {
      const saved = buyer
        ? await request<{ buyer: Buyer }>(tradeUrl(trade.id, `/buyers/${buyer.id}`), { method: "PATCH", body })
        : await request<{ buyer: Buyer }>(tradeUrl(trade.id, "/buyers"), { method: "POST", body });
      onSaved(saved.buyer);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
      setSaving(false);
    }
  }

  return (
    <Modal
      title={buyer ? buyer.name : "Add buyer"}
      onClose={onClose}
      onSubmit={save}
      footer={<button type="submit" disabled={saving} className={darkButtonClass} style={darkButtonStyle}>{buyer ? "Save" : "Add buyer"}</button>}
    >
      <FormField label="Buyer"><input required value={draft.name} onChange={set("name")} className={inputClass} style={inputStyle} /></FormField>
      <FormField label="Contact"><input value={draft.contact} onChange={set("contact")} className={inputClass} style={inputStyle} /></FormField>
      <PersonPicker
        person={person}
        onPick={(match) => {
          setPerson(match && { id: match.id, label: [match.name, match.email].filter(Boolean).join(" · ") });
          if (match && !draft.contact) setDraft((current) => ({ ...current, contact: match.name }));
        }}
      />
      <FormField label="Wants"><input value={draft.wants} onChange={set("wants")} placeholder="36-pack pilot" className={inputClass} style={inputStyle} /></FormField>
      <div className="grid grid-cols-3 gap-3">
        <FormField label="Last touch"><input type="date" value={draft.last_touch_on} onChange={set("last_touch_on")} className={inputClass} style={inputStyle} /></FormField>
        <FormField label="Via"><input value={draft.last_touch_via} onChange={set("last_touch_via")} placeholder="Call" className={inputClass} style={inputStyle} /></FormField>
        <FormField label="Chase on"><input type="date" value={draft.chase_on} onChange={set("chase_on")} className={inputClass} style={inputStyle} /></FormField>
      </div>
      <ErrorText error={error} />
    </Modal>
  );
}

function BidDialog({ trade, buyer, onClose, onSaved }: {
  trade: BulkTrade;
  buyer: Buyer;
  onClose: () => void;
  onSaved: (buyer: Buyer) => void;
}) {
  const last = buyer.latest_bid;
  const [draft, setDraft] = useState({
    amount: "", unit: last?.unit ?? "kWh", currency: last?.currency ?? "EUR", firmness: "indicative",
    delivery_terms: last?.delivery_terms ?? "", payment_terms: last?.payment_terms ?? "", expires_on: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (key: keyof typeof draft) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setDraft((current) => ({ ...current, [key]: event.target.value }));

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const saved = await request<{ buyer: Buyer }>(tradeUrl(trade.id, `/buyers/${buyer.id}/bids`), {
        method: "POST",
        body: JSON.stringify(draft),
      });
      onSaved(saved.buyer);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
      setSaving(false);
    }
  }

  const select = (key: keyof typeof draft, options: readonly string[], labels: Record<string, string> = {}) => (
    <select value={draft[key]} onChange={set(key)} className={inputClass} style={inputStyle}>
      {options.map((option) => <option key={option} value={option}>{labels[option] ?? option}</option>)}
    </select>
  );

  return (
    <Modal
      title={`Bid from ${buyer.name}`}
      onClose={onClose}
      onSubmit={save}
      footer={<button type="submit" disabled={saving} className={darkButtonClass} style={darkButtonStyle}>Save bid</button>}
    >
      {last && <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>Latest: {bidLabel(last)}. A new bid is added; earlier bids stay in the log.</p>}
      <div className="grid grid-cols-[1fr_90px_110px] gap-3">
        <FormField label="Amount">
          <input required type="number" min="0" step="any" inputMode="decimal" value={draft.amount} onChange={set("amount")} className={inputClass} style={inputStyle} />
        </FormField>
        <FormField label="Currency">{select("currency", CURRENCIES)}</FormField>
        <FormField label="Per">{select("unit", BID_UNITS)}</FormField>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Firm or indicative">{select("firmness", ["indicative", "firm"], { indicative: "Indicative", firm: "Firm" })}</FormField>
        <FormField label="Expires"><input type="date" value={draft.expires_on} onChange={set("expires_on")} className={inputClass} style={inputStyle} /></FormField>
        <FormField label="Delivery terms"><input value={draft.delivery_terms} onChange={set("delivery_terms")} placeholder="EXW Turin" className={inputClass} style={inputStyle} /></FormField>
        <FormField label="Payment terms"><input value={draft.payment_terms} onChange={set("payment_terms")} placeholder="30% deposit" className={inputClass} style={inputStyle} /></FormField>
      </div>
      <ErrorText error={error} />
    </Modal>
  );
}

/** Shows the teaser draft. Nothing is sent from here; buyers move to "Teaser sent" only on confirm. */
function TeaserDialog({ trade, fields, buyers, onClose, onMarked }: {
  trade: BulkTrade;
  fields: TradeField[];
  buyers: Buyer[];
  onClose: () => void;
  onMarked: (buyers: Buyer[]) => void;
}) {
  const [text, setText] = useState(() => teaserText(trade, fields));
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setError("Copy failed. Select the text and copy it by hand.");
    }
  }

  async function markSent() {
    setSaving(true);
    setError(null);
    try {
      const saved = await Promise.all(buyers.map((buyer) =>
        request<{ buyer: Buyer }>(tradeUrl(trade.id, `/buyers/${buyer.id}`), {
          method: "PATCH",
          body: JSON.stringify({ status: "Teaser sent" }),
        }).then((result) => result.buyer)));
      onMarked(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update buyers.");
      setSaving(false);
    }
  }

  return (
    <Modal
      wide
      title="Teaser draft"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className={buttonClass} style={buttonStyle} onClick={copy}>{copied ? "Copied" : "Copy text"}</button>
          <button type="button" disabled={saving} className={darkButtonClass} style={darkButtonStyle} onClick={markSent}>
            Mark {buyers.length} as Teaser sent
          </button>
        </>
      )}
    >
      <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>
        For {buyers.map((buyer) => buyer.name).join(", ")}. Uses only data marked Teaser, never price, location or the seller.
        Nothing is sent from here: send it yourself, then mark the buyers.
      </p>
      <textarea
        aria-label="Teaser text"
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={12}
        className="w-full rounded-lg border px-3 py-2 text-sm leading-relaxed"
        style={inputStyle}
      />
      <ErrorText error={error} />
    </Modal>
  );
}

const TRACKING_TONE = {
  red: "var(--bt-red)",
  green: "var(--bt-green)",
  grey: "var(--bt-muted)",
} as const;

function TrackingLine({ buyer }: { buyer: Buyer }) {
  const tracking = buyer.email_tracking;
  const label = tracking && trackingLabel(tracking);
  if (!label) return null;
  return (
    <div className="mt-0.5 truncate text-xs font-medium" style={{ color: TRACKING_TONE[label.tone] }} title={tracking!.campaign ?? undefined}>
      Teaser email: {label.label}
    </div>
  );
}

/** Links a buyer to a CRM person so campaign emails to them show on this trade. */
function PersonPicker({ person, onPick }: {
  person: { id: string; label: string } | null;
  onPick: (match: PersonMatch | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<PersonMatch[]>([]);

  useEffect(() => {
    if (query.trim().length < 2) return setMatches([]);
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
