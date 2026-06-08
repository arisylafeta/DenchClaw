# Transfer Imported Listings To Supplier Contacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the imported Silverlake and Synetiq listing ownership in Supabase from `admin@rebattery.io` / `ReBattery Sales` to their real supplier company accounts and contact-person user records.

**Architecture:** Use one guarded one-time SQL data migration that inserts missing `public.users`, `public.accounts`, and `public.account_memberships`, then updates only imported `public.listings` rows identified by `linked_to` and the existing ReBattery Sales owner. The migration is replay-protected by exact row-count assertions (`205` Silverlake, `361` Synetiq). Keep `listings.linked_to` as provenance and make `supplier_account_id` plus `created_by_user_id` the canonical platform ownership fields.

**Tech Stack:** Supabase Postgres, SQL migrations, `public.users`, `public.accounts`, `public.account_memberships`, `public.listings`, `public.listing_specs`.

---

## Current Supabase Facts

- ReBattery import account: `15f92a7a-61be-4648-b328-3d49ab99690e` / `ReBattery Sales`.
- ReBattery import user: `972e879c-b263-452e-b5b1-e1c43a23c3b4` / `admin@rebattery.io`.
- Imported Silverlake rows: `205` listings where `supplier_account_id = '15f92a7a-61be-4648-b328-3d49ab99690e'`, `created_by_user_id = '972e879c-b263-452e-b5b1-e1c43a23c3b4'`, and `lower(linked_to) = 'gvaccaro@silverlake.co.uk'`.
- Imported Synetiq rows: `361` listings where `supplier_account_id = '15f92a7a-61be-4648-b328-3d49ab99690e'`, `created_by_user_id = '972e879c-b263-452e-b5b1-e1c43a23c3b4'`, and `lower(linked_to) = 'ricki.mayhew@lkqsynetiq.co.uk'`.
- Current missing platform users: `gvaccaro@silverlake.co.uk`, `ricki.mayhew@lkqsynetiq.co.uk`.
- Current missing supplier accounts: `Silverlake Automotive Recycling`, `LKQ SYNETIQ`.

## Target Ownership

| Source marker | Company account | Contact user | Expected rows |
| --- | --- | --- | --- |
| `gvaccaro@silverlake.co.uk` | `Silverlake Automotive Recycling` | `gvaccaro@silverlake.co.uk` / `Giancarlo Vaccaro` | `205` |
| `ricki.mayhew@lkqsynetiq.co.uk` | `LKQ SYNETIQ` | `ricki.mayhew@lkqsynetiq.co.uk` / `Ricki Mayhew` | `361` |

## File Structure

- Create: `docs/superpowers/plans/2026-05-02-transfer-imported-listings-to-supplier-contacts.md`
  - This implementation plan.
- Create: `docs/superpowers/migrations/20260502184833_transfer_imported_listings_to_supplier_contacts.sql`
  - Local SQL artifact containing the guarded one-time migration DO block used for review/audit and as the source for `supabase_apply_migration` execution.
- Apply migration through Supabase MCP `supabase_apply_migration` with name `transfer_imported_listings_to_supplier_contacts`.
  - The Supabase migration history for this project is remote; there is no local `supabase/migrations` directory in the current DenchClaw repository.
- Do not modify app code for this migration.
  - Existing foreign keys already support the ownership update: `listings.supplier_account_id -> accounts.id`, `listings.created_by_user_id -> users.id`, `account_memberships.account_id -> accounts.id`, `account_memberships.user_id -> users.id`.

---

### Task 1: Preflight The Exact Migration Scope

**Files:**
- No file changes.

- [ ] **Step 1: Verify current imported row counts**

Run this Supabase SQL:

```sql
select
  lower(linked_to) as linked_to,
  supplier_account_id,
  created_by_user_id,
  count(*) as listing_count
from public.listings
where supplier_account_id = '15f92a7a-61be-4648-b328-3d49ab99690e'
  and created_by_user_id = '972e879c-b263-452e-b5b1-e1c43a23c3b4'
  and lower(linked_to) in (
    'gvaccaro@silverlake.co.uk',
    'ricki.mayhew@lkqsynetiq.co.uk'
  )
group by lower(linked_to), supplier_account_id, created_by_user_id
order by lower(linked_to);
```

