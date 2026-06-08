# CRM Commercial Profiles And Opportunities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a minimal company-centric CRM commercial layer with two new tables, a summary view, and two company profile tabs: Profiles and Opportunities.

**Architecture:** Keep Supabase as the canonical product transaction database and DenchClaw Postgres CRM as the commercial intelligence layer. Store standing commercial intent/capability in `crm_commercial_profiles`, current transaction moments in `crm_commercial_opportunities`, and derive company-level counts, roles, urgency, and status through `crm_company_commercial_summary_v`.

**Tech Stack:** Next.js App Router, React, TypeScript, local Postgres via `queryPg`, SQL migrations in `apps/web/lib/crm-postgres/schema.sql`, Vitest, existing CRM company profile API/UI.

---

## Current Context

The current company profile is a dedicated company aggregate, not a generic object renderer.

Relevant files:

- `apps/web/lib/crm-postgres/schema.sql` owns the CRM Postgres schema.
- `apps/web/lib/crm-postgres/company-profile.ts` loads the Postgres-backed company profile.
- `apps/web/app/api/crm/companies/[id]/route.ts` returns the company profile response.
- `apps/web/app/components/crm/company-profile.tsx` renders the company profile tabs.
- `apps/web/app/components/crm/company-profile.test.tsx` tests profile tab behavior.
- `apps/web/app/api/crm/companies/[id]/route.test.ts` tests the API route.
- `apps/web/lib/workspace-tabs.test.ts` verifies browser-history tab round trips.

Current company profile response:

```ts
{
  company: {...},
  people: [...],
  threads: [...],
  events: [...],
  summary: {
    people_count: number,
    thread_count: number,
    event_count: number,
    strongest_contact: string | null,
  },
}
```

Current tabs:

```ts
type CompanyProfileTab = "overview" | "team" | "emails" | "meetings";
```

Target tabs:

```ts
type CompanyProfileTab = "overview" | "team" | "profiles" | "opportunities" | "emails" | "meetings";
```

---

## Target Data Model

### `crm_commercial_profiles`

Standing commercial knowledge about a company: what it usually buys, supplies, or can process.

```sql
create table if not exists crm_commercial_profiles (
  id text primary key,
  company_id text not null references crm_companies(id) on delete cascade,
  contact_person_id text references crm_people(id) on delete set null,
  profile_type text not null,
  status text not null default 'unverified',
  battery_types text[] not null default '{}',
  previous_applications text[] not null default '{}',
  chemistries text[] not null default '{}',
  conditions text[] not null default '{}',
  formats text[] not null default '{}',
  specific_types text[] not null default '{}',
  soh_floor numeric(5,2),
  volume_min numeric(12,2),
  volume_max numeric(12,2),
  geographies text[] not null default '{}',
  preferred_outcome text,
  notes text,
  source text,
  last_verified_at timestamptz,
  raw_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_commercial_profiles_type_chk check (profile_type in ('buyer_demand', 'seller_supply', 'recycler_intake')),
  constraint crm_commercial_profiles_status_chk check (status in ('active', 'paused', 'unverified', 'archived')),
  constraint crm_commercial_profiles_soh_floor_chk check (soh_floor is null or (soh_floor >= 0 and soh_floor <= 100)),
  constraint crm_commercial_profiles_volume_chk check (
    (volume_min is null or volume_min >= 0)
    and (volume_max is null or volume_max >= 0)
    and (volume_min is null or volume_max is null or volume_min <= volume_max)
  )
);
```

### `crm_commercial_opportunities`

Current actionable supply or demand moments.

```sql
create table if not exists crm_commercial_opportunities (
  id text primary key,
  company_id text not null references crm_companies(id) on delete cascade,
  contact_person_id text references crm_people(id) on delete set null,
  opportunity_type text not null,
  status text not null default 'open',
  source_system text not null default 'crm',
  source_id text,
  title text not null,
  battery_type text,
  previous_application text,
  chemistry text,
  condition text,
  format text,
  manufacturer text,
  model text,
  specific_type text,
  quantity numeric(12,2),
  soh numeric(5,2),
  pack_kwh numeric(12,3),
  location_country text,
  location_region text,
  available_from timestamptz,
  deadline_at timestamptz,
  price_amount numeric(12,2),
  currency text,
  urgency text not null default 'medium',
  priority_score numeric(8,2),
  notes text,
  raw_json jsonb not null default '{}'::jsonb,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_commercial_opportunities_type_chk check (opportunity_type in ('supply', 'demand')),
  constraint crm_commercial_opportunities_status_chk check (status in ('draft', 'open', 'matched', 'closed', 'expired', 'cancelled')),
  constraint crm_commercial_opportunities_source_system_chk check (source_system in ('crm', 'supabase', 'csv', 'email')),
  constraint crm_commercial_opportunities_urgency_chk check (urgency in ('low', 'medium', 'high', 'critical')),
  constraint crm_commercial_opportunities_quantity_chk check (quantity is null or quantity >= 0),
  constraint crm_commercial_opportunities_soh_chk check (soh is null or (soh >= 0 and soh <= 100)),
  constraint crm_commercial_opportunities_pack_kwh_chk check (pack_kwh is null or pack_kwh >= 0),
  constraint crm_commercial_opportunities_price_chk check (price_amount is null or price_amount >= 0),
  constraint crm_commercial_opportunities_priority_chk check (priority_score is null or priority_score >= 0)
);
```

