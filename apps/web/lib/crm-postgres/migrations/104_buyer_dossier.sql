-- Buyer dossier (Matches 2.0 phase 3 + 6a).
-- A buyer dossier is Markdown with YAML frontmatter: who the company is and what it buys on an ongoing basis.
-- It lives in a column so database backups, the change log and transactions cover it.
-- `buyer_profile` becomes a derived copy: saveDossier() maps the dossier's products and rules_out onto the flat
-- keys today's readers use (chemistries, formats, makes, cell_makers, origins, wants, kwh_min, kwh_max, min_soh,
-- part_numbers) and carries the whole frontmatter under `dossier`.
-- Nothing reads the new columns until a company has a dossier.
-- Apply only after a current backup and explicit schema approval. Idempotent.
begin;

alter table crm_companies
  add column if not exists buyer_dossier text,
  add column if not exists buyer_dossier_version integer not null default 0,
  add column if not exists buyer_dossier_updated_at timestamptz,
  add column if not exists buyer_dossier_stale_since date,
  add column if not exists buyer_dossier_stale_reasons jsonb not null default '[]'::jsonb;

-- Saved searches are the buyer's own marketplace alerts. For a company with a dossier they are also recorded as a
-- dated context note, so the Buyer tab lists them as alerts until the refresh agent folds them into the text.
do $$ begin
  alter table crm_company_context_notes drop constraint if exists crm_company_context_notes_category_check;
  alter table crm_company_context_notes add constraint crm_company_context_notes_category_check
    check (category in ('ask', 'bid', 'offer_reply', 'project', 'preference', 'trading_style', 'past_deal', 'note',
                        'saved_search'));
end $$;

-- One write path. Once a company has a dossier, buyer_profile and buyer_dossier change only inside the dossier write
-- function, which sets crm.dossier_write = 'on' for the length of its transaction. Every other writer (the generic
-- entry update, the enrich route, a manual SQL edit) fails loudly instead of silently diverging from the dossier.
-- The first load that sets a dossier from null goes through the same path, on UPDATE and on INSERT alike: a company
-- created with dossier text must use the setting too, while buyer_profile alone stays free on insert (creating a
-- lead keeps writing the profile it inferred). The stale columns are deliberately not guarded: intake marks a
-- dossier stale without touching its text.
create or replace function crm_guard_buyer_dossier() returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('crm.dossier_write', true), '') = 'on' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.buyer_dossier is not null then
      raise exception using
        errcode = 'check_violation',
        message = format('company %s has a buyer dossier: buyer_dossier is written only by the dossier write path '
                         '(set crm.dossier_write = ''on'' in that transaction)', new.id);
    end if;
    return new;
  end if;
  if (old.buyer_dossier is not null or new.buyer_dossier is not null)
     and (new.buyer_profile is distinct from old.buyer_profile
          or new.buyer_dossier is distinct from old.buyer_dossier) then
    raise exception using
      errcode = 'check_violation',
      message = format('company %s has a buyer dossier: buyer_profile and buyer_dossier are written only by the '
                       'dossier write path (set crm.dossier_write = ''on'' in that transaction)', new.id);
  end if;
  return new;
end $$;

drop trigger if exists trg_crm_companies_guard_buyer_dossier on crm_companies;
create trigger trg_crm_companies_guard_buyer_dossier
  before insert or update on crm_companies
  for each row execute function crm_guard_buyer_dossier();

-- The existing crm_log_buyer_profile_change trigger already logs every buyer_* column, so each dossier save and each
-- stale mark lands in crm_buyer_profile_changes without further work.

insert into crm_data_migrations (id) values ('104_buyer_dossier') on conflict do nothing;
commit;
