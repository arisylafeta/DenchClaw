begin;

-- Mailbox ownership is explicit and deny-by-default. Historical rows remain
-- nullable until a trusted mailbox sync recreates or attributes them.
alter table crm_email_threads
  add column if not exists mailbox_owner_id uuid references crm_users(id) on delete restrict;
alter table crm_email_messages
  add column if not exists mailbox_owner_id uuid references crm_users(id) on delete restrict;

-- Gmail identifiers are mailbox-scoped. Remove legacy global uniqueness so the
-- same Gmail message can safely exist in both Ari's and Alex's mailboxes.
alter table crm_email_threads drop constraint if exists crm_email_threads_gmail_thread_id_key;
alter table crm_email_messages drop constraint if exists crm_email_messages_gmail_message_id_key;
create unique index if not exists crm_email_threads_owner_gmail_uidx
  on crm_email_threads(mailbox_owner_id, gmail_thread_id)
  where mailbox_owner_id is not null and gmail_thread_id is not null;
create unique index if not exists crm_email_messages_owner_gmail_uidx
  on crm_email_messages(mailbox_owner_id, gmail_message_id)
  where mailbox_owner_id is not null and gmail_message_id is not null;
create index if not exists crm_email_threads_owner_last_idx
  on crm_email_threads(mailbox_owner_id, last_message_at desc);
create index if not exists crm_email_messages_owner_thread_idx
  on crm_email_messages(mailbox_owner_id, thread_id, sent_at desc);

-- Reconcile the legacy text assignee only when it maps exactly to an active
-- invite-only identity. Unmatched and ambiguous values remain unassigned.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'work_tasks' and column_name = 'assignee_email'
  ) then
    execute $sql$
      update work_tasks task
         set assignee_id = crm_user.id
        from crm_users crm_user
       where task.assignee_id is null
         and task.assignee_email is not null
         and lower(btrim(task.assignee_email)) = lower(crm_user.email)
         and crm_user.is_active
         and lower(crm_user.email) in ('ari@rebattery.io', 'alex@rebattery.io')
    $sql$;
  end if;
end
$$;

commit;
