-- Relay context pack: what a draft was written from besides the thread and the deal (earlier emails, the CRM record,
-- the person's other deals, attached files), as [{"label", "text"}]. Kept on the draft so the "before you send" check
-- can tell a figure taken from an attached quote from an invented one. Empty for drafts made before this.
begin;
alter table relay_draft add column if not exists background jsonb not null default '[]'::jsonb;
commit;
