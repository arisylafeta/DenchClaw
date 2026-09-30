"use client";

import { useState } from "react";
import { BASIS_LABEL, CHECK_LABEL, checkReason, priceLabel, specLines, volumeLabel, type Demand } from "@/lib/bulk-demand";
import {
  BUYER_CAPABILITIES,
  BUYER_FIELD_NAMES,
  BUYER_OWNERS,
  BUYER_STAGES,
  BUYER_TIERS,
  STANDARD_TERMS,
  changeLabel,
  stageToSuggest,
  type BuyerEngagement,
  type BuyerProfile,
  type BuyerProfileChange,
} from "@/lib/buyer-profile";
import { Button } from "../ui/button";
import { formatDayLabel, formatRelativeDate } from "./format-relative-date";

export type BuyerData = {
  profile: BuyerProfile;
  engagement: BuyerEngagement | null;
  demand: Demand[];
  changes: BuyerProfileChange[];
};

type Person = { id: string; name: string | null; email: string | null };
type Draft = Record<keyof typeof BUYER_FIELD_NAMES, string | string[]>;

const cardStyle = { borderColor: "var(--color-border)", background: "var(--color-surface)" };
const muted = { color: "var(--color-text-muted)" };
const inputClass = "h-8 w-full rounded-md border px-2 text-[13px]";
const inputStyle = { borderColor: "var(--color-border)", background: "var(--color-background)", color: "var(--color-text)" };

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function toDraft(profile: BuyerProfile): Draft {
  return {
    stage: profile.stage ?? "",
    tier: profile.tier ?? "",
    owner: profile.owner ?? "",
    capabilities: profile.capabilities ?? [],
    can_receive_waste: profile.can_receive_waste === null ? "" : profile.can_receive_waste ? "yes" : "no",
    accepts_standard_terms: profile.accepts_standard_terms ?? "",
    collection: profile.collection ?? "",
    past_issues: profile.past_issues ?? "",
    outreach_notes: profile.outreach_notes ?? "",
    main_contact_id: profile.main_contact_id ?? "",
    next_step: profile.next_step ?? "",
    next_step_on: profile.next_step_on ?? "",
  };
}

/** The value the company entry API stores for one draft field. */
function toValue(key: keyof Draft, value: string | string[]): unknown {
  if (key === "capabilities") return value;
  if (key === "can_receive_waste") return value === "" ? null : value === "yes";
  if (key === "main_contact_id") return value ? [value] : [];
  return (value as string).trim() || null;
}