Expected:

```text
gvaccaro@silverlake.co.uk        205
ricki.mayhew@lkqsynetiq.co.uk    361
```

- [ ] **Step 2: Verify target users and accounts do not already conflict**

Run this Supabase SQL:

```sql
select 'user' as entity, id::text, email as label
from public.users
where lower(email) in (
  'gvaccaro@silverlake.co.uk',
  'ricki.mayhew@lkqsynetiq.co.uk'
)
union all
select 'account' as entity, id::text, name as label
from public.accounts
where lower(name) in (
  'silverlake automotive recycling',
  'lkq synetiq'
)
order by entity, label;
```

Expected before migration:

```text
0 rows
```

If this returns user rows, continue only if there is exactly one row per target email. If this returns account rows, continue only if there is exactly one row per target account name. Email and account-name duplicate checks use `lower(...)` because the migration treats case variants as the same business entity.

- [ ] **Step 3: Verify ReBattery source user/account still exist**

Run this Supabase SQL:

```sql
select
  (select count(*) from public.users where id = '972e879c-b263-452e-b5b1-e1c43a23c3b4') as rebattery_user_count,
  (select count(*) from public.accounts where id = '15f92a7a-61be-4648-b328-3d49ab99690e') as rebattery_account_count;
```

Expected:

```text
rebattery_user_count = 1
rebattery_account_count = 1
```

---

### Task 2: Apply The Guarded One-Time Data Migration

**Files:**
- No repository file changes.
- Remote Supabase migration: `transfer_imported_listings_to_supplier_contacts`.

- [ ] **Step 1: Apply migration SQL**

Use `supabase_apply_migration` with migration name `transfer_imported_listings_to_supplier_contacts` and this SQL:

