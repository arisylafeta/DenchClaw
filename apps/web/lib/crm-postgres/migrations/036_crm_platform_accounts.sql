-- Apply only after a current backup and explicit schema approval.
-- CRM person IDs are text; auth and platform account IDs are UUIDs.
create table if not exists crm_platform_accounts (
  auth_user_id uuid primary key,
  person_id text references crm_people(id) on delete set null,
  account_id uuid,
  account_role text,
  account_status text,
  email text,
  match_method text not null check (match_method in ('email_exact', 'manual', 'unmatched')),
  review_status text not null default 'auto' check (review_status in ('auto', 'needs_review', 'confirmed', 'rejected')),
  auth_created_at timestamptz,
  last_sign_in_at timestamptz,
  linked_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists crm_platform_accounts_person_idx on crm_platform_accounts(person_id);
create index if not exists crm_platform_accounts_review_idx on crm_platform_accounts(review_status);
