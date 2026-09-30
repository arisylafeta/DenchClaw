"use client";

import { useEffect, useState } from "react";
import type { TradeOwner } from "@/lib/bulk-trades";
import {
  OUTREACH_STEP,
  OUTREACH_WORKING_DAYS,
  ROUTES,
  addDays,
  addWorkingDays,
  type Dismantler,
  type DismantlerPatch,
  type Route,
} from "@/lib/dismantlers";
import type { DismantlerDetail, ImportPlan } from "@/lib/crm-postgres/dismantlers";
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
  useForm,
} from "../bulk-trades/trade-ui";
import { dismantlerUrl } from "./dismantler-ui";

type CompanyMatch = { id: string; name: string; people: number };

function RoutePicker({ value, onChange }: { value: string; onChange: (route: string) => void }) {
  const options: Array<[string, string]> = [...ROUTES.map((route) => [route, route] as [string, string]), ["", "Not sure"]];
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 text-xs font-medium" style={{ color: "var(--bt-muted)" }}>Likely route</legend>
      <div role="group" className="flex self-start border" style={{ borderColor: "var(--bt-border)" }}>
        {options.map(([route, label]) => (
          <button key={label} type="button" aria-pressed={value === route} onClick={() => onChange(route)}
            className="h-8 border-l px-3.5 text-[13px] font-medium first:border-l-0"
            style={value === route
              ? { background: "var(--bt-badge)", color: "var(--bt-on-badge)", borderColor: "var(--bt-border)" }
              : { background: "var(--bt-surface)", color: "var(--bt-text)", borderColor: "var(--bt-border)" }}>
            {label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/** Company search first: every dismantler is a CRM company. */
export function AddDismantlerDialog({ today, onClose, onAdded }: {
  owners: TradeOwner[];
  today: string;
  onClose: () => void;
  onAdded: (d: Dismantler) => void;
}) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<CompanyMatch[]>([]);
  const [company, setCompany] = useState<CompanyMatch | null>(null);
  const form = useForm({ country: "", ebay_username: "", route: "", next_step: "", next_step_due: "" }, async (draft) => {
    const name = query.trim();
    if (!company && !name) throw new Error("Pick a company or type a name.");
    const { dismantler } = await request<{ dismantler: Dismantler }>("/api/dismantlers", {
      method: "POST",
      body: JSON.stringify({ ...(company ? { company_id: company.id } : { name }), ...draft, next_step_due: draft.next_step ? draft.next_step_due || addDays(today, 1) : "" }),
    });
    onAdded(dismantler);
  });

  useEffect(() => {
    const term = query.trim();
    if (company || term.length < 2) { setMatches([]); return; }
    const timer = setTimeout(() => {
      request<{ companies: CompanyMatch[] }>(`/api/bulk-trades/people?q=${encodeURIComponent(term)}`)
        .then((data) => setMatches(data.companies))
        .catch(() => setMatches([]));
    }, 200);
    return () => clearTimeout(timer);
  }, [query, company]);

  const exact = matches.some((match) => match.name.trim().toLowerCase() === query.trim().toLowerCase());
  return (
    <Modal wide title="Add dismantler" onClose={onClose} onSubmit={form.submit}
      footer={<button type="submit" disabled={form.saving} className={darkButtonClass} style={darkButtonStyle}>Add dismantler</button>}>
      <FormField label="Company">
        {company ? (
          <div className="flex items-center gap-2 border px-2.5 py-2 text-sm" style={{ borderColor: "var(--bt-text)" }}>
            <span className="flex-1 font-semibold">{company.name}</span>
            <span className="text-xs" style={{ color: "var(--bt-muted)" }}>Already in the CRM</span>
            <button type="button" onClick={() => setCompany(null)} className="text-xs font-medium hover:underline" style={{ color: "var(--bt-link)" }}>Change</button>
          </div>
        ) : (
          <input type="search" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search CRM companies" className={inputClass} style={inputStyle} />
        )}
      </FormField>
      {!company && query.trim().length >= 2 && (
        <div role="listbox" aria-label="Matching companies" className="-mt-1.5 flex flex-col border" style={{ borderColor: "var(--bt-border)" }}>
          {matches.map((match) => (
            <button key={match.id} type="button" role="option" aria-selected={false} onClick={() => setCompany(match)}
              className="flex items-center gap-2 border-b px-2.5 py-2 text-left text-sm last:border-b-0 hover:bg-[var(--bt-row-hover)]" style={{ borderColor: "var(--bt-divider)" }}>
              <span className="flex-1 font-semibold">{match.name}</span>
              <span className="text-xs" style={{ color: "var(--bt-muted)" }}>In the CRM{match.people ? ` · ${match.people} ${match.people === 1 ? "person" : "people"}` : ""}</span>
            </button>
          ))}
          {!exact && (
            <div className="px-2.5 py-2 text-sm" style={{ color: "var(--bt-link)" }}>
              + Adding creates a new company “{query.trim()}”
            </div>
          )}
        </div>
      )}
      <p className="-mt-1 text-xs" style={{ color: "var(--bt-muted)" }}>Every dismantler is a CRM company. Pick the existing one so emails and people link up.</p>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Country">{form.input("country", { placeholder: "UK" })}</FormField>
        <FormField label="eBay seller name">{form.input("ebay_username")}</FormField>
      </div>
      <RoutePicker value={form.draft.route} onChange={(route) => form.setDraft((current) => ({ ...current, route }))} />
      <div className="grid grid-cols-[1fr_150px] gap-3">
        <FormField label="Next step (optional)">{form.input("next_step", { placeholder: "Send intro email" })}</FormField>
        <FormField label="Due">{form.input("next_step_due", { type: "date" })}</FormField>
      </div>
      <p className="text-xs" style={{ color: "var(--bt-muted)" }}>Starts in Found.</p>
      <ErrorText error={form.error} />
    </Modal>
  );
}

/** Paste a list, see what would happen, then add. Nothing changes until Add. */
export function ImportDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [text, setText] = useState("");
  const [plan, setPlan] = useState<ImportPlan[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(apply: boolean) {
    setBusy(true);
    setError(null);
    try {
      const result = await request<{ plan: ImportPlan[] }>("/api/dismantlers/import", { method: "POST", body: JSON.stringify({ text, apply }) });
      if (apply) onImported(); else setPlan(result.plan);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not import.");
    }
    setBusy(false);
  }

  const adding = plan?.filter((item) => item.action !== "already a dismantler" && !item.error).length ?? 0;
  return (
    <Modal wide title="Import a list" onClose={onClose}
      footer={plan ? (
        <>
          <button type="button" className={buttonClass} style={buttonStyle} onClick={() => setPlan(null)}>Back</button>
          <button type="button" disabled={busy || !adding || plan.some((item) => item.error)} onClick={() => void send(true)} className={darkButtonClass} style={darkButtonStyle}>
            Add {adding} to Found
          </button>
        </>
      ) : (
        <button type="button" disabled={busy || !text.trim()} onClick={() => void send(false)} className={darkButtonClass} style={darkButtonStyle}>Preview</button>
      )}>
      {plan ? (
        <div className="flex max-h-[360px] flex-col overflow-auto border" style={{ borderColor: "var(--bt-border)" }}>
          {plan.map((item) => (
            <div key={item.name} className="flex items-center gap-2 border-b px-3 py-2 text-sm last:border-b-0" style={{ borderColor: "var(--bt-divider)" }}>
              <span className="flex-1">{item.name}</span>
              <span className="text-xs" style={{ color: item.error ? "var(--bt-red)" : "var(--bt-muted)" }}>
                {item.error ?? (item.action === "already a dismantler" ? "Already here, skipped" : item.action === "new company" ? "New CRM company" : "Existing CRM company")}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <FormField label="One dismantler per line: name, country, eBay seller, battery listings">
          <textarea value={text} onChange={(event) => setText(event.target.value)} rows={10} autoFocus
            placeholder={"Prestige Auto Salvage, UK, prestige-auto-salvage, 16\nSoton Car Parts, UK, sotoncarparts, 15"}
            className="w-full border px-2.5 py-2 font-mono text-[13px]" style={inputStyle} />
        </FormField>
      )}
      <p className="text-xs" style={{ color: "var(--bt-muted)" }}>
        Only the name is needed. Pasting from a spreadsheet works too. Each becomes a CRM company, or links the one with that exact name, and starts in Found.
      </p>
      <ErrorText error={error} />
    </Modal>
  );
}

/** Moves a batch to Contacted, waiting on them, with a follow-up date. */
export function OutreachDialog({ batch, today, onClose, onDone }: {
  batch: Dismantler[];
  today: string;
  onClose: () => void;
  onDone: (saved: Dismantler[]) => void;
}) {
  const form = useForm({ next_step: OUTREACH_STEP, next_step_due: addWorkingDays(today, OUTREACH_WORKING_DAYS) }, async (draft) => {
    const { dismantlers } = await request<{ dismantlers: Dismantler[] }>("/api/dismantlers/outreach", {
      method: "POST",
      body: JSON.stringify({ ids: batch.map((d) => d.id), ...draft }),
    });
    onDone(dismantlers);
  });
  return (
    <Modal title={`Start outreach to ${batch.length}`} onClose={onClose} onSubmit={form.submit}
      footer={<button type="submit" disabled={form.saving} className={darkButtonClass} style={darkButtonStyle}>Move {batch.length} to Contacted</button>}>
      <p className="text-sm">
        {batch.slice(0, 5).map((d) => d.name).join(", ")}{batch.length > 5 ? ` and ${batch.length - 5} more` : ""}
      </p>
      <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>
        Send the first message yourself, then move them here. Each gets this follow-up, waiting on them. A reply moves them on; no reply brings them back on the date.
      </p>
      <FormField label="Follow-up">{form.input("next_step", { required: true })}</FormField>
      <FormField label="Follow up on">{form.input("next_step_due", { type: "date", required: true })}</FormField>
      <ErrorText error={form.error} />
    </Modal>
  );
}

export function ParkDialog({ dismantler, onClose, onSave }: {
  dismantler: Dismantler;
  onClose: () => void;
  onSave: (patch: DismantlerPatch) => Promise<void>;
}) {
  const form = useForm({ park_reason: "", revisit_on: "" }, async (draft) => onSave(draft));
  return (
    <Modal title={`Park ${dismantler.name}`} onClose={onClose} onSubmit={form.submit}
      footer={<button type="submit" disabled={form.saving} className={darkButtonClass} style={darkButtonStyle}>Park</button>}>
      <FormField label="Why">{form.input("park_reason", { required: true, autoFocus: true, placeholder: "Not now: busy until spring" })}</FormField>
      <FormField label="Revisit on (optional)">{form.input("revisit_on", { type: "date" })}</FormField>
      <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>It comes back to {dismantler.stage === "Parked" ? dismantler.parked_from ?? "Found" : dismantler.stage} when you bring it back.</p>
      <ErrorText error={form.error} />
    </Modal>
  );
}

export function EditDismantlerDialog({ dismantler: d, owners, onClose, onSave }: {
  dismantler: Dismantler;
  owners: TradeOwner[];
  onClose: () => void;
  onSave: (patch: DismantlerPatch) => Promise<void>;
}) {
  const form = useForm({
    country: d.country ?? "",
    ebay_username: d.ebay_username ?? "",
    ebay_listings: d.ebay_listings == null ? "" : String(d.ebay_listings),
    route: d.route ?? "",
    platform_account_id: d.platform_account_id ?? "",
    owner_user_id: d.owner_user_id ?? "",
    source: d.source ?? "",
    goal: d.goal ? "yes" : "no",
  }, async (draft) => {
    const listings = draft.ebay_listings.trim();
    if (listings && !/^\d+$/.test(listings)) throw new Error("eBay battery listings must be a whole number.");
    await onSave({
      country: draft.country,
      ebay_username: draft.ebay_username,
      ebay_listings: listings ? Number(listings) : null,
      route: (draft.route || null) as Route | null,
      platform_account_id: draft.platform_account_id,
      owner_user_id: draft.owner_user_id || null,
      source: draft.source,
      goal: draft.goal === "yes",
    });
  });
  return (
    <Modal wide title={`Edit ${d.name}`} onClose={onClose} onSubmit={form.submit}
      footer={<button type="submit" disabled={form.saving} className={darkButtonClass} style={darkButtonStyle}>Save</button>}>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Country">{form.input("country")}</FormField>
        <FormField label="Owner">{form.select("owner_user_id", ["", ...owners.map((owner) => owner.id)], Object.fromEntries([["", "Nobody"], ...owners.map((owner) => [owner.id, owner.name])]))}</FormField>
        <FormField label="eBay seller name">{form.input("ebay_username")}</FormField>
        <FormField label="eBay battery listings">{form.input("ebay_listings", { inputMode: "numeric" })}</FormField>
        <FormField label="ReBattery platform account">{form.input("platform_account_id", { placeholder: "Account id, once they have one" })}</FormField>
        <FormField label="Found via">{form.input("source")}</FormField>
      </div>
      <RoutePicker value={form.draft.route} onChange={(route) => form.setDraft((current) => ({ ...current, route }))} />
      <FormField label="Q4 goal dismantler">{form.select("goal", ["no", "yes"], { no: "No", yes: "Yes" })}</FormField>
      <ErrorText error={form.error} />
    </Modal>
  );
}

export function SetNextDialog({ detail, today, onClose, onSave }: {
  detail: DismantlerDetail;
  today: string;
  onClose: () => void;
  onSave: (patch: DismantlerPatch) => Promise<void>;
}) {
  const d = detail.dismantler;
  const form = useForm({ next_step: "", next_step_due: addDays(today, 1), waiting_on: "us", next_step_person_id: d.next_step_person_id ?? "" }, async (draft) => {
    await onSave({ ...draft, waiting_on: draft.waiting_on as "us" | "them", next_step_person_id: draft.next_step_person_id || null });
    onClose();
  });
  return (
    <Modal title={d.next_step ? "Done. What's next?" : "Set next step"} onClose={onClose} onSubmit={form.submit}
      footer={<button type="submit" disabled={form.saving} className={darkButtonClass} style={darkButtonStyle}>Save next step</button>}>
      {d.next_step && <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>Done: {d.next_step}</p>}
      <FormField label="Next step (one action)">{form.textarea("next_step", { required: true, autoFocus: true, rows: 2 })}</FormField>
      <FormField label="For">
        {form.select("next_step_person_id", ["", ...detail.people.map((person) => person.id)],
          Object.fromEntries([["", "No one in particular"], ...detail.people.map((person) => [person.id, person.name])]))}
      </FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Due">{form.input("next_step_due", { type: "date", required: true })}</FormField>
        <FormField label="Waiting on">{form.select("waiting_on", ["us", "them"], { us: "Us", them: "Them" })}</FormField>
      </div>
      <ErrorText error={form.error} />
    </Modal>
  );
}

/** Makes a Gmail draft in the signed-in user's account. Nothing is sent from DenchClaw. */
export function EmailDialog({ dismantler, to, subject, body, onClose }: {
  dismantler: Dismantler;
  to: string;
  subject: string;
  body: string;
  onClose: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const form = useForm({ to, subject, body }, async (draft) => {
    setUrl((await request<{ url: string }>(dismantlerUrl(dismantler.id, "/email-draft"), { method: "POST", body: JSON.stringify(draft) })).url);
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
    <Modal wide title="Email draft" onClose={onClose} onSubmit={form.submit}
      footer={<button type="submit" disabled={form.saving} className={darkButtonClass} style={darkButtonStyle}>{form.saving ? "Creating draft" : "Create Gmail draft"}</button>}>
      <FormField label="To">{form.input("to", { placeholder: "name@company.com" })}</FormField>
      <FormField label="Subject">{form.input("subject", { required: true })}</FormField>
      <FormField label="Message">{form.textarea("body", { required: true, autoFocus: true, rows: 10 })}</FormField>
      <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>Saved as a draft in your Gmail. Nothing is sent from here.</p>
      <ErrorText error={form.error} />
    </Modal>
  );
}