```sql
do $$
declare
  rebattery_account_id constant uuid := '15f92a7a-61be-4648-b328-3d49ab99690e';
  rebattery_user_id constant uuid := '972e879c-b263-452e-b5b1-e1c43a23c3b4';
  silverlake_user_id uuid;
  silverlake_account_id uuid;
  synetiq_user_id uuid;
  synetiq_account_id uuid;
  silverlake_updated integer;
  synetiq_updated integer;
begin
  if not exists (select 1 from public.accounts where id = rebattery_account_id) then
    raise exception 'Source ReBattery account % does not exist', rebattery_account_id;
  end if;

  if not exists (select 1 from public.users where id = rebattery_user_id) then
    raise exception 'Source ReBattery user % does not exist', rebattery_user_id;
  end if;

  if (
    select count(*)
    from public.users
    where lower(email) = 'gvaccaro@silverlake.co.uk'
  ) > 1 then
    raise exception 'Multiple gvaccaro@silverlake.co.uk users exist; resolve duplicates before migration';
  end if;

  if (
    select count(*)
    from public.users
    where lower(email) = 'ricki.mayhew@lkqsynetiq.co.uk'
  ) > 1 then
    raise exception 'Multiple ricki.mayhew@lkqsynetiq.co.uk users exist; resolve duplicates before migration';
  end if;

  insert into public.users (email, full_name, status, other)
  select
    'gvaccaro@silverlake.co.uk',
    'Giancarlo Vaccaro',
    'approved',
    jsonb_build_object(
      'source', 'imported_listing_ownership_migration',
      'crm_person_id', 'twenty_person_60954220-2965-450f-aa69-caf10075c0ed',
      'company_name', 'Silverlake Automotive Recycling'
    )
  where not exists (
    select 1 from public.users where lower(email) = 'gvaccaro@silverlake.co.uk'
  );

  update public.users
  set
    full_name = coalesce(full_name, 'Giancarlo Vaccaro'),
    status = coalesce(status, 'approved'),
    other = other || jsonb_build_object(
      'source', 'imported_listing_ownership_migration',
      'crm_person_id', 'twenty_person_60954220-2965-450f-aa69-caf10075c0ed',
      'company_name', 'Silverlake Automotive Recycling'
    ),
    updated_at = now()
  where lower(email) = 'gvaccaro@silverlake.co.uk';

  insert into public.users (email, full_name, status, other)
  select
    'ricki.mayhew@lkqsynetiq.co.uk',
    'Ricki Mayhew',
    'approved',
    jsonb_build_object(
      'source', 'imported_listing_ownership_migration',
      'crm_person_id', 'gog:person:ricki.mayhew@lkqsynetiq.co.uk',
      'company_name', 'LKQ SYNETIQ'
    )
  where not exists (
    select 1 from public.users where lower(email) = 'ricki.mayhew@lkqsynetiq.co.uk'
  );

  update public.users
  set
    full_name = coalesce(full_name, 'Ricki Mayhew'),
    status = coalesce(status, 'approved'),
    other = other || jsonb_build_object(
      'source', 'imported_listing_ownership_migration',
      'crm_person_id', 'gog:person:ricki.mayhew@lkqsynetiq.co.uk',
      'company_name', 'LKQ SYNETIQ'
    ),
    updated_at = now()
  where lower(email) = 'ricki.mayhew@lkqsynetiq.co.uk';

  select id into silverlake_user_id
  from public.users
  where lower(email) = 'gvaccaro@silverlake.co.uk';

  select id into synetiq_user_id
  from public.users
  where lower(email) = 'ricki.mayhew@lkqsynetiq.co.uk';

  if (
    select count(*)
    from public.accounts
    where lower(name) = 'silverlake automotive recycling'
  ) > 1 then
    raise exception 'Multiple Silverlake Automotive Recycling accounts exist; resolve duplicates before migration';
  end if;

  if (
    select count(*)
    from public.accounts
    where lower(name) = 'lkq synetiq'
  ) > 1 then
    raise exception 'Multiple LKQ SYNETIQ accounts exist; resolve duplicates before migration';
  end if;

  insert into public.accounts (account_type, role, status, name, created_by_user_id, sector, is_enterprise)
  select 'organization', 'supplier', 'approved', 'Silverlake Automotive Recycling', silverlake_user_id, 'battery_repurposer_second_life', true
  where not exists (
    select 1 from public.accounts where lower(name) = 'silverlake automotive recycling'
  );

  update public.accounts
  set
    role = 'supplier',
    status = 'approved',
    created_by_user_id = coalesce(created_by_user_id, silverlake_user_id),
    sector = coalesce(sector, 'battery_repurposer_second_life'),
    is_enterprise = is_enterprise or true,
    updated_at = now()
  where lower(name) = 'silverlake automotive recycling';

  insert into public.accounts (account_type, role, status, name, created_by_user_id, sector, is_enterprise)
  select 'organization', 'supplier', 'approved', 'LKQ SYNETIQ', synetiq_user_id, 'battery_repurposer_second_life', true
  where not exists (
    select 1 from public.accounts where lower(name) = 'lkq synetiq'
  );

  update public.accounts
  set
    role = 'supplier',
    status = 'approved',
    created_by_user_id = coalesce(created_by_user_id, synetiq_user_id),
    sector = coalesce(sector, 'battery_repurposer_second_life'),
    is_enterprise = is_enterprise or true,
    updated_at = now()
  where lower(name) = 'lkq synetiq';

  select id into silverlake_account_id
  from public.accounts
  where lower(name) = 'silverlake automotive recycling';

  select id into synetiq_account_id
  from public.accounts
  where lower(name) = 'lkq synetiq';

  insert into public.account_memberships (user_id, account_id, membership_role, is_primary)
  values
    (silverlake_user_id, silverlake_account_id, 'owner', true),
    (synetiq_user_id, synetiq_account_id, 'owner', true)
  on conflict (user_id, account_id) do update
  set
    membership_role = 'owner',
    is_primary = true,
    updated_at = now();

  update public.listings
  set
    supplier_account_id = silverlake_account_id,
    created_by_user_id = silverlake_user_id,
    updated_at = now()
  where supplier_account_id = rebattery_account_id
    and created_by_user_id = rebattery_user_id
    and lower(linked_to) = 'gvaccaro@silverlake.co.uk';

  get diagnostics silverlake_updated = row_count;

  update public.listings
  set
    supplier_account_id = synetiq_account_id,
    created_by_user_id = synetiq_user_id,
    updated_at = now()
  where supplier_account_id = rebattery_account_id
    and created_by_user_id = rebattery_user_id
    and lower(linked_to) = 'ricki.mayhew@lkqsynetiq.co.uk';

  get diagnostics synetiq_updated = row_count;

  if silverlake_updated <> 205 then
    raise exception 'Expected to update 205 Silverlake listings, updated %', silverlake_updated;
  end if;

  if synetiq_updated <> 361 then
    raise exception 'Expected to update 361 Synetiq listings, updated %', synetiq_updated;
  end if;
end $$;
```