### `crm_company_commercial_summary_v`

Derived company-level metrics for the Overview tab, company table views, filters, and future matching/reporting.

```sql
create or replace view crm_company_commercial_summary_v as
with profile_counts as (
  select
    company_id,
    count(*) filter (where status = 'active')::int as active_profile_count,
    count(*) filter (where profile_type = 'buyer_demand' and status = 'active')::int as buyer_profile_count,
    count(*) filter (where profile_type = 'seller_supply' and status = 'active')::int as supplier_profile_count,
    count(*) filter (where profile_type = 'recycler_intake' and status = 'active')::int as recycler_profile_count,
    max(last_verified_at) as latest_profile_verified_at
  from crm_commercial_profiles
  group by company_id
), opportunity_counts as (
  select
    company_id,
    count(*) filter (where opportunity_type = 'supply' and status in ('open', 'matched'))::int as open_supply_count,
    count(*) filter (where opportunity_type = 'demand' and status in ('open', 'matched'))::int as open_demand_count,
    count(*) filter (
      where opportunity_type = 'supply'
        and status = 'open'
        and (urgency in ('high', 'critical') or deadline_at <= now() + interval '14 days')
    )::int as urgent_supply_count,
    count(*) filter (
      where opportunity_type = 'demand'
        and status = 'open'
        and (urgency in ('high', 'critical') or deadline_at <= now() + interval '14 days')
    )::int as urgent_demand_count,
    max(created_at) filter (where opportunity_type = 'supply') as latest_supply_at,
    max(created_at) filter (where opportunity_type = 'demand') as latest_demand_at,
    min(deadline_at) filter (where status = 'open' and deadline_at is not null) as next_deadline_at,
    coalesce(max(priority_score), 0)::numeric(8,2) as max_opportunity_priority_score
  from crm_commercial_opportunities
  group by company_id
)
select
  c.id as company_id,
  coalesce(p.active_profile_count, 0) as active_profile_count,
  coalesce(p.buyer_profile_count, 0) as buyer_profile_count,
  coalesce(p.supplier_profile_count, 0) as supplier_profile_count,
  coalesce(p.recycler_profile_count, 0) as recycler_profile_count,
  coalesce(o.open_supply_count, 0) as open_supply_count,
  coalesce(o.open_demand_count, 0) as open_demand_count,
  coalesce(o.urgent_supply_count, 0) as urgent_supply_count,
  coalesce(o.urgent_demand_count, 0) as urgent_demand_count,
  p.latest_profile_verified_at,
  o.latest_supply_at,
  o.latest_demand_at,
  o.next_deadline_at,
  case
    when coalesce(o.open_supply_count, 0) > 0 and coalesce(o.open_demand_count, 0) > 0 then 'supply_and_demand'
    when coalesce(o.open_supply_count, 0) > 0 then 'active_supply'
    when coalesce(o.open_demand_count, 0) > 0 then 'active_demand'
    when coalesce(p.active_profile_count, 0) > 0 then 'profile_only'
    else 'inactive'
  end as commercial_status,
  (
    coalesce(o.max_opportunity_priority_score, 0)
    + coalesce(o.urgent_supply_count, 0) * 10
    + coalesce(o.urgent_demand_count, 0) * 10
    + coalesce(o.open_supply_count, 0)
    + coalesce(o.open_demand_count, 0)
  )::numeric(10,2) as commercial_priority_score
from crm_companies c
left join profile_counts p on p.company_id = c.id
left join opportunity_counts o on o.company_id = c.id;
```

---

## File Structure

- Modify `apps/web/lib/crm-postgres/schema.sql`: add the two tables, indexes, triggers, and summary view.
- Modify `apps/web/lib/crm-postgres/company-profile.ts`: add commercial types and load profiles, opportunities, derived roles, and summary.
- Modify `apps/web/app/components/crm/company-profile.tsx`: add `profiles` and `opportunities` tabs and render profile cards/opportunity table.
- Modify `apps/web/app/components/crm/company-profile.test.tsx`: cover tab rendering, tab reset, and counts.
- Modify `apps/web/app/api/crm/companies/[id]/route.test.ts`: verify the Postgres reader response passes through commercial payload unchanged.
- Modify `apps/web/lib/workspace-tabs.test.ts`: add `profiles` and `opportunities` as valid company profile subtabs if existing tests enumerate tabs.
- Optional follow-up, not part of this plan: add Supabase-to-CRM sync job for listings.