async function saveFields(companyId: string, fields: Record<string, unknown>) {
  const res = await fetch(`/api/workspace/objects/company/entries/${encodeURIComponent(companyId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
}

/**
 * The Buyer tab: stage (set by hand, with the engagement data's suggestion), who is waiting on a reply, what the
 * company has done with us, its buy-boxes, how we deal with them, the research, and the dated change log.
 */
export function BuyerTab({ companyId, buyer, people, onSaved }: {
  companyId: string;
  buyer: BuyerData;
  people: Person[];
  onSaved: () => void;
}) {
  const { profile, engagement, demand, changes } = buyer;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => toDraft(profile));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const suggestion = engagement ? stageToSuggest(profile.stage, engagement.suggested_stage) : null;

  async function save(fields: Record<string, unknown>) {
    setSaving(true);
    setError(null);
    try {
      await saveFields(companyId, fields);
      setEditing(false);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  function saveDraft() {
    const before = toDraft(profile);
    const fields: Record<string, unknown> = {};
    for (const key of Object.keys(BUYER_FIELD_NAMES) as (keyof Draft)[]) {
      if (JSON.stringify(before[key]) !== JSON.stringify(draft[key])) fields[BUYER_FIELD_NAMES[key]] = toValue(key, draft[key]);
    }
    if (!Object.keys(fields).length) {
      setEditing(false);
      return;
    }
    void save(fields);
  }

  const set = (key: keyof Draft) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setDraft((current) => ({ ...current, [key]: event.target.value }));
  const select = (key: keyof Draft, label: string, options: readonly string[], labels: Record<string, string> = {}) => (
    <label className="flex flex-col gap-1 text-[12px]" style={muted}>
      {label}
      <select aria-label={label} value={draft[key] as string} onChange={set(key)} className={inputClass} style={inputStyle}>
        <option value="">Not set</option>
        {options.map((option) => <option key={option} value={option}>{labels[option] ?? option}</option>)}
      </select>
    </label>
  );
  const text = (key: keyof Draft, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="flex flex-col gap-1 text-[12px]" style={muted}>
      {label}
      <input aria-label={label} value={draft[key] as string} onChange={set(key)} className={inputClass} style={inputStyle} {...props} />
    </label>
  );
  const area = (key: keyof Draft, label: string) => (
    <label className="flex flex-col gap-1 text-[12px]" style={muted}>
      {label}
      <textarea aria-label={label} value={draft[key] as string} onChange={set(key)} rows={3}
        className="w-full rounded-md border px-2 py-1.5 text-[13px]" style={inputStyle} />
    </label>
  );

  const contact = people.find((person) => person.id === profile.main_contact_id);

  return (
    <div className="space-y-4">
      <section aria-label="Buyer stage" className="rounded-2xl border p-4" style={cardStyle}>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-[13px] font-semibold" style={{ color: "var(--color-text)" }}>
            Stage
            <select aria-label="Stage" value={profile.stage ?? ""} disabled={saving}
              onChange={(event) => void save({ [BUYER_FIELD_NAMES.stage]: event.target.value || null })}
              className="h-8 rounded-md border px-2 text-[13px]" style={inputStyle}>
              <option value="">Not set</option>
              {BUYER_STAGES.map((stage) => <option key={stage} value={stage}>{stage}</option>)}
            </select>
          </label>
          {profile.stage_changed_on && <span className="text-[12px]" style={muted}>since {formatDayLabel(profile.stage_changed_on)}</span>}
          {suggestion && (
            <span className="flex items-center gap-2 text-[12px]" style={muted}>
              The data says <strong style={{ color: "var(--color-text)" }}>{suggestion}</strong>
              <Button size="sm" variant="outline" disabled={saving} onClick={() => void save({ [BUYER_FIELD_NAMES.stage]: suggestion })}>
                Set to {suggestion}
              </Button>
            </span>
          )}
        </div>
        {engagement?.waiting_since && (
          <p className="mt-3 rounded-md px-3 py-2 text-[13px]" style={{ background: "var(--color-warning-bg, #fff4e5)", color: "var(--color-warning, #8a5300)" }}>
            Waiting on our reply since {formatRelativeDate(engagement.waiting_since)}.
          </p>
        )}
        {error && <p role="alert" className="mt-2 text-[13px]" style={{ color: "var(--color-error, #b42318)" }}>{error}</p>}
      </section>

      {engagement && (
        <section aria-label="Engagement" className="rounded-2xl border p-4" style={cardStyle}>
          <h3 className="mb-3 text-[14px] font-semibold" style={{ color: "var(--color-text)" }}>With us</h3>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-3">
            <Fact label="Last heard from" value={engagement.last_heard_at ? formatRelativeDate(engagement.last_heard_at) : "Never"} />
            <Fact label="Last emailed them" value={engagement.last_out_at ? formatRelativeDate(engagement.last_out_at) : "Never"} />
            <Fact label="Emails, 90 days" value={`${engagement.emails_in_90d} in · ${engagement.emails_out_90d} out`} />
            <Fact label="Meetings" value={engagement.meetings} />
            <Fact label="Campaign clicks" value={engagement.campaign_clicks} />
            <Fact label="Auctions" value={`${engagement.auction_views} views · ${engagement.auction_offers} offers`} />
            <Fact label="Trades" value={`${engagement.trades_offered} offered · ${engagement.trades_won} won`} />
            <Fact label="Bids" value={engagement.bids} />
            <Fact label="Surveys" value={engagement.surveys} />
          </dl>
          <p className="mt-3 text-[12px]" style={muted}>Email from both mailboxes, calendar and Bulk Trades. WhatsApp is not included.</p>
        </section>
      )}

      <section aria-label="Buy-boxes" className="rounded-2xl border p-4" style={cardStyle}>
        <h3 className="mb-3 text-[14px] font-semibold" style={{ color: "var(--color-text)" }}>Buy-boxes</h3>
        {!demand.length && <p className="text-[13px]" style={muted}>No requests or buy-boxes yet. Add them on the Bulk Trades Demand page.</p>}
        <ul className="space-y-2">
          {demand.map((row) => {
            const check = checkReason(row, today());
            return (
              <li key={row.id} className="rounded-xl border px-3 py-2" style={{ borderColor: "var(--color-border)", opacity: row.status === "closed" ? 0.6 : 1 }}>
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <span className="rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ background: "var(--color-surface-hover)", color: "var(--color-text)" }}>
                    {row.kind === "request" ? "Request" : BASIS_LABEL[row.basis ?? "stated"]}
                  </span>
                  <span className="font-medium" style={{ color: "var(--color-text)" }}>{row.wants}</span>
                  {row.status === "closed" && <span style={muted}>closed</span>}
                  {check && <span className="text-[12px]" style={{ color: "var(--color-warning, #8a5300)" }}>{CHECK_LABEL[check]}</span>}
                </div>
                <div className="mt-1 text-[12px]" style={muted}>
                  {[volumeLabel(row), priceLabel(row) && `max ${priceLabel(row)}`, row.location, ...specLines(row.spec).slice(0, 3),
                    row.kind === "request" && row.needed_by ? `needed by ${formatDayLabel(row.needed_by)}` : null,
                    row.confirmed_on ? `confirmed ${formatDayLabel(row.confirmed_on)}` : row.basis === "estimated" ? "our estimate" : null]
                    .filter(Boolean).join(" · ")}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-label="Buyer profile" className="rounded-2xl border p-4" style={cardStyle}>
        <div className="mb-3 flex items-center gap-2">
          <h3 className="flex-1 text-[14px] font-semibold" style={{ color: "var(--color-text)" }}>How we deal with them</h3>
          {editing ? (
            <>
              <Button size="sm" variant="outline" onClick={() => { setDraft(toDraft(profile)); setEditing(false); }}>Cancel</Button>
              <Button size="sm" disabled={saving} onClick={saveDraft}>Save</Button>
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={() => { setDraft(toDraft(profile)); setEditing(true); }}>Edit</Button>
          )}
        </div>
        {editing ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {select("tier", "Tier", BUYER_TIERS)}
            {select("owner", "Owner", BUYER_OWNERS)}
            <label className="flex flex-col gap-1 text-[12px]" style={muted}>
              Main contact
              <select aria-label="Main contact" value={draft.main_contact_id as string} onChange={set("main_contact_id")} className={inputClass} style={inputStyle}>
                <option value="">Not set</option>
                {people.map((person) => <option key={person.id} value={person.id}>{person.name ?? person.email ?? person.id}</option>)}
              </select>
            </label>
            {select("accepts_standard_terms", "Accepts standard terms", STANDARD_TERMS)}
            {select("can_receive_waste", "Can receive waste batteries", ["yes", "no"], { yes: "Yes", no: "No" })}
            {text("collection", "Collection", { placeholder: "e.g. collects with own ADR transport" })}
            <div role="group" aria-label="Capabilities" className="flex flex-col gap-1 text-[12px] sm:col-span-2" style={muted}>
              Capabilities
              <div className="flex flex-wrap gap-1.5">
                {BUYER_CAPABILITIES.map((capability) => {
                  const selected = (draft.capabilities as string[]).includes(capability);
                  return (
                    <button key={capability} type="button" aria-pressed={selected}
                      onClick={() => setDraft((current) => ({
                        ...current,
                        capabilities: selected ? (current.capabilities as string[]).filter((c) => c !== capability) : [...(current.capabilities as string[]), capability],
                      }))}
                      className="h-7 rounded-full border px-2.5 text-[12px]"
                      style={selected ? { background: "var(--color-text)", color: "var(--color-background)", borderColor: "var(--color-text)" } : inputStyle}>
                      {capability}
                    </button>
                  );
                })}
              </div>
            </div>
            {text("next_step", "Next step")}
            {text("next_step_on", "Next step on", { type: "date" })}
            <div className="sm:col-span-2">{area("past_issues", "Past issues")}</div>
            <div className="sm:col-span-2">{area("outreach_notes", "Outreach notes")}</div>
          </div>
        ) : (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2">
            <Fact label="Tier" value={profile.tier} />
            <Fact label="Owner" value={profile.owner} />
            <Fact label="Main contact" value={contact?.name ?? contact?.email ?? null} />
            <Fact label="Accepts standard terms" value={profile.accepts_standard_terms} />
            <Fact label="Can receive waste batteries" value={profile.can_receive_waste === null ? null : profile.can_receive_waste ? "Yes" : "No"} />
            <Fact label="Collection" value={profile.collection} />
            <Fact label="Capabilities" value={profile.capabilities.length ? profile.capabilities.join(", ") : null} />
            <Fact label="Next step" value={profile.next_step ? `${profile.next_step}${profile.next_step_on ? `, ${formatDayLabel(profile.next_step_on)}` : ""}` : null} />
            <Fact label="Past issues" value={profile.past_issues} wide />
            <Fact label="Outreach notes" value={profile.outreach_notes} wide />
          </dl>
        )}
      </section>

      {(profile.category || profile.workstream_status || profile.evidence) && (
        <section aria-label="Research" className="rounded-2xl border p-4" style={cardStyle}>
          <h3 className="mb-3 text-[14px] font-semibold" style={{ color: "var(--color-text)" }}>Research</h3>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2">
            <Fact label="Category" value={profile.category} />
            <Fact label="Status" value={profile.workstream_status} />
            <Fact label="Last reviewed" value={profile.last_reviewed_at ? formatDayLabel(profile.last_reviewed_at) : null} />
            <Fact label="Evidence" value={profile.evidence} wide />
          </dl>
        </section>
      )}

      {!!changes.length && (
        <section aria-label="Profile history" className="rounded-2xl border p-4" style={cardStyle}>
          <h3 className="mb-3 text-[14px] font-semibold" style={{ color: "var(--color-text)" }}>History</h3>
          <ul className="space-y-1 text-[13px]">
            {changes.map((change, index) => (
              <li key={`${change.changed_at}-${change.field}-${index}`} className="flex gap-3">
                <span className="w-20 shrink-0" style={muted}>{formatDayLabel(change.changed_at)}</span>
                <span style={{ color: "var(--color-text)" }}>{changeLabel(change)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Fact({ label, value, wide }: { label: string; value: string | number | null; wide?: boolean }) {
  return (
    <div className={wide ? "sm:col-span-2" : undefined}>
      <dt className="text-[12px]" style={muted}>{label}</dt>
      <dd className="whitespace-pre-wrap" style={{ color: value === null || value === "" ? "var(--color-text-muted)" : "var(--color-text)" }}>
        {value === null || value === "" ? "—" : value}
      </dd>
    </div>
  );
}