Expected:

```text
Migration applied successfully.
```

If the migration fails with one of the expected-count exceptions, no changes from the `do` block should persist. Re-run Task 1 to inspect changed counts before editing the migration.

---

### Task 3: Verify Ownership Moved To Supplier Companies And Contacts

**Files:**
- No file changes.

- [ ] **Step 1: Verify listing ownership by contact marker**

Run this Supabase SQL:

```sql
select
  lower(l.linked_to) as linked_to,
  a.name as supplier_account_name,
  u.email as created_by_email,
  count(*) as listing_count
from public.listings l
join public.accounts a on a.id = l.supplier_account_id
join public.users u on u.id = l.created_by_user_id
where lower(l.linked_to) in (
  'gvaccaro@silverlake.co.uk',
  'ricki.mayhew@lkqsynetiq.co.uk'
)
group by lower(l.linked_to), a.name, u.email
order by lower(l.linked_to);
```

Expected:

```text
gvaccaro@silverlake.co.uk        Silverlake Automotive Recycling    gvaccaro@silverlake.co.uk          205
ricki.mayhew@lkqsynetiq.co.uk    LKQ SYNETIQ                         ricki.mayhew@lkqsynetiq.co.uk      361
```

- [ ] **Step 2: Verify no imported rows remain on ReBattery Sales for those contacts**

Run this Supabase SQL:

```sql
select count(*) as remaining_rebattery_import_rows
from public.listings
where supplier_account_id = '15f92a7a-61be-4648-b328-3d49ab99690e'
  and created_by_user_id = '972e879c-b263-452e-b5b1-e1c43a23c3b4'
  and lower(linked_to) in (
    'gvaccaro@silverlake.co.uk',
    'ricki.mayhew@lkqsynetiq.co.uk'
  );
```

Expected:

```text
remaining_rebattery_import_rows = 0
```

- [ ] **Step 3: Verify account memberships**

Run this Supabase SQL:

```sql
select
  a.name as account_name,
  u.email as user_email,
  am.membership_role,
  am.is_primary
from public.account_memberships am
join public.accounts a on a.id = am.account_id
join public.users u on u.id = am.user_id
where lower(u.email) in (
  'gvaccaro@silverlake.co.uk',
  'ricki.mayhew@lkqsynetiq.co.uk'
)
order by a.name, u.email;
```

Expected:

```text
LKQ SYNETIQ                         ricki.mayhew@lkqsynetiq.co.uk    owner    true
Silverlake Automotive Recycling     gvaccaro@silverlake.co.uk        owner    true
```

- [ ] **Step 4: Verify listing specs still line up one-to-one**

Run this Supabase SQL:

```sql
select
  lower(l.linked_to) as linked_to,
  count(*) as listings_count,
  count(ls.id) as listing_specs_count
from public.listings l
left join public.listing_specs ls on ls.listing_id = l.id
where lower(l.linked_to) in (
  'gvaccaro@silverlake.co.uk',
  'ricki.mayhew@lkqsynetiq.co.uk'
)
group by lower(l.linked_to)
order by lower(l.linked_to);
```

Expected:

```text
gvaccaro@silverlake.co.uk        205    205
ricki.mayhew@lkqsynetiq.co.uk    361    361
```