---

## Task 1: Add CRM Commercial Schema

**Files:**

- Modify: `apps/web/lib/crm-postgres/schema.sql`

- [ ] **Step 1: Add tables and view to schema**

Append the SQL from the Target Data Model section to `apps/web/lib/crm-postgres/schema.sql` after existing core CRM tables and before seed data, if the file has a seed section. If the file only contains DDL, append near the other CRM table definitions.

Also add indexes:

```sql
create index if not exists idx_crm_commercial_profiles_company_id
  on crm_commercial_profiles(company_id);

create index if not exists idx_crm_commercial_profiles_type_status
  on crm_commercial_profiles(profile_type, status);

create index if not exists idx_crm_commercial_opportunities_company_id
  on crm_commercial_opportunities(company_id);

create index if not exists idx_crm_commercial_opportunities_type_status
  on crm_commercial_opportunities(opportunity_type, status);

create index if not exists idx_crm_commercial_opportunities_source
  on crm_commercial_opportunities(source_system, source_id)
  where source_id is not null;

create index if not exists idx_crm_commercial_opportunities_deadline
  on crm_commercial_opportunities(deadline_at)
  where status = 'open' and deadline_at is not null;
```

Add update triggers using the existing `set_updated_at` trigger function name used in the schema. If the schema uses a different function name, use the existing CRM schema function exactly.

Expected trigger shape if the existing function is `set_updated_at`:

```sql
drop trigger if exists trg_crm_commercial_profiles_updated_at on crm_commercial_profiles;
create trigger trg_crm_commercial_profiles_updated_at
before update on crm_commercial_profiles
for each row execute function set_updated_at();

drop trigger if exists trg_crm_commercial_opportunities_updated_at on crm_commercial_opportunities;
create trigger trg_crm_commercial_opportunities_updated_at
before update on crm_commercial_opportunities
for each row execute function set_updated_at();
```

- [ ] **Step 2: Validate schema SQL parses**

Run:

```bash
psql -d denchclaw -v ON_ERROR_STOP=1 -f apps/web/lib/crm-postgres/schema.sql
```

Expected: command exits `0`; existing tables remain intact; no syntax errors.

- [ ] **Step 3: Verify new objects exist**

Run:

```bash
psql -d denchclaw -At -F $'\t' -c "select table_name from information_schema.tables where table_schema='public' and table_name in ('crm_commercial_profiles','crm_commercial_opportunities','crm_company_commercial_summary_v') order by table_name;"
```

Expected output contains:

```text
crm_commercial_opportunities
crm_commercial_profiles
crm_company_commercial_summary_v
```

- [ ] **Step 4: Commit schema change if implementation session is committing**

```bash
git add apps/web/lib/crm-postgres/schema.sql
git commit -m "feat: add CRM commercial tables"
```

---

## Task 2: Add Company Profile Commercial Reader

**Files:**

- Modify: `apps/web/lib/crm-postgres/company-profile.ts`

- [ ] **Step 1: Extend TypeScript response types**

Add these exported types near `PostgresCompanyProfile`:

```ts
export type CommercialProfile = {
  id: string;
  company_id: string;
  contact_person_id: string | null;
  contact_person_name: string | null;
  profile_type: "buyer_demand" | "seller_supply" | "recycler_intake";
  status: "active" | "paused" | "unverified" | "archived";
  battery_types: string[];
  previous_applications: string[];
  chemistries: string[];
  conditions: string[];
  formats: string[];
  specific_types: string[];
  soh_floor: number | null;
  volume_min: number | null;
  volume_max: number | null;
  geographies: string[];
  preferred_outcome: string | null;
  notes: string | null;
  source: string | null;
  last_verified_at: string | null;
};

export type CommercialOpportunity = {
  id: string;
  company_id: string;
  contact_person_id: string | null;
  contact_person_name: string | null;
  opportunity_type: "supply" | "demand";
  status: "draft" | "open" | "matched" | "closed" | "expired" | "cancelled";
  source_system: "crm" | "supabase" | "csv" | "email";
  source_id: string | null;
  title: string;
  battery_type: string | null;
  previous_application: string | null;
  chemistry: string | null;
  condition: string | null;
  format: string | null;
  manufacturer: string | null;
  model: string | null;
  specific_type: string | null;
  quantity: number | null;
  soh: number | null;
  pack_kwh: number | null;
  location_country: string | null;
  location_region: string | null;
  available_from: string | null;
  deadline_at: string | null;
  price_amount: number | null;
  currency: string | null;
  urgency: "low" | "medium" | "high" | "critical";
  priority_score: number | null;
  notes: string | null;
  last_synced_at: string | null;
};

export type CommercialSummary = {
  active_profile_count: number;
  buyer_profile_count: number;
  supplier_profile_count: number;
  recycler_profile_count: number;
  open_supply_count: number;
  open_demand_count: number;
  urgent_supply_count: number;
  urgent_demand_count: number;
  latest_profile_verified_at: string | null;
  latest_supply_at: string | null;
  latest_demand_at: string | null;
  next_deadline_at: string | null;
  commercial_status: "supply_and_demand" | "active_supply" | "active_demand" | "profile_only" | "inactive";
  commercial_priority_score: number;
};

export type CompanyCommercial = {
  roles: Array<"buyer" | "supplier" | "recycler">;
  profiles: CommercialProfile[];
  opportunities: CommercialOpportunity[];
  summary: CommercialSummary;
};
```

