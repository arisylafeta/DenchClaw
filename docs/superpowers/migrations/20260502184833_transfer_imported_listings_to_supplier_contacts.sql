-- Mirrors the already applied Supabase migration: transfer_imported_listings_to_supplier_contacts.
-- This is an intentionally guarded one-time data migration, not an idempotent replay script.
-- It is replay-protected by exact row-count assertions (205 Silverlake, 361 Synetiq)
-- and is expected to raise if executed again after a successful run.
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
