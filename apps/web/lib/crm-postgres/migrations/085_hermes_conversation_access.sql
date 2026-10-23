begin;
create schema hermes_security;
revoke all on schema hermes_security from public;
create table hermes_security.conversation_access (
  kind text not null check (kind in ('solo','group')),
  profile text not null,
  stored_id text not null check (stored_id <> ''),
  creator_id uuid references crm_users(id),
  owner_id uuid references crm_users(id),
  origin text not null,
  visibility text not null check (visibility in ('private','team')),
  version bigint not null default 1,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  primary key(kind,profile,stored_id),
  check ((kind='group' and profile='') or (kind='solo' and profile<>'')),
  check ((owner_id is not null and creator_id is not null) or (owner_id is null and creator_id is null and visibility='team' and origin in ('discord','whatsapp','cli','tui','telegram','slack','signal','matrix','mattermost','sms','email','cron','webhook')))
);
create function hermes_security.protect_conversation_identity() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' then raise exception 'Conversation access tombstones must be retained'; end if;
  if (new.kind,new.profile,new.stored_id,new.creator_id,new.owner_id,new.origin) is distinct from (old.kind,old.profile,old.stored_id,old.creator_id,old.owner_id,old.origin) or old.deleted_at is not null then
    raise exception 'Conversation identity and deletion are immutable';
  end if;
  new.version := old.version + 1;
  return new;
end $$;
create trigger hermes_conversation_access_immutable before update or delete on hermes_security.conversation_access for each row execute function hermes_security.protect_conversation_identity();
revoke all on hermes_security.conversation_access from public;
do $$ declare r text; begin
  foreach r in array array['crm_agent_sql','crm_web_sql'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on schema hermes_security from %I',r);
      execute format('revoke all on hermes_security.conversation_access from %I',r);
    end if;
  end loop;
end $$;
commit;