Then extend `PostgresCompanyProfile`:

```ts
export type PostgresCompanyProfile = {
  company: { /* existing fields */ };
  people: Array<{ /* existing fields */ }>;
  threads: Array<{ /* existing fields */ }>;
  events: Array<{ /* existing fields */ }>;
  commercial: CompanyCommercial;
  summary: { /* existing fields */ };
};
```

- [ ] **Step 2: Add row types and helpers**

Add row types below existing `EventRow`:

```ts
type CommercialProfileRow = Omit<CommercialProfile, "last_verified_at" | "contact_person_name"> & {
  contact_person_name: string | null;
  last_verified_at: string | Date | null;
};

type CommercialOpportunityRow = Omit<CommercialOpportunity, "available_from" | "deadline_at" | "last_synced_at" | "contact_person_name"> & {
  contact_person_name: string | null;
  available_from: string | Date | null;
  deadline_at: string | Date | null;
  last_synced_at: string | Date | null;
};

type CommercialSummaryRow = Omit<CommercialSummary, "latest_profile_verified_at" | "latest_supply_at" | "latest_demand_at" | "next_deadline_at"> & {
  latest_profile_verified_at: string | Date | null;
  latest_supply_at: string | Date | null;
  latest_demand_at: string | Date | null;
  next_deadline_at: string | Date | null;
};
```

Add a default summary helper:

```ts
const EMPTY_COMMERCIAL_SUMMARY: CommercialSummary = {
  active_profile_count: 0,
  buyer_profile_count: 0,
  supplier_profile_count: 0,
  recycler_profile_count: 0,
  open_supply_count: 0,
  open_demand_count: 0,
  urgent_supply_count: 0,
  urgent_demand_count: 0,
  latest_profile_verified_at: null,
  latest_supply_at: null,
  latest_demand_at: null,
  next_deadline_at: null,
  commercial_status: "inactive",
  commercial_priority_score: 0,
};
```

Add role derivation:

```ts
function deriveCommercialRoles(summary: CommercialSummary): Array<"buyer" | "supplier" | "recycler"> {
  const roles: Array<"buyer" | "supplier" | "recycler"> = [];
  if (summary.buyer_profile_count > 0 || summary.open_demand_count > 0) roles.push("buyer");
  if (summary.supplier_profile_count > 0 || summary.open_supply_count > 0) roles.push("supplier");
  if (summary.recycler_profile_count > 0) roles.push("recycler");
  return roles;
}
```

- [ ] **Step 3: Load profiles, opportunities, and summary**

Inside `getPostgresCompanyProfile`, after loading `events`, add three queries:

```ts
const profileRows = await queryPg<CommercialProfileRow>(`
  select p.id,
         p.company_id,
         p.contact_person_id,
         contact.full_name as contact_person_name,
         p.profile_type,
         p.status,
         p.battery_types,
         p.previous_applications,
         p.chemistries,
         p.conditions,
         p.formats,
         p.specific_types,
         p.soh_floor,
         p.volume_min,
         p.volume_max,
         p.geographies,
         p.preferred_outcome,
         p.notes,
         p.source,
         p.last_verified_at
    from crm_commercial_profiles p
    left join crm_people contact on contact.id = p.contact_person_id
   where p.company_id = $1
   order by p.status = 'active' desc,
            p.profile_type asc,
            p.last_verified_at desc nulls last,
            p.created_at desc
`, [company.id]);

const opportunityRows = await queryPg<CommercialOpportunityRow>(`
  select o.id,
         o.company_id,
         o.contact_person_id,
         contact.full_name as contact_person_name,
         o.opportunity_type,
         o.status,
         o.source_system,
         o.source_id,
         o.title,
         o.battery_type,
         o.previous_application,
         o.chemistry,
         o.condition,
         o.format,
         o.manufacturer,
         o.model,
         o.specific_type,
         o.quantity,
         o.soh,
         o.pack_kwh,
         o.location_country,
         o.location_region,
         o.available_from,
         o.deadline_at,
         o.price_amount,
         o.currency,
         o.urgency,
         o.priority_score,
         o.notes,
         o.last_synced_at
    from crm_commercial_opportunities o
    left join crm_people contact on contact.id = o.contact_person_id
   where o.company_id = $1
   order by o.status = 'open' desc,
            case o.urgency when 'critical' then 4 when 'high' then 3 when 'medium' then 2 else 1 end desc,
            o.deadline_at asc nulls last,
            o.created_at desc
   limit 200
