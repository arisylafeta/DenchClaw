"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CommercialOpportunity, CommercialProfile, CommercialSummary } from "@/lib/crm-postgres/company-profile";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { CompanyFavicon } from "./company-favicon";
import { PersonAvatar } from "./person-avatar";
import { ConnectionStrengthChip } from "./connection-strength-chip";
import { CrmEmptyState, CrmLoadingState } from "./crm-list-shell";
import { formatDayLabel, formatRelativeDate } from "./format-relative-date";
import { ProfileThreadList } from "./inbox/profile-thread-list";
import { EventListItem } from "./event-list-item";
import { EditableTitleHeading } from "./editable-title-heading";

// ---------------------------------------------------------------------------
// API response shape (mirrors apps/web/app/api/crm/companies/[id]/route.ts)
// ---------------------------------------------------------------------------

type CompanyResponse = {
  company: {
    id: string;
    name: string | null;
    domain: string | null;
    website: string | null;
    platform_role: string | null;
    country: string | null;
    city: string | null;
    about: string | null;
    sectors: string[] | null;
    roles: string[] | null;
    industry: string | null;
    type: string | null;
    source: string | null;
    strength_score: number | null;
    strength_label: string;
    strength_color: string;
    last_interaction_at: string | null;
    notes: string | null;
    created_at: string | null;
    updated_at: string | null;
  };
  people: Array<{
    id: string;
    name: string | null;
    email: string | null;
    job_title: string | null;
    strength_score: number | null;
    strength_label: string;
    strength_color: string;
    last_interaction_at: string | null;
    avatar_url: string | null;
  }>;
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
  }>;
  summary: {
    people_count: number;
    thread_count: number;
    event_count: number;
    strongest_contact: string | null;
  };
  commercial: {
    roles: Array<"buyer" | "supplier" | "recycler">;
    profiles: CommercialProfile[];
    opportunities: CommercialOpportunity[];
    summary: CommercialSummary;
  };
};

export type CompanyProfileTab = "overview" | "team" | "profiles" | "opportunities" | "emails" | "meetings";

const TABS: ReadonlyArray<{ id: CompanyProfileTab; label: string; count: (d: CompanyResponse) => number | null }> = [
  { id: "overview", label: "Overview", count: () => null },
  { id: "team", label: "Team", count: (d) => d.summary.people_count },
  { id: "profiles", label: "Profiles", count: (d) => d.commercial.profiles.length },
  { id: "opportunities", label: "Opportunities", count: (d) => d.commercial.opportunities.length },
  { id: "emails", label: "Emails", count: (d) => d.summary.thread_count },
  { id: "meetings", label: "Meetings", count: (d) => d.summary.event_count },
];

function isCompanyProfileTab(value: string | undefined): value is CompanyProfileTab {
  return value === "overview" || value === "team" || value === "profiles" || value === "opportunities" || value === "emails" || value === "meetings";
}

// ---------------------------------------------------------------------------
// Top-level
// ---------------------------------------------------------------------------

