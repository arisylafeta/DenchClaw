-- Folder-backed template metadata; additive and safe to reapply.
alter table mail_template add column if not exists meta jsonb not null default '{}'::jsonb;