`, [company.id]);

const summaryRows = await queryPg<CommercialSummaryRow>(`
  select active_profile_count,
         buyer_profile_count,
         supplier_profile_count,
         recycler_profile_count,
         open_supply_count,
         open_demand_count,
         urgent_supply_count,
         urgent_demand_count,
         latest_profile_verified_at,
         latest_supply_at,
         latest_demand_at,
         next_deadline_at,
         commercial_status,
         commercial_priority_score
    from crm_company_commercial_summary_v
   where company_id = $1
   limit 1
`, [company.id]);
```

Map rows using existing `iso` and `numberOrNull` helpers.

- [ ] **Step 4: Return commercial payload**

Before return, build:

```ts
const commercialSummaryRow = summaryRows[0];
const commercialSummary: CommercialSummary = commercialSummaryRow
  ? {
      active_profile_count: Number(commercialSummaryRow.active_profile_count ?? 0),
      buyer_profile_count: Number(commercialSummaryRow.buyer_profile_count ?? 0),
      supplier_profile_count: Number(commercialSummaryRow.supplier_profile_count ?? 0),
      recycler_profile_count: Number(commercialSummaryRow.recycler_profile_count ?? 0),
      open_supply_count: Number(commercialSummaryRow.open_supply_count ?? 0),
      open_demand_count: Number(commercialSummaryRow.open_demand_count ?? 0),
      urgent_supply_count: Number(commercialSummaryRow.urgent_supply_count ?? 0),
      urgent_demand_count: Number(commercialSummaryRow.urgent_demand_count ?? 0),
      latest_profile_verified_at: iso(commercialSummaryRow.latest_profile_verified_at),
      latest_supply_at: iso(commercialSummaryRow.latest_supply_at),
      latest_demand_at: iso(commercialSummaryRow.latest_demand_at),
      next_deadline_at: iso(commercialSummaryRow.next_deadline_at),
      commercial_status: commercialSummaryRow.commercial_status,
      commercial_priority_score: numberOrNull(commercialSummaryRow.commercial_priority_score) ?? 0,
    }
  : EMPTY_COMMERCIAL_SUMMARY;
```

Add to returned object:

```ts
commercial: {
  roles: deriveCommercialRoles(commercialSummary),
  profiles,
  opportunities,
  summary: commercialSummary,
},
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm --dir apps/web test apps/web/app/api/crm/companies/[id]/route.test.ts apps/web/app/components/crm/company-profile.test.tsx
```

Expected: existing tests pass after adding default `commercial` payloads to mocks.

- [ ] **Step 6: Commit reader change if implementation session is committing**

```bash
git add apps/web/lib/crm-postgres/company-profile.ts apps/web/app/api/crm/companies/[id]/route.test.ts apps/web/app/components/crm/company-profile.test.tsx
git commit -m "feat: load CRM company commercial data"
```

---

## Task 3: Add Profiles And Opportunities Tabs

**Files:**

- Modify: `apps/web/app/components/crm/company-profile.tsx`
- Modify: `apps/web/app/components/crm/company-profile.test.tsx`
- Modify: `apps/web/lib/workspace-tabs.test.ts`

- [ ] **Step 1: Extend client response type**

In `company-profile.tsx`, add the same `commercial` response shape to `CompanyResponse`:

```ts
commercial: {
  roles: Array<"buyer" | "supplier" | "recycler">;
  profiles: Array<{
    id: string;
    contact_person_name: string | null;
    profile_type: "buyer_demand" | "seller_supply" | "recycler_intake";
    status: "active" | "paused" | "unverified" | "archived";
    battery_types: string[];
    previous_applications: string[];
    chemistries: string[];
    conditions: string[];
    formats: string[];
    specific_types: string[];
    soh_floor: number | null;
    volume_min: number | null;
    volume_max: number | null;
    geographies: string[];
    preferred_outcome: string | null;
    notes: string | null;
    source: string | null;
    last_verified_at: string | null;
  }>;
  opportunities: Array<{
    id: string;
    contact_person_name: string | null;
    opportunity_type: "supply" | "demand";
    status: "draft" | "open" | "matched" | "closed" | "expired" | "cancelled";
    source_system: "crm" | "supabase" | "csv" | "email";
    source_id: string | null;
    title: string;
    chemistry: string | null;
    format: string | null;
    manufacturer: string | null;
    model: string | null;
    quantity: number | null;
    soh: number | null;
    pack_kwh: number | null;
    location_country: string | null;
    location_region: string | null;
    deadline_at: string | null;
    urgency: "low" | "medium" | "high" | "critical";
    priority_score: number | null;
    notes: string | null;
  }>;
  summary: {
    active_profile_count: number;
    buyer_profile_count: number;
    supplier_profile_count: number;
    recycler_profile_count: number;
    open_supply_count: number;
    open_demand_count: number;
    urgent_supply_count: number;
    urgent_demand_count: number;
    next_deadline_at: string | null;
    commercial_status: "supply_and_demand" | "active_supply" | "active_demand" | "profile_only" | "inactive";
    commercial_priority_score: number;
  };
};
```

