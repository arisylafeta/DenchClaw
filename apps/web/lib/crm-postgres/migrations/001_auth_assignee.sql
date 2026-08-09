create extension if not exists pgcrypto;
create table if not exists crm_users (id uuid primary key default gen_random_uuid(), email text not null unique, password_hash text not null, is_active boolean not null default true, failed_login_count integer not null default 0, locked_until timestamptz, last_login_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table if not exists crm_sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null references crm_users(id) on delete cascade, token_hash text not null unique, expires_at timestamptz not null, revoked_at timestamptz, created_at timestamptz not null default now(), last_seen_at timestamptz not null default now());
alter table work_tasks add column if not exists assignee_id uuid references crm_users(id) on delete set null;
create index if not exists crm_sessions_active_idx on crm_sessions(token_hash, expires_at) where revoked_at is null;
create index if not exists work_tasks_assignee_idx on work_tasks(assignee_id);