export function CompanyProfile({
  companyId,
  activeTab,
  onOpenPerson,
  onOpenCompany,
  onBackToList,
  onTabChange,
}: {
  companyId: string;
  activeTab?: string;
  onOpenPerson?: (id: string) => void;
  onOpenCompany?: (id: string) => void;
  onBackToList?: () => void;
  onTabChange?: (tab: CompanyProfileTab) => void;
}) {
  const [data, setData] = useState<CompanyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [localTab, setLocalTab] = useState<CompanyProfileTab>("overview");
  // Reset the local tab when the parent navigates to a different company.
  // The component is mounted without a `key` upstream, so React reuses
  // this instance on `companyId` change — without this guard, company B
  // would inherit company A's selected tab whenever the URL doesn't carry
  // an explicit `profileTab`. Pattern: store the prop alongside the
  // dependent state and reset during render so the first paint of B is
  // already on "overview", with no useEffect-induced flicker.
  // https://react.dev/learn/you-might-not-need-an-effect#resetting-all-state-when-a-prop-changes
  const [previousCompanyId, setPreviousCompanyId] = useState(companyId);
  if (companyId !== previousCompanyId) {
    setPreviousCompanyId(companyId);
    setLocalTab("overview");
  }
  const tab = isCompanyProfileTab(activeTab) ? activeTab : localTab;

  const handleTabChange = useCallback(
    (nextTab: CompanyProfileTab) => {
      setLocalTab(nextTab);
      onTabChange?.(nextTab);
    },
    [onTabChange],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/crm/companies/${encodeURIComponent(companyId)}`, {
        cache: "no-store",
      });
      if (res.status === 404) {
        setError("Company not found.");
        setData(null);
        return;
      }
      const next = (await res.json().catch(() => null)) as (CompanyResponse & { error?: string }) | null;
      if (!res.ok) {
        throw new Error(next?.error ?? `HTTP ${res.status}`);
      }
      if (!next) {
        throw new Error("Failed to parse company response.");
      }
      setData(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load company.");
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    void load();
  }, [load]);

  // See PersonProfile for the rationale — optimistic local update keeps the
  // header from re-skeletoning during a one-field save.
  const handleSaveName = useCallback(
    async (newName: string) => {
      const res = await fetch(
        `/api/workspace/objects/company/entries/${encodeURIComponent(companyId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fields: { "Company Name": newName } }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setData((prev) =>
        prev ? { ...prev, company: { ...prev.company, name: newName } } : prev,
      );
    },
    [companyId],
  );

  if (loading && !data) {
    return (
      <div className="flex h-full flex-col" style={{ background: "var(--color-background)" }}>
        <CrmLoadingState label="Loading company…" />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="flex h-full flex-col" style={{ background: "var(--color-background)" }}>
        <CrmEmptyState
          title="Couldn't load this company"
          description={error ?? "The record may have been deleted."}
          cta={
            onBackToList && (
              <Button variant="outline" size="sm" onClick={onBackToList}>
                Back to Companies
              </Button>
            )
          }
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ background: "var(--color-background)" }}>
      <CompanyHeader
        data={data}
        tab={tab}
        onTabChange={handleTabChange}
        onBackToList={onBackToList}
        onSaveName={handleSaveName}
      />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className={`mx-auto w-full px-6 py-6 ${tab === "opportunities" ? "max-w-none" : "max-w-4xl"}`}>
          {tab === "overview" && <OverviewTab data={data} />}
          {tab === "team" && <TeamTab data={data} onOpenPerson={onOpenPerson} />}
          {tab === "profiles" && <ProfilesTab data={data} />}
          {tab === "opportunities" && <OpportunitiesTab data={data} />}
          {tab === "emails" && <EmailsTab data={data} onOpenPerson={onOpenPerson} />}
          {tab === "meetings" && (
            <MeetingsTab
              data={data}
              onOpenPerson={onOpenPerson}
              onOpenCompany={onOpenCompany}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function CompanyHeader({
  data,
  tab,
  onTabChange,
  onBackToList,
  onSaveName,
}: {
  data: CompanyResponse;
  tab: CompanyProfileTab;
  onTabChange: (t: CompanyProfileTab) => void;
  onBackToList?: () => void;
  onSaveName: (newName: string) => Promise<void>;
}) {
  const { company } = data;
  return (
    <header
      className="shrink-0 px-6 pt-4 pb-0"
      style={{ borderBottom: "1px solid var(--color-border)", background: "var(--color-background)" }}
    >
      <div className="mb-3 flex items-center gap-2 text-[12px]" style={{ color: "var(--color-text-muted)" }}>
        {onBackToList && (
          <button type="button" onClick={onBackToList} className="inline-flex items-center gap-1 hover:underline">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="m15 18-6-6 6-6" />
            </svg>
            Companies
          </button>
        )}
      </div>
      <div className="flex items-start gap-4">
        <CompanyFavicon domain={company.domain} name={company.name} size="xl" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <EditableTitleHeading name={company.name} saveName={onSaveName} />
            <ConnectionStrengthChip score={company.strength_score} />
          </div>
          <div
            className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]"
            style={{ color: "var(--color-text-muted)" }}
          >
            {company.website && (
              <a href={company.website} target="_blank" rel="noreferrer" className="hover:underline">
                {company.website.replace(/^https?:\/\//, "")}
              </a>
            )}
            {company.industry && <span>{company.industry}</span>}
            {company.type && <span>{company.type}</span>}
          </div>
        </div>
        {/* <div className="flex shrink-0 items-center gap-2">
          <EnrichButton type="company" id={company.id} />
        </div> */}
      </div>
      <div className="mt-5 flex items-center gap-4 -mb-px">
        {TABS.map((t) => {
          const count = t.count(data);
          const active = t.id === tab;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onTabChange(t.id)}
              className="relative flex items-center gap-1.5 px-1 py-2 text-[13px] font-medium transition-colors"
              style={{
                color: active ? "var(--color-text)" : "var(--color-text-muted)",
                borderBottom: active ? "2px solid var(--color-text)" : "2px solid transparent",
              }}
            >
              {t.label}
              {typeof count === "number" && count > 0 && (
                <span
                  className="rounded-full px-1.5 py-0 text-[10px]"
                  style={{ background: "var(--color-surface-hover)", color: "var(--color-text-muted)" }}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function OverviewTab({ data }: { data: CompanyResponse }) {
  const { company, summary, commercial } = data;
  const urgentCount = commercial.summary.urgent_supply_count + commercial.summary.urgent_demand_count;
  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--color-text-muted)" }}>
          At a glance
        </h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="People" value={summary.people_count.toLocaleString()} />
          <Stat label="Threads" value={summary.thread_count.toLocaleString()} />
          <Stat label="Meetings" value={summary.event_count.toLocaleString()} />
          <Stat label="Strength" value={company.strength_label} />
        </div>
      </section>
      <section>
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--color-text-muted)" }}>
          Commercial
        </h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Profiles" value={commercial.summary.active_profile_count.toLocaleString()} />
          <Stat label="Supply" value={commercial.summary.open_supply_count.toLocaleString()} />
          <Stat label="Demand" value={commercial.summary.open_demand_count.toLocaleString()} />
          <Stat label="Urgent" value={urgentCount.toLocaleString()} />
        </div>
        {commercial.roles.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {commercial.roles.map((role) => (
              <span
                key={role}
                className="rounded-full px-2 py-1 text-[11px] font-medium capitalize"
                style={{ background: "var(--color-surface-hover)", color: "var(--color-text-muted)" }}
              >
                {role}
              </span>
            ))}
          </div>
        )}
      </section>
      <section>
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--color-text-muted)" }}>
          Enrichment
        </h3>
        {company.about && (
          <p className="mb-3 text-[13px]" style={{ color: "var(--color-text)" }}>
            {company.about}
          </p>
        )}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Country" value={company.country ?? "—"} />
          <Stat label="City" value={company.city ?? "—"} />
          <Stat label="Sectors" value={company.sectors?.length ?? 0} />
          <Stat label="Roles" value={company.roles?.length ?? 0} />
        </div>
        {company.sectors && company.sectors.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {company.sectors.map((sector) => (
              <span
                key={sector}
                className="rounded-full px-2 py-1 text-[11px] font-medium capitalize"
                style={{ background: "var(--color-surface-hover)", color: "var(--color-text-muted)" }}
              >
                {sector.replace(/_/g, " ")}
              </span>
            ))}
          </div>
        )}
        {company.roles && company.roles.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {company.roles.map((role) => (
              <span
                key={role}
                className="rounded-full px-2 py-1 text-[11px] font-medium capitalize"
                style={{ background: "var(--color-surface-hover)", color: "var(--color-text-muted)" }}
              >
                {role.replace(/_/g, " ")}
              </span>
            ))}
          </div>
        )}
      </section>
      <section>
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--color-text-muted)" }}>
          Details
        </h3>
        <div
          className="space-y-2.5 rounded-2xl border p-4"
          style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
        >
          <Field label="Domain" value={company.domain} />
          <Field
            label="Website"
            value={company.website ? company.website.replace(/^https?:\/\//, "") : null}
            link={company.website ?? undefined}
            external
          />
          <Field label="Country" value={company.country} />
          <Field label="City" value={company.city} />
          <Field label="Industry" value={company.industry} />
          <Field label="Type" value={company.type} />
          <Field label="Sectors" value={joinOrDash(company.sectors ?? [])} />
          <Field label="Platform Role" value={company.platform_role} />
          <Field label="Source" value={company.source} />
          <Field
            label="Last contact"
            value={company.last_interaction_at ? formatRelativeDate(company.last_interaction_at) : null}
          />
        </div>
      </section>
      {summary.strongest_contact && (
        <p className="text-[12px]" style={{ color: "var(--color-text-muted)" }}>
          Strongest contact: <strong style={{ color: "var(--color-text)" }}>{summary.strongest_contact}</strong>
        </p>
      )}
    </div>
  );
}

function profileTypeLabel(profileType: CommercialProfile["profile_type"]): string {
  if (profileType === "buyer_demand") { return "Buyer demand profile"; }
  if (profileType === "seller_supply") { return "Seller supply profile"; }
  return "Recycler intake profile";
}

function joinOrDash(items: string[]): string {
  return items.length > 0 ? items.join(", ") : "—";
}

function ProfilesTab({ data }: { data: CompanyResponse }) {
  if (data.commercial.profiles.length === 0) {
    return <CrmEmptyState title="No commercial profiles yet" />;
  }

  return (
    <div className="space-y-3">
      {data.commercial.profiles.map((profile) => (
        <section key={profile.id} className="rounded-2xl border p-4" style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h3 className="text-[14px] font-semibold" style={{ color: "var(--color-text)" }}>
              {profileTypeLabel(profile.profile_type)}
            </h3>
            <span className="rounded-full px-2 py-0.5 text-[11px] capitalize" style={{ background: "var(--color-surface-hover)", color: "var(--color-text-muted)" }}>
              {profile.status}
            </span>
          </div>
          <div className="space-y-2">
            <Field label="Contact" value={profile.contact_person_name ?? null} />
            <Field label="Chemistry" value={joinOrDash(profile.chemistries)} />
            <Field label="Formats" value={joinOrDash(profile.formats)} />
            <Field label="Applications" value={joinOrDash(profile.previous_applications)} />
            <Field label="Conditions" value={joinOrDash(profile.conditions)} />
            <Field label="Specifics" value={joinOrDash(profile.specific_types)} />
            <Field label="Geography" value={joinOrDash(profile.geographies)} />
            <Field label="SoH floor" value={profile.soh_floor == null ? null : `${profile.soh_floor}%`} />
            <Field
              label="Volume range"
              value={profile.volume_min == null && profile.volume_max == null ? null : `${profile.volume_min ?? "—"} - ${profile.volume_max ?? "—"}`}
            />
            <Field label="Notes" value={profile.notes} />
          </div>
        </section>
      ))}
    </div>
  );
}

function batteryDisplay(opportunity: CommercialOpportunity): string {
  const parts = [
    opportunity.chemistry,
    opportunity.format,
    [opportunity.manufacturer, opportunity.model].filter(Boolean).join(" ") || null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "—";
}

type OpportunityFilterKey = "opportunity_type" | "status" | "urgency" | "source_system";
type OpportunityFilters = Partial<Record<OpportunityFilterKey, string[]>>;

const OPPORTUNITY_FILTERS: ReadonlyArray<{ key: OpportunityFilterKey; label: string; values: string[] }> = [
  { key: "opportunity_type", label: "Type", values: ["supply", "demand"] },
  { key: "status", label: "Status", values: ["open", "matched", "closed", "draft"] },
  { key: "urgency", label: "Urgency", values: ["critical", "high", "medium", "low"] },
  { key: "source_system", label: "Source", values: ["crm", "csv", "supabase", "email"] },
];

function filterLabel(value: string): string {
  return value.replaceAll("_", " ");
}

function opportunitySearchText(opportunity: CommercialOpportunity): string {
  return [
    opportunity.title,
    opportunity.contact_person_name,
    opportunity.opportunity_type,
    opportunity.status,
    opportunity.source_system,
    opportunity.battery_type,
    opportunity.previous_application,
    opportunity.chemistry,
    opportunity.condition,
    opportunity.format,
    opportunity.manufacturer,
    opportunity.model,
    opportunity.specific_type,
    opportunity.location_region,
    opportunity.location_country,
    opportunity.urgency,
    opportunity.notes,
  ].filter(Boolean).join(" ").toLowerCase();
}

function opportunityMatchesFilters(opportunity: CommercialOpportunity, search: string, filters: OpportunityFilters): boolean {
  const query = search.trim().toLowerCase();
  if (query && !opportunitySearchText(opportunity).includes(query)) {
    return false;
  }

  return OPPORTUNITY_FILTERS.every(({ key }) => {
    const values = filters[key];
    return !values || values.length === 0 || values.includes(opportunity[key]);
  });
}

function titleCase(value: string): string {
  return filterLabel(value).replace(/\b\w/g, (char) => char.toUpperCase());
}

function OpportunityFilterDropdown({
  group,
  selectedValues,
  onToggle,
}: {
  group: { key: OpportunityFilterKey; label: string; values: string[] };
  selectedValues: string[];
  onToggle: (key: OpportunityFilterKey, value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const summary = selectedValues.length === 0
    ? "All"
    : selectedValues.length === 1
      ? filterLabel(selectedValues[0])
      : `${selectedValues.length} selected`;

  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="inline-flex h-9 min-w-28 items-center justify-between gap-2 rounded-md border px-3 text-[12px] font-medium capitalize transition-colors"
        style={{
          borderColor: selectedValues.length > 0 ? "var(--color-text)" : "var(--color-border)",
          background: "var(--color-background)",
          color: "var(--color-text)",
        }}
      >
        <span>{group.label}: {summary}</span>
        <span aria-hidden="true" className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>▾</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 z-20 mt-1 min-w-40 rounded-md border p-1 shadow-lg"
          style={{ borderColor: "var(--color-border)", background: "var(--color-background)" }}
        >
          {group.values.map((value) => {
            const active = selectedValues.includes(value);
            return (
              <button
                key={value}
                type="button"
                role="menuitemcheckbox"
                aria-checked={active}
                onClick={() => onToggle(group.key, value)}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] capitalize hover:bg-[var(--color-surface-hover)]"
                style={{ color: "var(--color-text)" }}
              >
                <span aria-hidden="true" className="inline-flex h-3.5 w-3.5 items-center justify-center rounded border text-[10px]" style={{ borderColor: active ? "var(--color-text)" : "var(--color-border)" }}>
                  {active ? "✓" : ""}
                </span>
                {titleCase(value)}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function OpportunitiesTab({ data }: { data: CompanyResponse }) {
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<OpportunityFilters>({});

  const filteredOpportunities = useMemo(
    () => data.commercial.opportunities.filter((opportunity) => opportunityMatchesFilters(opportunity, search, filters)),
    [data.commercial.opportunities, search, filters],
  );

  const hasActiveFilters = search.trim().length > 0 || Object.values(filters).some((values) => values && values.length > 0);

  function toggleFilter(key: OpportunityFilterKey, value: string) {
    setFilters((current) => {
      const selected = current[key] ?? [];
      const next = selected.includes(value)
        ? selected.filter((item) => item !== value)
        : [...selected, value];
      return { ...current, [key]: next.length > 0 ? next : undefined };
    });
  }

  function clearFilters() {
    setSearch("");
    setFilters({});
  }

  if (data.commercial.opportunities.length === 0) {
    return <CrmEmptyState title="No opportunities yet" />;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 border-b pb-3" style={{ borderColor: "var(--color-border)" }}>
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label="Search opportunities"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search opportunities"
            className="max-w-sm"
          />
            {OPPORTUNITY_FILTERS.map((group) => (
              <OpportunityFilterDropdown
                key={group.key}
                group={group}
                selectedValues={filters[group.key] ?? []}
                onToggle={toggleFilter}
              />
            ))}
          </div>
          <div className="flex items-center gap-3 text-[12px]" style={{ color: "var(--color-text-muted)" }}>
            <span>{filteredOpportunities.length} of {data.commercial.opportunities.length} opportunities</span>
            {hasActiveFilters && (
              <Button type="button" variant="ghost" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            )}
          </div>
        </div>
      </div>

      {filteredOpportunities.length === 0 ? (
        <CrmEmptyState title="No opportunities match these filters" />
      ) : (
        <div data-testid="opportunities-table-shell" className="w-full overflow-x-auto">
          <table className="min-w-full text-left text-[13px]">
            <thead>
              <tr style={{ borderBottom: "1px solid var(--color-border)" }}>
                {[
                  "Type",
                  "Title",
                  "Battery",
                  "Qty",
                  "Location",
                  "Urgency",
                  "Deadline",
                ].map((head) => (
                  <th key={head} className="px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--color-text-muted)" }}>
                    {head}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredOpportunities.map((opportunity) => (
                <tr key={opportunity.id} className="hover:bg-[var(--color-surface-hover)]" style={{ borderBottom: "1px solid var(--color-border)" }}>
                  <td className="px-3 py-2 capitalize">{opportunity.opportunity_type}</td>
                  <td className="px-3 py-2" style={{ color: "var(--color-text)" }}>{opportunity.title}</td>
                  <td className="px-3 py-2" style={{ color: "var(--color-text-muted)" }}>{batteryDisplay(opportunity)}</td>
                  <td className="px-3 py-2">{opportunity.quantity ?? "—"}</td>
                  <td className="px-3 py-2">{[opportunity.location_region, opportunity.location_country].filter(Boolean).join(", ") || "—"}</td>
                  <td className="px-3 py-2 capitalize">{opportunity.urgency}</td>
                  <td className="px-3 py-2">{opportunity.deadline_at ? formatRelativeDate(opportunity.deadline_at) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TeamTab({
  data,
  onOpenPerson,
}: {
  data: CompanyResponse;
  onOpenPerson?: (id: string) => void;
}) {
  if (data.people.length === 0) {
    return <CrmEmptyState title="No people at this company yet" />;
  }
  return (
    <ul className="divide-y" style={{ borderTop: "1px solid var(--color-border)", borderBottom: "1px solid var(--color-border)" }}>
      {data.people.map((person) => {
        const displayName = person.name?.trim() || person.email || "Unknown";
        return (
          <li key={person.id}>
            <button
              type="button"
              onClick={() => onOpenPerson?.(person.id)}
              disabled={!onOpenPerson}
              className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-[var(--color-surface-hover)] disabled:cursor-default"
            >
              <PersonAvatar src={person.avatar_url} name={displayName} seed={person.email ?? person.id} size="md" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-medium" style={{ color: "var(--color-text)" }}>
                  {displayName}
                </p>
                <p className="mt-0.5 truncate text-[12px]" style={{ color: "var(--color-text-muted)" }}>
                  {[person.job_title, person.email].filter(Boolean).join(" · ")}
                </p>
              </div>
              <ConnectionStrengthChip score={person.strength_score} size="sm" showLabel={false} />
              <span
                className="text-right text-[11px] shrink-0 w-16"
                style={{ color: "var(--color-text-muted)" }}
              >
                {person.last_interaction_at ? formatRelativeDate(person.last_interaction_at) : ""}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function EmailsTab({
  data,
  onOpenPerson,
}: {
  data: CompanyResponse;
  onOpenPerson?: (id: string) => void;
}) {
  if (data.threads.length === 0) {
    return <CrmEmptyState title="No threads yet" />;
  }
  // Same Inbox-style thread list + inline conversation reader as the
  // Person profile uses.
  return <ProfileThreadList threads={data.threads} onOpenPerson={onOpenPerson} />;
}

function MeetingsTab({
  data,
  onOpenPerson,
  onOpenCompany,
}: {
  data: CompanyResponse;
  onOpenPerson?: (id: string) => void;
  onOpenCompany?: (id: string) => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (data.events.length === 0) {
    return <CrmEmptyState title="No meetings with this company yet" />;
  }
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
            className="sticky top-0 z-10 mb-2 px-1 py-1 text-[11px] font-semibold uppercase tracking-[0.16em]"
            style={{ color: "var(--color-text-muted)", background: "var(--color-background)" }}
          >
            {day}
          </h3>
          <ul className="space-y-2">
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

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div
      className="rounded-2xl border p-3"
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
    >
      <dt className="text-[10px] font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--color-text-muted)" }}>
        {label}
      </dt>
      <dd className="mt-1 text-[14px] font-medium" style={{ color: "var(--color-text)" }}>
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
        <dt className="w-24 shrink-0" style={{ color: "var(--color-text-muted)" }}>
          {label}
        </dt>
        <dd style={{ color: "var(--color-text-muted)" }}>—</dd>
      </div>
    );
  }
  const inner = link ? (
    <a
      href={link}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
      className="hover:underline truncate"
      style={{ color: "var(--color-text)" }}
    >
      {value}
    </a>
  ) : (
    <span className="truncate" style={{ color: "var(--color-text)" }}>
      {value}
    </span>
  );
  return (
    <div className="flex items-baseline gap-3 text-[13px] min-w-0">
      <dt className="w-24 shrink-0" style={{ color: "var(--color-text-muted)" }}>
        {label}
      </dt>
      <dd className="min-w-0">{inner}</dd>
    </div>
  );
}