- [ ] **Step 2: Extend tabs**

Change:

```ts
export type CompanyProfileTab = "overview" | "team" | "emails" | "meetings";
```

To:

```ts
export type CompanyProfileTab = "overview" | "team" | "profiles" | "opportunities" | "emails" | "meetings";
```

Change `TABS` to:

```ts
const TABS: ReadonlyArray<{ id: CompanyProfileTab; label: string; count: (d: CompanyResponse) => number | null }> = [
  { id: "overview", label: "Overview", count: () => null },
  { id: "team", label: "Team", count: (d) => d.summary.people_count },
  { id: "profiles", label: "Profiles", count: (d) => d.commercial.profiles.length },
  { id: "opportunities", label: "Opportunities", count: (d) => d.commercial.opportunities.length },
  { id: "emails", label: "Emails", count: (d) => d.summary.thread_count },
  { id: "meetings", label: "Meetings", count: (d) => d.summary.event_count },
];
```

Change `isCompanyProfileTab` to include the new tab names.

- [ ] **Step 3: Add commercial strip to Overview**

In `OverviewTab`, add four stats after the existing `At a glance` grid or extend the grid to include:

```tsx
<Stat label="Profiles" value={data.commercial.summary.active_profile_count.toLocaleString()} />
<Stat label="Supply" value={data.commercial.summary.open_supply_count.toLocaleString()} />
<Stat label="Demand" value={data.commercial.summary.open_demand_count.toLocaleString()} />
<Stat
  label="Urgent"
  value={(data.commercial.summary.urgent_supply_count + data.commercial.summary.urgent_demand_count).toLocaleString()}
/>
```

Add role chips below the stats if `data.commercial.roles.length > 0`:

```tsx
<div className="flex flex-wrap gap-1.5">
  {data.commercial.roles.map((role) => (
    <span
      key={role}
      className="rounded-full px-2 py-0.5 text-[11px] font-medium capitalize"
      style={{ background: "var(--color-surface-hover)", color: "var(--color-text-muted)" }}
    >
      {role}
    </span>
  ))}
</div>
```

- [ ] **Step 4: Render Profiles tab**

Add branch in main render:

```tsx
{tab === "profiles" && <ProfilesTab data={data} />}
```

Add component:

```tsx
function ProfilesTab({ data }: { data: CompanyResponse }) {
  if (data.commercial.profiles.length === 0) {
    return <CrmEmptyState title="No commercial profiles yet" description="Add buyer demand, seller supply, or recycler intake profiles for this company." />;
  }
  return (
    <div className="space-y-3">
      {data.commercial.profiles.map((profile) => (
        <section
          key={profile.id}
          className="rounded-2xl border p-4"
          style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-[14px] font-semibold" style={{ color: "var(--color-text)" }}>
                {formatProfileType(profile.profile_type)}
              </h3>
              <p className="mt-0.5 text-[12px]" style={{ color: "var(--color-text-muted)" }}>
                {[profile.status, profile.contact_person_name].filter(Boolean).join(" · ")}
              </p>
            </div>
            <span className="rounded-full px-2 py-0.5 text-[11px] capitalize" style={{ background: "var(--color-surface-hover)", color: "var(--color-text-muted)" }}>
              {profile.status}
            </span>
          </div>
          <div className="mt-4 grid gap-2 text-[13px] sm:grid-cols-2">
            <Field label="Chemistry" value={joinList(profile.chemistries)} />
            <Field label="Formats" value={joinList(profile.formats)} />
            <Field label="Applications" value={joinList(profile.previous_applications)} />
            <Field label="Conditions" value={joinList(profile.conditions)} />
            <Field label="Specifics" value={joinList(profile.specific_types)} />
            <Field label="Geography" value={joinList(profile.geographies)} />
            <Field label="SoH floor" value={profile.soh_floor === null ? null : `${profile.soh_floor}%`} />
            <Field label="Volume" value={formatVolumeRange(profile.volume_min, profile.volume_max)} />
          </div>
          {profile.notes && <p className="mt-3 text-[13px]" style={{ color: "var(--color-text-muted)" }}>{profile.notes}</p>}
        </section>
      ))}
    </div>
  );
}
```

