"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ExternalLink, Mail } from "lucide-react";
import { Button } from "../ui/button";
import { PersonAvatar } from "./person-avatar";
import { CompanyFavicon } from "./company-favicon";
import { CrmEmptyState, CrmLoadingState } from "./crm-list-shell";
import { formatDayLabel, formatRelativeDate } from "./format-relative-date";
import { ProfileThreadList } from "./inbox/profile-thread-list";
import { EventListItem } from "./event-list-item";
import { ActivityTimeline } from "./activity-timeline";
import { EditableTitleHeading } from "./editable-title-heading";

// ---------------------------------------------------------------------------
// API response shape (mirrors apps/web/app/api/crm/people/[id]/route.ts)
// ---------------------------------------------------------------------------

type PersonResponse = {
  person: {
    id: string;
    name: string | null;
    email: string | null;
    company_name: string | null;
    phone: string | null;
    status: string | null;
    source: string | null;
    last_interaction_at: string | null;
    job_title: string | null;
    linkedin_url: string | null;
    avatar_url: string | null;
    notes: string | null;
    created_at: string | null;
    updated_at: string | null;
  };
  company: {
    id: string;
    name: string | null;
    domain: string | null;
    website: string | null;
    industry: string | null;
    type: string | null;
    source: string | null;
  } | null;
  derived_website: string | null;
  threads: Array<{
    id: string;
    subject: string | null;
    last_message_at: string | null;
    message_count: number | null;
    gmail_thread_id: string | null;
    snippet: string | null;
    primary_sender_type: string | null;
    primary_sender_id: string | null;
    primary_sender_name: string | null;
    primary_sender_email: string | null;
    primary_sender_avatar_url: string | null;
  }>;
  events: Array<{
    id: string;
    title: string | null;
    start_at: string | null;
    end_at: string | null;
    meeting_type: string | null;
    google_event_id: string | null;
  }>;
  interactions_summary: {
    email_count: number;
    meeting_count: number;
    total: number;
    last_outbound_at: string | null;
    last_inbound_at: string | null;
  };
  campaigns?: Array<{
    send_id: string;
    campaign_id: string;
    campaign_name: string;
    listing_id: string;
    recipient_email: string;
    listing_title?: string | null;
    listing_url?: string | null;
    state: string;
    pitch_count: number;
    accepted_at: string | null;
    delivered_at: string | null;
    bounced_at: string | null;
    provider_opened_at: string | null;
    provider_link_clicked_at: string | null;
    last_synced_at: string | null;
    links: Array<{
      cta_key: string;
      listing_id: string | null;
      listing_title?: string | null;
      listing_url?: string | null;
      first_clicked_at: string | null;
    }>;
  }>;
  campaign_summary: {
    sent: number;
    delivered: number;
    opened: number;
    clicked: number;
    tracking_pending: number;
  };
  listing_engagement: Array<{
    listing_id: string;
    cta_key: string;
    clicked_updates: number;
    listing_title?: string | null;
    listing_url?: string | null;
  }>;
};

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export type PersonProfileTab = "overview" | "emails" | "calendar" | "activity" | "campaigns" | "notes";

const TABS: ReadonlyArray<{ id: PersonProfileTab; label: string; getCount?: (data: PersonResponse) => number | null }> = [
  { id: "overview", label: "Overview" },
  { id: "emails", label: "Emails", getCount: (d) => d.threads.length },
  { id: "calendar", label: "Meetings", getCount: (d) => d.events.length },
  { id: "activity", label: "Activity", getCount: (d) => d.interactions_summary.total },
  { id: "campaigns", label: "Campaigns", getCount: (d) => d.campaigns?.length ?? 0 },
  { id: "notes", label: "Notes" },
];

function isPersonProfileTab(value: string | undefined): value is PersonProfileTab {
  return value === "overview" || value === "emails" || value === "calendar" || value === "activity" || value === "campaigns" || value === "notes";
}

// ---------------------------------------------------------------------------
// Top-level component
// ---------------------------------------------------------------------------