---

### Task 4: Optional Rollback If Verification Fails

**Files:**
- No file changes.

- [ ] **Step 1: Roll listing ownership back to ReBattery Sales**

Only run this if Task 3 fails and the business decision is to revert listing ownership while keeping the contact users/accounts for later reuse.

Run this Supabase SQL:

```sql
do $$
declare
  reverted_count integer;
begin
  update public.listings
  set
    supplier_account_id = '15f92a7a-61be-4648-b328-3d49ab99690e',
    created_by_user_id = '972e879c-b263-452e-b5b1-e1c43a23c3b4',
    updated_at = now()
  where lower(linked_to) in (
    'gvaccaro@silverlake.co.uk',
    'ricki.mayhew@lkqsynetiq.co.uk'
  )
    and supplier_account_id in (
      select id from public.accounts where lower(name) in ('silverlake automotive recycling', 'lkq synetiq')
    )
    and created_by_user_id in (
      select id from public.users where lower(email) in ('gvaccaro@silverlake.co.uk', 'ricki.mayhew@lkqsynetiq.co.uk')
    );

  get diagnostics reverted_count = row_count;

  if reverted_count <> 566 then
    raise exception 'Rollback aborted: expected to update 566 listings, updated %', reverted_count;
  end if;
end $$;
```

Expected:

```text
DO
```

`DO` indicates successful completion of the rollback block. The block explicitly raises an exception and rolls back transaction changes unless exactly `566` listings are updated.

- [ ] **Step 2: Verify rollback**

Run this Supabase SQL:

```sql
select
  lower(linked_to) as linked_to,
  supplier_account_id,
  created_by_user_id,
  count(*) as listing_count
from public.listings
where supplier_account_id = '15f92a7a-61be-4648-b328-3d49ab99690e'
  and created_by_user_id = '972e879c-b263-452e-b5b1-e1c43a23c3b4'
  and lower(linked_to) in (
    'gvaccaro@silverlake.co.uk',
    'ricki.mayhew@lkqsynetiq.co.uk'
  )
group by lower(linked_to), supplier_account_id, created_by_user_id
order by lower(linked_to);
```

Expected:

```text
gvaccaro@silverlake.co.uk        205
ricki.mayhew@lkqsynetiq.co.uk    361
```

---

### Task 5: Commit The Plan And SQL Artifact If Requested

**Files:**
- Add: `docs/superpowers/plans/2026-05-02-transfer-imported-listings-to-supplier-contacts.md`
- Add: `docs/superpowers/migrations/20260502184833_transfer_imported_listings_to_supplier_contacts.sql`

- [ ] **Step 1: Review local status**

Run:

```bash
git status --short --branch
```

Expected:

```text
The migration documentation/artifact files are present as untracked or modified. Existing unrelated dirty files may also be present; do not stage them.
```

- [ ] **Step 2: Commit only these migration documentation/artifact files if the user requests a commit**

Run:

```bash
git add docs/superpowers/plans/2026-05-02-transfer-imported-listings-to-supplier-contacts.md
git add docs/superpowers/migrations/20260502184833_transfer_imported_listings_to_supplier_contacts.sql
git commit -m "Document imported listing ownership migration"
```

Expected:

```text
Commit succeeds with only these migration documentation/artifact files staged.
```

---

## Self-Review

- Spec coverage: The plan transfers listings from `admin@rebattery.io` / `ReBattery Sales` to company accounts and contact-person users for both Silverlake and Synetiq, with exact row counts, verification, and rollback.
- Placeholder scan: No placeholder markers or undefined follow-up steps remain.
- Type consistency: SQL uses existing table and column names verified from Supabase: `public.users.email`, `public.accounts.name`, `public.account_memberships`, `public.listings.supplier_account_id`, `public.listings.created_by_user_id`, and `public.listings.linked_to`.
- Type consistency: `public.account_memberships(user_id, account_id)` has a unique constraint for `on conflict`; user and account inserts use explicit duplicate guards plus `where not exists` so case variants do not create duplicate business entities.