Add helpers:

```tsx
function formatProfileType(type: CompanyResponse["commercial"]["profiles"][number]["profile_type"]): string {
  if (type === "buyer_demand") return "Buyer demand profile";
  if (type === "seller_supply") return "Seller supply profile";
  return "Recycler intake profile";
}

function joinList(values: string[]): string | null {
  const clean = values.map((value) => value.trim()).filter(Boolean);
  return clean.length > 0 ? clean.join(", ") : null;
}

function formatVolumeRange(min: number | null, max: number | null): string | null {
  if (min === null && max === null) return null;
  if (min !== null && max !== null) return `${min.toLocaleString()}-${max.toLocaleString()}`;
  if (min !== null) return `From ${min.toLocaleString()}`;
  return `Up to ${max!.toLocaleString()}`;
}
```

- [ ] **Step 5: Render Opportunities tab**

Add branch in main render:

```tsx
{tab === "opportunities" && <OpportunitiesTab data={data} />}
```

Add component:

```tsx
function OpportunitiesTab({ data }: { data: CompanyResponse }) {
  if (data.commercial.opportunities.length === 0) {
    return <CrmEmptyState title="No opportunities yet" description="Supply and demand moments will appear here once created or synced." />;
  }
  return (
    <div className="overflow-hidden rounded-2xl border" style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}>
      <table className="w-full text-left text-[13px]">
        <thead style={{ color: "var(--color-text-muted)", background: "var(--color-surface-hover)" }}>
          <tr>
            <th className="px-3 py-2 font-medium">Type</th>
            <th className="px-3 py-2 font-medium">Title</th>
            <th className="px-3 py-2 font-medium">Battery</th>
            <th className="px-3 py-2 font-medium">Qty</th>
            <th className="px-3 py-2 font-medium">Location</th>
            <th className="px-3 py-2 font-medium">Urgency</th>
            <th className="px-3 py-2 font-medium">Deadline</th>
          </tr>
        </thead>
        <tbody className="divide-y" style={{ borderColor: "var(--color-border)" }}>
          {data.commercial.opportunities.map((opportunity) => (
            <tr key={opportunity.id}>
              <td className="px-3 py-3 capitalize" style={{ color: "var(--color-text-muted)" }}>{opportunity.opportunity_type}</td>
              <td className="px-3 py-3">
                <div className="font-medium" style={{ color: "var(--color-text)" }}>{opportunity.title}</div>
                <div className="mt-0.5 text-[11px] capitalize" style={{ color: "var(--color-text-muted)" }}>
                  {[opportunity.status, opportunity.source_system].filter(Boolean).join(" · ")}
                </div>
              </td>
              <td className="px-3 py-3" style={{ color: "var(--color-text-muted)" }}>
                {[opportunity.chemistry, opportunity.format, [opportunity.manufacturer, opportunity.model].filter(Boolean).join(" ")].filter(Boolean).join(" · ") || "—"}
              </td>
              <td className="px-3 py-3" style={{ color: "var(--color-text-muted)" }}>{opportunity.quantity?.toLocaleString() ?? "—"}</td>
              <td className="px-3 py-3" style={{ color: "var(--color-text-muted)" }}>{[opportunity.location_region, opportunity.location_country].filter(Boolean).join(", ") || "—"}</td>
              <td className="px-3 py-3 capitalize" style={{ color: "var(--color-text-muted)" }}>{opportunity.urgency}</td>
              <td className="px-3 py-3" style={{ color: "var(--color-text-muted)" }}>{opportunity.deadline_at ? formatRelativeDate(opportunity.deadline_at) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 6: Update tests**

In `company-profile.test.tsx`, ensure the mocked API response includes:

```ts
commercial: {
  roles: ["supplier"],
  profiles: [
    {
      id: "profile_1",
      contact_person_name: "Ricki Mayhew",
      profile_type: "seller_supply",
      status: "active",
      battery_types: ["pack"],
      previous_applications: ["EV"],
      chemistries: ["NMC"],
      conditions: ["used_good"],
      formats: ["pack"],
      specific_types: ["EV battery pack"],
      soh_floor: null,
      volume_min: null,
      volume_max: null,
      geographies: ["UK"],
      preferred_outcome: "reuse",
      notes: "Typical salvage EV battery supply.",
      source: "manual",
      last_verified_at: null,
    },
  ],
  opportunities: [
    {
      id: "opp_1",
      contact_person_name: "Ricki Mayhew",
      opportunity_type: "supply",
      status: "open",
      source_system: "supabase",
      source_id: "listing_1",
      title: "Nissan Leaf battery pack",
      chemistry: "NMC",
      format: "Pack",
      manufacturer: "Nissan",
      model: "Leaf",
      quantity: 1,
      soh: null,
      pack_kwh: 24,
      location_country: "United Kingdom",
      location_region: "England",
      deadline_at: null,
      urgency: "medium",
      priority_score: null,
      notes: null,
    },
  ],
  summary: {
    active_profile_count: 1,
    buyer_profile_count: 0,
    supplier_profile_count: 1,
    recycler_profile_count: 0,
    open_supply_count: 1,
    open_demand_count: 0,
    urgent_supply_count: 0,
    urgent_demand_count: 0,
    next_deadline_at: null,
    commercial_status: "active_supply",
    commercial_priority_score: 1,
  },
}
```

Add assertions:

```ts
expect(await screen.findByText("Profiles")).toBeInTheDocument();
expect(screen.getByText("Opportunities")).toBeInTheDocument();