export function PersonProfile({
  personId,
  activeTab,
  onOpenPerson,
  onOpenCompany,
  onBackToList,
  onTabChange,
}: {
  personId: string;
  activeTab?: string;
  onOpenPerson?: (id: string) => void;
  onOpenCompany?: (id: string) => void;
  onBackToList?: () => void;
  onTabChange?: (tab: PersonProfileTab) => void;
}) {
  const [data, setData] = useState<PersonResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [localTab, setLocalTab] = useState<PersonProfileTab>("overview");
  // Reset the local tab when the parent navigates to a different person.
  // The component is mounted without a `key` upstream, so React reuses
  // this instance on `personId` change — without this guard, person B
  // would inherit person A's selected tab whenever the URL doesn't carry
  // an explicit `profileTab`. Pattern: store the prop alongside the
  // dependent state and reset during render so the first paint of B is
  // already on "overview", with no useEffect-induced flicker.
  // https://react.dev/learn/you-might-not-need-an-effect#resetting-all-state-when-a-prop-changes
  const [previousPersonId, setPreviousPersonId] = useState(personId);
  if (personId !== previousPersonId) {
    setPreviousPersonId(personId);
    setLocalTab("overview");
  }
  const tab = isPersonProfileTab(activeTab) ? activeTab : localTab;

  const handleTabChange = useCallback(
    (nextTab: PersonProfileTab) => {
      setLocalTab(nextTab);
      onTabChange?.(nextTab);
    },
    [onTabChange],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/crm/people/${encodeURIComponent(personId)}`, {
        cache: "no-store",
      });
      if (res.status === 404) {
        setError("Person not found.");
        setData(null);
        return;
      }
      const next = (await res.json().catch(() => null)) as (PersonResponse & { error?: string }) | null;
      if (!res.ok) {
        throw new Error(next?.error ?? `HTTP ${res.status}`);
      }
      if (!next) {
        throw new Error("Failed to parse person response.");
      }
      setData(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load person.");
    } finally {
      setLoading(false);
    }
  }, [personId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Persist a new name when the heading was empty and the user filled it in.
  // We optimistically write the new value to local `data` so the heading,
  // avatar initials, and downstream subtitle copy update immediately —
  // calling `load()` would flicker the entire page through a skeleton state.
  const handleSaveName = useCallback(
    async (newName: string) => {
      const res = await fetch(
        `/api/workspace/objects/people/entries/${encodeURIComponent(personId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fields: { "Full Name": newName } }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setData((prev) =>
        prev ? { ...prev, person: { ...prev.person, name: newName } } : prev,
      );
    },
    [personId],
  );

  // Notes is a single richtext field on the People object — same PATCH
  // surface as `handleSaveName`. Mirroring the optimistic pattern keeps the
  // textarea from re-rendering through a skeleton when the user blurs.
  const handleSaveNotes = useCallback(
    async (next: string) => {
      const res = await fetch(
        `/api/workspace/objects/people/entries/${encodeURIComponent(personId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fields: { Notes: next } }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setData((prev) =>
        prev
          ? {
              ...prev,
              person: {
                ...prev.person,
                notes: next,
                updated_at: new Date().toISOString(),
              },
            }
          : prev,
      );
    },
    [personId],
  );

  if (loading && !data) {
    return (
      <div className="crm-person-profile bulk-trades flex h-full flex-col" style={{ background: "var(--bt-bg)" }}>
        <CrmLoadingState label="Loading profile…" />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="crm-person-profile bulk-trades flex h-full flex-col" style={{ background: "var(--bt-bg)" }}>
        <CrmEmptyState
          title="Couldn't load this contact"
          description={error ?? "The record may have been deleted."}
          cta={
            onBackToList && (
              <Button variant="outline" size="sm" onClick={onBackToList}>
                Back to People
              </Button>
            )
          }
        />
      </div>
    );
  }

  return (
    <div
      className="crm-person-profile bulk-trades flex h-full min-h-0 flex-col"
      style={{ background: "var(--bt-bg)", color: "var(--bt-text)" }}
    >
      <PersonHeader
        data={data}
        tab={tab}
        onTabChange={handleTabChange}
        onOpenCompany={onOpenCompany}
        onBackToList={onBackToList}
        onSaveName={handleSaveName}
      />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="w-full px-4 py-4 sm:px-6">
          {tab === "overview" && (
            <OverviewTab data={data} onOpenCompany={onOpenCompany} />
          )}
          {tab === "emails" && <EmailsTab data={data} onOpenPerson={onOpenPerson} />}
          {tab === "calendar" && (
            <CalendarTab
              data={data}
              onOpenPerson={onOpenPerson}
              onOpenCompany={onOpenCompany}
            />
          )}
          {tab === "activity" && (
            <ActivityTab
              data={data}
              onOpenPerson={onOpenPerson}
              onOpenCompany={onOpenCompany}
            />
          )}
          {tab === "campaigns" && <CampaignsTab data={data} />}
          {tab === "notes" && <NotesTab data={data} onSave={handleSaveNotes} />}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header (sticky)
// ---------------------------------------------------------------------------

function PersonHeader({
  data,
  tab,
  onTabChange,
  onOpenCompany,
  onBackToList,
  onSaveName,
}: {
  data: PersonResponse;
  tab: PersonProfileTab;
  onTabChange: (t: PersonProfileTab) => void;
  onOpenCompany?: (id: string) => void;
  onBackToList?: () => void;
  onSaveName: (newName: string) => Promise<void>;
}) {
  const { person, company, derived_website } = data;
  const displayName = person.name?.trim() || person.email || "Unknown contact";
  const website = company?.website || derived_website;
  const actionClass = "inline-flex h-8 items-center justify-center gap-1.5 rounded-none border px-2.5 text-[12px] font-medium hover:bg-[var(--bt-row-hover)] focus-visible:outline-2 focus-visible:outline-[var(--bt-text)]";
  const actionStyle = { background: "var(--bt-surface)", color: "var(--bt-text)", borderColor: "var(--bt-border)" };

  return (
    <header className="shrink-0 border-b px-4 pt-3 sm:px-6" style={{ borderColor: "var(--bt-border)", background: "var(--bt-surface)" }}>
      {onBackToList && (
        <button type="button" onClick={onBackToList} className="mb-2 inline-flex items-center gap-1 text-[12px] hover:underline" style={{ color: "var(--bt-muted)" }}>
          <ArrowLeft size={13} aria-hidden="true" /> People
        </button>
      )}
      <div className="flex flex-wrap items-start gap-3">
        <PersonAvatar src={person.avatar_url} name={displayName} seed={person.email ?? person.id} size="md" />
        <div className="min-w-0 flex-1">
          <div className="crm-profile-title"><EditableTitleHeading name={person.name} saveName={onSaveName} /></div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]" style={{ color: "var(--bt-text-2)" }}>
            {person.email && <a href={`mailto:${person.email}`} className="truncate hover:underline">{person.email}</a>}
            {person.job_title && <span>{person.job_title}</span>}
            {company && onOpenCompany ? (
              <button type="button" onClick={() => onOpenCompany(company.id)} className="inline-flex items-center gap-1 hover:underline">
                <CompanyFavicon domain={company.domain} name={company.name} size="sm" />{company.name ?? company.domain}
              </button>
            ) : person.company_name ? <span>{person.company_name}</span> : null}
            {person.phone && <a href={`tel:${person.phone}`} className="hover:underline">{person.phone}</a>}
            {website && <a href={website} target="_blank" rel="noreferrer" className="hover:underline">{website.replace(/^https?:\/\//, "")}</a>}
            {person.linkedin_url && <a href={person.linkedin_url} target="_blank" rel="noreferrer" className="hover:underline">LinkedIn</a>}
          </div>
        </div>
        {person.email && (
          <div className="flex shrink-0 items-center gap-2">
            <a href={`mailto:${person.email}`} className={actionClass} style={actionStyle}><Mail size={14} aria-hidden="true" /> Compose email</a>
            <a href={`https://mail.google.com/mail/u/0/#search/${encodeURIComponent("from:" + person.email + " OR to:" + person.email)}`} target="_blank" rel="noreferrer" className={actionClass} style={actionStyle}>
              <ExternalLink size={14} aria-hidden="true" /> Open in Gmail
            </a>
          </div>
        )}
      </div>
      <nav aria-label="Profile sections" className="mt-3 flex items-center gap-1 overflow-x-auto -mb-px">
        {TABS.map((t) => {
          const count = t.getCount?.(data);
          const active = t.id === tab;
          return (
            <button key={t.id} type="button" aria-current={active ? "page" : undefined} onClick={() => onTabChange(t.id)}
              className="flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 py-2 text-[12px] font-medium hover:bg-[var(--bt-row-hover)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--bt-text)]"
              style={{ color: active ? "var(--bt-text)" : "var(--bt-muted)", borderColor: active ? "var(--bt-text)" : "transparent" }}>
              {t.label}
              {typeof count === "number" && count > 0 && <span className="bt-mono px-1 text-[10px]" style={{ background: "var(--bt-divider)", color: "var(--bt-text-2)" }}>{count}</span>}
            </button>
          );
        })}
      </nav>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Tabs — bodies
// ---------------------------------------------------------------------------

const UUID_LABEL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function destinationLabel(title: string | null | undefined, cta: string | undefined, listing: boolean): string {
  if (title?.trim() && !UUID_LABEL.test(title.trim())) { return title.trim(); }
  if (cta && !UUID_LABEL.test(cta)) { return cta.replace(/[-_]+/g, " ").trim() || (listing ? "Listing" : "General destination"); }
  return listing ? "Listing" : "General destination";
}

const campaignDate = new Intl.DateTimeFormat("en-GB", {
  day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
});

function CampaignTime({ value }: { value: string }) {
  const date = new Date(value);
  return <time dateTime={value}>{Number.isNaN(date.getTime()) ? "Unknown date" : campaignDate.format(date)}</time>;
}

function Destination({ label, url }: { label: string; url?: string | null }) {
  return url ? (
    <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-start gap-1 font-medium hover:underline" style={{ color: "var(--bt-link)" }}>
      {label}<ExternalLink size={12} className="mt-0.5 shrink-0" aria-hidden="true" /><span className="sr-only"> (opens in a new tab)</span>
    </a>
  ) : <span className="font-medium">{label}</span>;
}

function CampaignsTab({ data }: { data: PersonResponse }) {
  const campaigns = data.campaigns ?? [];
  const summary = data.campaign_summary;
  const cellStyle = { borderColor: "var(--bt-divider)" };
  const cellClass = "border-b px-3 py-2 text-[12px] align-top";
  return (
    <section aria-label="Campaign engagement" className="space-y-5">
      <div className="space-y-2">
        <h2 className="text-[13px] font-semibold">Across all updates</h2>
        <dl aria-label="Campaign totals" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Sent" value={summary.sent} />
          <Stat label="Delivered" value={`${summary.delivered} of ${summary.sent}`} />
          <Stat label="Opened" value={`${summary.opened} of ${summary.sent}`} />
          <Stat label="Clicked" value={`${summary.clicked} of ${summary.sent}`} />
        </dl>
        <p className="text-[12px]" style={{ color: "var(--bt-muted)" }}>Email activity uses Postmark observations and tracked CTA clicks. Totals count updates, not repeated actions or verified people. Email clicks are not website visits.</p>
        {summary.tracking_pending > 0 && <p role="status" className="text-[12px]" style={{ color: "var(--bt-amber)" }}>Tracking pending for {summary.tracking_pending} sent update{summary.tracking_pending === 1 ? "" : "s"}; missing activity is unknown.</p>}
      </div>
      {data.listing_engagement.length > 0 && (
        <section aria-label="Listing engagement">
          <h2 className="mb-2 text-[13px] font-semibold">Listings clicked across updates</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left" aria-label="Listing engagement">
              <thead style={{ background: "var(--bt-table-head)" }}><tr>
                <th scope="col" className={cellClass} style={cellStyle}>Listing</th><th scope="col" className={cellClass} style={cellStyle}>Updates with email clicks</th>
              </tr></thead>
              <tbody>{data.listing_engagement.map((listing) => <tr key={listing.listing_id} className="hover:bg-[var(--bt-row-hover)]">
                <td className={cellClass} style={cellStyle}><Destination label={destinationLabel(listing.listing_title, listing.cta_key, true)} url={listing.listing_url} /></td>
                <td className={`${cellClass} bt-mono`} style={cellStyle}>{listing.clicked_updates}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </section>
      )}
      <section aria-label="Campaign updates">
        <h2 className="mb-2 text-[13px] font-semibold">Per-update activity</h2>
        {campaigns.length === 0 ? <p className="text-[12px]" style={{ color: "var(--bt-muted)" }}>No campaign updates recorded.</p> : campaigns.map((send) => {
          const accepted = Boolean(send.accepted_at || send.state === "accepted");
          const trackingPending = accepted && !send.last_synced_at;
          const pitchedListing = send.links.find((link) => link.listing_id === send.listing_id);
          const firstEmailClick = send.links.reduce<string | null>((first, link) => {
            const clickedAt = link.first_clicked_at;
            return clickedAt && (!first || clickedAt < first) ? clickedAt : first;
          }, send.provider_link_clicked_at);
          const missingOpen = !accepted ? "Not sent" : trackingPending ? "Open activity unknown — tracking pending" : "No tracked open";
          const missingClick = !accepted ? "Not sent" : trackingPending ? "Click activity unknown — tracking pending" : "No tracked email click";
          return (
            <article key={send.send_id} aria-label={send.campaign_name} className="border-t py-3" style={cellStyle}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
                <h3 className="text-[13px] font-semibold">{send.campaign_name}</h3>
                <span style={{ color: send.bounced_at ? "var(--bt-red)" : "var(--bt-text-2)" }}>{send.bounced_at ? "Bounced" : send.delivered_at ? "Delivered" : accepted ? "Delivery unconfirmed" : send.state.replace(/_/g, " ")}</span>
                {send.accepted_at && <span style={{ color: "var(--bt-muted)" }}>Accepted <CampaignTime value={send.accepted_at} /></span>}
              </div>
              {send.listing_id && <div className="mt-1 text-[12px]"><Destination label={destinationLabel(send.listing_title ?? pitchedListing?.listing_title, pitchedListing?.cta_key, true)} url={send.listing_url ?? pitchedListing?.listing_url} /><span style={{ color: "var(--bt-muted)" }}> · {send.pitch_count} recorded pitch{send.pitch_count === 1 ? "" : "es"}</span></div>}
              <dl className="my-2 grid gap-x-6 gap-y-1 text-[12px] sm:grid-cols-2">
                <div><dt className="inline" style={{ color: "var(--bt-muted)" }}>First tracked open: </dt><dd className="inline">{send.provider_opened_at ? <CampaignTime value={send.provider_opened_at} /> : missingOpen}</dd></div>
                <div><dt className="inline" style={{ color: "var(--bt-muted)" }}>First tracked email click: </dt><dd className="inline">{firstEmailClick ? <CampaignTime value={firstEmailClick} /> : missingClick}</dd></div>
              </dl>
              {send.links.length > 0 && <div className="overflow-x-auto">
                <table aria-label="CTA activity" className="w-full min-w-[440px] text-left">
                  <thead style={{ background: "var(--bt-table-head)" }}><tr>{["Destination", "Type", "First tracked email click"].map((label) => <th key={label} scope="col" className={cellClass} style={cellStyle}>{label}</th>)}</tr></thead>
                  <tbody>{send.links.map((link) => <tr key={link.cta_key} className="hover:bg-[var(--bt-row-hover)]">
                    <td className={cellClass} style={cellStyle}><Destination label={destinationLabel(link.listing_title, link.cta_key, Boolean(link.listing_id))} url={link.listing_url} /></td>
                    <td className={cellClass} style={{ ...cellStyle, color: "var(--bt-muted)" }}>{link.listing_id ? "Listing" : "General CTA"}</td>
                    <td className={cellClass} style={cellStyle}>{link.first_clicked_at ? <CampaignTime value={link.first_clicked_at} /> : !accepted ? "Not sent" : trackingPending ? "Click activity unknown — tracking pending" : "No tracked click"}</td>
                  </tr>)}</tbody>
                </table>
              </div>}
              <details className="mt-2 text-[11px]" style={{ color: "var(--bt-muted)" }}>
                <summary className="w-fit cursor-pointer hover:underline">Details</summary>
                <dl className="mt-2 grid gap-1 break-all">
                  <div><dt className="inline">Campaign ID: </dt><dd className="inline">{send.campaign_id}</dd></div>
                  <div><dt className="inline">Send ID: </dt><dd className="inline">{send.send_id}</dd></div>
                  {send.listing_id && <div><dt className="inline">Listing ID: </dt><dd className="inline">{send.listing_id}</dd></div>}
                  <div><dt className="inline">Recipient: </dt><dd className="inline">{send.recipient_email}</dd></div>
                  <div><dt className="inline">Ledger state: </dt><dd className="inline">{send.state}</dd></div>
                  <div><dt className="inline">Tracking last synced: </dt><dd className="inline">{send.last_synced_at ? <CampaignTime value={send.last_synced_at} /> : "Not recorded"}</dd></div>
                  <div>Postmark open and provider-wide click timestamps are the first observations retained by the email ledger. Destination clicks are first observations for each CTA; they do not identify a website visit.</div>
                  {send.links.map((link) => <div key={link.cta_key}>CTA {link.cta_key}{link.listing_id ? ` · Listing ID: ${link.listing_id}` : ""}</div>)}
                </dl>
              </details>
            </article>
          );
        })}
      </section>
    </section>
  );
}

function OverviewTab({
  data,
  onOpenCompany,
}: {
  data: PersonResponse;
  onOpenCompany?: (id: string) => void;
}) {
  const { person, company, interactions_summary } = data;
  return (
    <div className="space-y-4">
      <section aria-label="At a glance">
        <h2 className="mb-2 text-[13px] font-semibold">At a glance</h2>
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Company" value={person.company_name ?? "—"} />
          <Stat label="Last contact" value={person.last_interaction_at ? formatRelativeDate(person.last_interaction_at) : "—"} />
          <Stat label="Emails" value={interactions_summary.email_count.toLocaleString()} />
          <Stat label="Meetings" value={interactions_summary.meeting_count.toLocaleString()} />
        </dl>
      </section>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <section aria-label="Contact">
          <h2 className="mb-2 text-[13px] font-semibold">Contact</h2>
          <dl className="space-y-2 border p-3" style={{ borderColor: "var(--bt-border)", background: "var(--bt-surface)" }}>
            <Field label="Email" value={person.email} link={person.email ? `mailto:${person.email}` : undefined} />
            <Field label="Phone" value={person.phone} link={person.phone ? `tel:${person.phone}` : undefined} />
            <Field label="LinkedIn" value={person.linkedin_url} link={person.linkedin_url ?? undefined} external />
            <Field label="Job title" value={person.job_title} />
            <Field label="Status" value={person.status} />
            <Field label="Source" value={person.source} />
          </dl>
        </section>
        <div className="space-y-4">
          {company && <section aria-label="Company">
            <h2 className="mb-2 text-[13px] font-semibold">Company</h2>
            <button type="button" onClick={() => onOpenCompany?.(company.id)} disabled={!onOpenCompany}
              className="flex w-full items-center gap-2.5 border p-3 text-left hover:bg-[var(--bt-row-hover)] disabled:cursor-default"
              style={{ borderColor: "var(--bt-border)", background: "var(--bt-surface)" }}>
              <CompanyFavicon domain={company.domain} name={company.name} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{company.name ?? company.domain ?? "Unknown company"}</p>
                {(company.domain || company.industry) && <p className="mt-0.5 text-[12px]" style={{ color: "var(--bt-muted)" }}>{[company.domain, company.industry].filter(Boolean).join(" · ")}</p>}
              </div>
              {onOpenCompany && <ExternalLink size={14} aria-hidden="true" />}
            </button>
          </section>}
          <section aria-label="Saved notes">
            <h2 className="mb-2 text-[13px] font-semibold">Notes</h2>
            <p className="whitespace-pre-wrap break-words border p-3 text-[13px] leading-relaxed" style={{ borderColor: "var(--bt-border)", background: "var(--bt-surface)", color: person.notes ? "var(--bt-text)" : "var(--bt-muted)" }}>{person.notes || "No notes yet. Add context in the Notes tab."}</p>
          </section>
        </div>
      </div>
    </div>
  );
}

function EmailsTab({
  data,
  onOpenPerson,
}: {
  data: PersonResponse;
  onOpenPerson?: (id: string) => void;
}) {
  if (data.threads.length === 0) {
    return (
      <CrmEmptyState
        title="No threads with this contact yet"
        description="Threads appear here as soon as Gmail is connected and the next sync tick runs."
      />
    );
  }
  // ProfileThreadList renders the same Inbox-style row treatment AND
  // expands the conversation reader inline on click — same MessageCard /
  // MessageBody / QuickReply chain the Inbox uses, no external Gmail
  // round-trip required.
  return <ProfileThreadList presentation="compact" threads={data.threads} onOpenPerson={onOpenPerson} />;
}

function CalendarTab({
  data,
  onOpenPerson,
  onOpenCompany,
}: {
  data: PersonResponse;
  onOpenPerson?: (id: string) => void;
  onOpenCompany?: (id: string) => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (data.events.length === 0) {
    return (
      <CrmEmptyState
        title="No meetings with this contact"
        description="Once Calendar is connected and the next sync runs, meetings show up here."
      />
    );
  }
  // Group by day — preserves the API's start_at DESC ordering inside
  // each group, which is what the user expects (most recent on top).
  const groups = new Map<string, typeof data.events>();
  for (const event of data.events) {
    const day = event.start_at ? formatDayLabel(event.start_at) : "Unknown date";
    if (!groups.has(day)) {groups.set(day, []);}
    groups.get(day)!.push(event);
  }
  return (
    <div className="space-y-6">
      {Array.from(groups.entries()).map(([day, events]) => (
        <section key={day}>
          <h3
            className="sticky top-0 z-10 mb-2 border-b py-2 text-[12px] font-semibold"
            style={{ color: "var(--bt-muted)", background: "var(--bt-bg)", borderColor: "var(--bt-divider)" }}
          >
            {day}
          </h3>
          <ul className="space-y-1">
            {events.map((event) => (
              <EventListItem
                key={event.id}
                event={event}
                expanded={expandedId === event.id}
                onToggle={() =>
                  setExpandedId((prev) => (prev === event.id ? null : event.id))
                }
                onOpenPerson={onOpenPerson}
                onOpenCompany={onOpenCompany}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function ActivityTab({
  data,
  onOpenPerson,
  onOpenCompany,
}: {
  data: PersonResponse;
  onOpenPerson?: (id: string) => void;
  onOpenCompany?: (id: string) => void;
}) {
  const summary = data.interactions_summary;
  if (summary.total === 0) {
    return (
      <CrmEmptyState
        title="No activity yet"
        description="Emails and meetings appear here once they're synced."
      />
    );
  }
  // The "Total" stat is the count of raw atomic interaction rows
  // (one per message-per-counterparty + one per attendee-per-meeting),
  // which is intentionally larger than the number of timeline rows
  // shown below — those are de-duplicated to one row per
  // message I exchanged with this person + one row per meeting we
  // both attended. The label below makes that distinction explicit so
  // users don't wonder why "500" doesn't match what they're scrolling.
  return (
    <div className="space-y-4">
      <section className="space-y-2">
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Interactions" value={summary.total.toLocaleString()} />
          <Stat label="Emails" value={summary.email_count.toLocaleString()} />
          <Stat label="Meetings" value={summary.meeting_count.toLocaleString()} />
          <Stat
            label="Last reply"
            value={summary.last_inbound_at ? formatRelativeDate(summary.last_inbound_at) : "—"}
          />
        </dl>
        {summary.last_outbound_at && (
          <div
            className="border-l-2 px-3 py-2 text-[12px]"
            style={{ borderColor: "var(--bt-divider)" }}
          >
            <p style={{ color: "var(--bt-muted)" }}>
              You last reached out{" "}
              <strong style={{ color: "var(--bt-text)" }}>
                {formatRelativeDate(summary.last_outbound_at)}
              </strong>
              .
            </p>
          </div>
        )}
      </section>

      <section>
        <h3
          className="mb-2 text-[13px] font-semibold"
          style={{ color: "var(--bt-text)" }}
        >
          Timeline
        </h3>
        <ActivityTimeline
          presentation="compact"
          personId={data.person.id}
          onOpenPerson={onOpenPerson}
          onOpenCompany={onOpenCompany}
        />
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notes tab — inline autosaving editor
// ---------------------------------------------------------------------------
//
// `Notes` is a single richtext field on the People object. Rather than send
// the user to the workspace detail panel to type one, we render an
// always-visible auto-growing textarea right here. The affordance IS the
// editor — there's no click-to-edit step, no modal.
//
// Save model:
//   - Autosave on blur, but skip the PATCH if the value is unchanged.
//   - Cmd/Ctrl+Enter saves without losing focus (so the user can keep typing).
//   - Escape reverts the draft to the last persisted value.
//   - "Saved · just now" / "Saving…" / red retry button under the editor.
//
// `data.person.notes` and `data.person.updated_at` are the source of truth; we
// sync local editor state whenever the parent reloads the person so we don't
// clobber fresh server state or show stale save timestamps.
function NotesTab({
  data,
  onSave,
}: {
  data: PersonResponse;
  onSave: (next: string) => Promise<void>;
}) {
  const persisted = data.person.notes ?? "";
  const persistedSavedAt = data.person.updated_at;
  const [draft, setDraft] = useState(persisted);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(persistedSavedAt);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Used to short-circuit `commit()` if the value matches what's already
  // saved — prevents a redundant PATCH on every blur.
  const lastSavedRef = useRef(persisted);
  // Track in-flight saves so a blur-fired save and a Cmd+Enter save can't
  // race the optimistic state into the wrong order.
  const savingRef = useRef(false);

  useEffect(() => {
    if (persisted !== lastSavedRef.current) {
      lastSavedRef.current = persisted;
      setDraft(persisted);
    }
    setSavedAt(persistedSavedAt);
  }, [persisted, persistedSavedAt]);

  // Auto-grow: reset to `auto` first so the textarea can shrink, then snap
  // to scrollHeight. Re-runs every time the draft changes.
  const autoGrow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) {return;}
    el.style.height = "auto";
    el.style.height = `${Math.max(el.scrollHeight, 160)}px`;
  }, []);
  useEffect(() => {
    autoGrow();
  }, [draft, autoGrow]);

  const commit = useCallback(
    async (next: string) => {
      if (savingRef.current) {return;}
      if (next === lastSavedRef.current) {return;}
      savingRef.current = true;
      setSaving(true);
      setError(null);
      try {
        await onSave(next);
        lastSavedRef.current = next;
        setSavedAt(new Date().toISOString());
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't save note.");
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [onSave],
  );

  // Re-render the "Saved · 12s ago" line over time without bumping any
  // server state — a 30s tick is plenty granular for the relative buckets
  // formatRelativeDate produces.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!savedAt || saving) {return;}
    const id = window.setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, [savedAt, saving]);

  const firstName = data.person.name?.trim().split(/\s+/)[0] ?? null;
  const placeholder = firstName
    ? `Write a note about ${firstName}…`
    : "Write a note…";

  const dirty = draft !== lastSavedRef.current;

  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-semibold">Notes</h2>
        <span className="text-[11px]" style={{ color: "var(--bt-muted)" }}>Saves on blur · Ctrl/⌘ Enter to save · Escape to revert</span>
      </div>
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          void commit(draft);
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void commit(draft);
          } else if (e.key === "Escape") {
            e.preventDefault();
            setDraft(lastSavedRef.current);
            setError(null);
          }
        }}
        placeholder={placeholder}
        aria-label="Notes"
        className="w-full resize-none rounded-none border px-3 py-3 text-[13px] leading-relaxed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--bt-link)]"
        style={{
          minHeight: 160,
          color: "var(--bt-text)",
          background: "var(--bt-surface)",
          borderColor: "var(--bt-border)",
          fontFamily: "inherit",
        }}
      />
      <div
        className="flex items-center justify-end gap-2 px-1 text-[11px]"
        style={{ color: "var(--bt-muted)" }}
      >
        {error ? (
          <button
            type="button"
            onClick={() => {
              void commit(draft);
            }}
            className="hover:underline"
            style={{ color: "var(--bt-red)" }}
          >
            Couldn&apos;t save — retry
          </button>
        ) : saving ? (
          <span>Saving…</span>
        ) : dirty ? (
          <span style={{ opacity: 0.7 }}>Unsaved changes</span>
        ) : savedAt ? (
          <span>
            Saved
            {" · "}
            {formatRelativeDate(savedAt) || "just now"}
          </span>
        ) : null}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div
      className="border px-3 py-2"
      style={{ borderColor: "var(--bt-divider)", background: "var(--bt-surface)" }}
    >
      <dt className="text-[10px] font-medium uppercase tracking-[0.04em]" style={{ color: "var(--bt-muted)" }}>
        {label}
      </dt>
      <dd className="mt-1 text-[14px] font-semibold" style={{ color: "var(--bt-text)" }}>
        {value}
      </dd>
    </div>
  );
}

function Field({
  label,
  value,
  link,
  external,
}: {
  label: string;
  value: string | null;
  link?: string;
  external?: boolean;
}) {
  if (!value) {
    return (
      <div className="flex items-baseline gap-3 text-[13px]">
        <dt className="w-24 shrink-0" style={{ color: "var(--bt-muted)" }}>
          {label}
        </dt>
        <dd style={{ color: "var(--bt-muted)" }}>—</dd>
      </div>
    );
  }
  const inner = link ? (
    <a
      href={link}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
      className="hover:underline truncate"
      style={{ color: "var(--bt-link)" }}
    >
      {value}
    </a>
  ) : (
    <span className="truncate" style={{ color: "var(--bt-text)" }}>
      {value}
    </span>
  );
  return (
    <div className="flex items-baseline gap-3 text-[13px] min-w-0">
      <dt className="w-24 shrink-0" style={{ color: "var(--bt-muted)" }}>
        {label}
      </dt>
      <dd className="min-w-0">{inner}</dd>
    </div>
  );
}

