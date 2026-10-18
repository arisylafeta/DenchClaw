-- Buyer context is historical evidence, not an open buying request.
alter table crm_company_context_notes add column if not exists category text not null default 'note';
alter table crm_company_context_notes add column if not exists source_url text;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'crm_company_context_notes'::regclass and conname = 'crm_company_context_notes_category_check') then
    alter table crm_company_context_notes add constraint crm_company_context_notes_category_check
      check (category in ('ask', 'bid', 'offer_reply', 'project', 'preference', 'trading_style', 'past_deal', 'note'));
  end if;
end $$;
create table if not exists crm_data_migrations (id text primary key, applied_at timestamptz not null default now());
do $$ begin
  insert into crm_data_migrations (id) values ('049_company_context_categories') on conflict do nothing;
  if found then
    update crm_company_context_notes set category = 'trading_style'
    where id in ('ccn_review_attero_20261016', 'ccn_review_volta_20261016', 'ccn_review_grandtai_20261016') and category = 'note';
  end if;
end $$;