await user.click(screen.getByText("Profiles"));
expect(await screen.findByText("Seller supply profile")).toBeInTheDocument();
expect(screen.getByText("Typical salvage EV battery supply.")).toBeInTheDocument();

await user.click(screen.getByText("Opportunities"));
expect(await screen.findByText("Nissan Leaf battery pack")).toBeInTheDocument();
expect(screen.getByText("NMC · Pack · Nissan Leaf")).toBeInTheDocument();
```

Update `workspace-tabs.test.ts` expected valid profile tabs to include `profiles` and `opportunities` if the test enumerates them.

- [ ] **Step 7: Run focused UI tests**

Run:

```bash
pnpm --dir apps/web test apps/web/app/components/crm/company-profile.test.tsx apps/web/lib/workspace-tabs.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 8: Commit UI change if implementation session is committing**

```bash
git add apps/web/app/components/crm/company-profile.tsx apps/web/app/components/crm/company-profile.test.tsx apps/web/lib/workspace-tabs.test.ts
git commit -m "feat: add CRM company commercial tabs"
```

---

## Task 4: Full Verification

**Files:**

- Verify changed files only plus repo-level checks.

- [ ] **Step 1: Run CRM/API/UI focused tests**

Run:

```bash
pnpm --dir apps/web test apps/web/app/api/crm/companies/[id]/route.test.ts apps/web/app/components/crm/company-profile.test.tsx apps/web/lib/workspace-tabs.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 2: Run web test suite if focused tests pass**

Run:

```bash
pnpm --dir apps/web test
```

Expected: app web test suite passes.

- [ ] **Step 3: Run type/lint checks**

Run:

```bash
pnpm check
```

Expected: formatting and lint pass.

- [ ] **Step 4: Manual DB verification**

Run:

```bash
psql -d denchclaw -At -F $'\t' -c "select company_id, commercial_status, open_supply_count, open_demand_count from crm_company_commercial_summary_v where company_id in ('e983c253-4079-466a-a9a4-b06235ce95dd','232d959d-7b84-4fd6-b8cb-8982356ab975','a70c2e36-f875-4328-b9a9-1ec4147b7448') order by company_id;"
```

Expected before backfill: rows exist with `inactive` and zero counts for each company. Expected after backfill: Silverlake/LKQ Synetiq rows show `active_supply` and non-zero `open_supply_count`.

- [ ] **Step 5: Manual UI verification**

Start app:

```bash
pnpm web:dev
```

Open a CRM company profile for Silverlake or Synetiq. Verify:

- Tabs include `Profiles` and `Opportunities`.
- Overview still loads existing company stats.
- Empty states render if no commercial records exist.
- Profile cards render if a profile row exists.
- Opportunity table renders if opportunity rows exist.
- Existing Team, Emails, and Meetings tabs still work.

---

## Future Follow-Ups Outside This Plan

- Build a real Supabase-to-CRM listing sync job that upserts `crm_commercial_opportunities` with `source_system = 'supabase'` and `source_id = listings.id`.
- Add manual create/edit UI for commercial profiles and opportunities.
- Add company table columns from `crm_company_commercial_summary_v` for commercial views.
- Add matching query service over open supply opportunities versus active buyer profiles and open demand opportunities.
- Persist match workflow only after the team needs audited outreach state.

---

## Self-Review

Spec coverage:

- Two-table minimal structure is covered by Task 1.
- Company-level demand/supply counts and urgency metrics are covered by the summary view in Task 1.
- Company profile API extension is covered by Task 2.
- Separate `Profiles` and `Opportunities` tabs are covered by Task 3.
- Existing CRM company profile behavior is preserved by focused tests in Tasks 2, 3, and 5.

Completeness scan:

- The implementation scope is limited to CRM schema, company profile reads, company profile tabs, and verification. Supabase sync/backfill is listed as future work, not as part of this implementation scope.

Type consistency:

- Tab names are consistently `profiles` and `opportunities`.
- Table names are consistently `crm_commercial_profiles` and `crm_commercial_opportunities`.
- Summary view is consistently `crm_company_commercial_summary_v`.
- Opportunity type values are consistently `supply` and `demand`.
