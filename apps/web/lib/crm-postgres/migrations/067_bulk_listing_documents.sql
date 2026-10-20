-- Documents: every file, link and wanted document of a bulk listing in one table with a lifecycle.
--   crm_bulk_listing_files  ->  crm_bulk_listing_documents  (title, type, state, direction, url, note; content is optional)
--   crm_bulk_trade_files    ->  compatibility view over the documents that hold a file, so the existing trade file
--                               routes and the Python writers keep working (old table kept as _legacy).
--   crm_bulk_document_types registry of document types (in the database, like the attribute registry).
-- Needed documents are rows without content: they start from context.missing_documents on demand listings.
-- Also: trades (lots) now mirror into crm_bulk_listings continuously, so a new trade always has its listing row.
-- Apply only after a current backup and explicit schema approval. Run through the cutover wrapper (locks the old table).
begin;

-- Document types.
create table if not exists crm_bulk_document_types (
  doc_type text primary key,
  label text not null,
  sort_order integer not null
);
insert into crm_bulk_document_types (doc_type, label, sort_order) values
  ('Photos', 'Photos', 1), ('Stock list', 'Stock list', 2), ('Test report', 'Test report', 3), ('Datasheet', 'Datasheet', 4),
  ('Transport documents', 'Transport documents', 5), ('RFQ', 'RFQ', 6), ('RFS', 'RFS', 7), ('Proposal', 'Proposal', 8),
  ('Quote', 'Quote', 9), ('NDA', 'NDA', 10), ('Contract', 'Contract', 11), ('Order', 'Order', 12), ('Deck', 'Deck', 13), ('Other', 'Other', 14)
on conflict do nothing;
grant select on crm_bulk_document_types to crm_web_sql;
grant select, insert, update, delete on crm_bulk_document_types to crm_agent_sql;

-- Files become documents.
alter table crm_bulk_listing_files rename to crm_bulk_listing_documents;
alter table crm_bulk_listing_documents rename constraint crm_bulk_listing_files_pkey to crm_bulk_listing_documents_pkey;
alter table crm_bulk_listing_documents rename constraint crm_bulk_listing_files_byte_size_check to crm_bulk_listing_documents_byte_size_check;
alter table crm_bulk_listing_documents rename constraint crm_bulk_listing_files_visibility_check to crm_bulk_listing_documents_visibility_check;
alter index crm_bulk_listing_files_listing_idx rename to crm_bulk_listing_documents_listing_idx;
alter table crm_bulk_listing_documents
  add column if not exists title text,
  add column if not exists doc_type text,
  add column if not exists state text not null default 'received'
    check (state in ('needed', 'requested', 'received', 'draft', 'sent', 'signed')),
  add column if not exists direction text not null default 'received' check (direction in ('received', 'sent', 'prepared')),
  add column if not exists url text,
  add column if not exists note text,
  add column if not exists updated_at timestamptz not null default now();
alter table crm_bulk_listing_documents alter column file_name drop not null;
alter table crm_bulk_listing_documents alter column byte_size drop not null;
alter table crm_bulk_listing_documents alter column content drop not null;
alter table crm_bulk_listing_documents alter column file_type drop not null;
update crm_bulk_listing_documents set title = coalesce(title, file_name), doc_type = coalesce(doc_type, file_type, 'Other');
alter table crm_bulk_listing_documents alter column title set not null;
alter table crm_bulk_listing_documents alter column doc_type set not null;
alter table crm_bulk_listing_documents add constraint crm_bulk_listing_documents_has_substance
  check (state in ('needed', 'requested') or content is not null or url is not null);
alter table crm_bulk_listing_documents add constraint crm_bulk_listing_documents_title_check check (length(btrim(title)) > 0);
create index if not exists crm_bulk_listing_documents_state_idx on crm_bulk_listing_documents (bulk_listing_id, state);

-- Status activity is skipped while a lot is mirrored into its listing.
create or replace function bulk_listing_status_activity() returns trigger language plpgsql as $$
begin
  if current_setting('bulk.skip_status_activity', true) = 'on' then return new; end if;
  if TG_OP = 'INSERT' then
    insert into crm_bulk_listing_activity (bulk_listing_id, kind, title, data)
    values (new.id, 'status', initcap(new.status), jsonb_build_object('status', new.status));
  elsif old.status is distinct from new.status then
    insert into crm_bulk_listing_activity (bulk_listing_id, kind, title, data)
    values (new.id, 'status', case when new.status = 'closed' then 'Closed · ' || coalesce(new.closed_reason, 'closed')
      when new.status = 'open' then 'Opened' else 'Qualifying' end,
      jsonb_build_object('from', old.status, 'status', new.status, 'reason', new.closed_reason));
  elsif new.status = 'closed' and old.closed_reason is distinct from new.closed_reason then
    insert into crm_bulk_listing_activity (bulk_listing_id, kind, title, data)
    values (new.id, 'status', 'Category · ' || new.closed_reason,
      jsonb_build_object('from_reason', old.closed_reason, 'reason', new.closed_reason, 'status', new.status));
  end if;
  return new;
end $$;

-- Trades mirror into listings (same id, same mapping as the original backfill).
create or replace function bulk_lot_listing_sync() returns trigger language plpgsql as $$
begin
  perform set_config('bulk.skip_status_activity', 'on', true);
  insert into crm_bulk_listings (id, kind, party, summary, quantity, status, closed_reason, observed_on, spec, context, created_at, updated_at)
  values (new.id, 'supply',
    coalesce(nullif(btrim(new.seller_name), ''), nullif(btrim(new.seller_ref), ''), 'Unknown seller'),
    coalesce(nullif(btrim(new.summary), ''), new.title),
    nullif(concat_ws(' ', new.observed_quantity::text, new.quantity_unit), ''),
    case when new.trade_stage in ('Done', 'Lost') then 'closed' else 'open' end,
    case new.trade_stage when 'Done' then 'sold' when 'Lost' then 'gone' end,
    new.created_at::date,
    jsonb_strip_nulls(to_jsonb(new) - 'id' - 'title' - 'summary' - 'created_at' - 'updated_at') || jsonb_build_object('is_trade', true),
    jsonb_build_object('listing_title', new.title), new.created_at, new.updated_at)
  on conflict (id) do update set
    party = excluded.party, summary = excluded.summary, quantity = excluded.quantity, status = excluded.status,
    closed_reason = excluded.closed_reason, spec = excluded.spec, context = excluded.context, updated_at = excluded.updated_at;
  perform set_config('bulk.skip_status_activity', 'off', true);
  return new;
end $$;
drop trigger if exists bulk_lot_listing_sync on crm_bulk_trade_lots;
create trigger bulk_lot_listing_sync after insert or update on crm_bulk_trade_lots
  for each row execute function bulk_lot_listing_sync();

-- Make sure every trade has its listing row now (the trigger fires on any update).
update crm_bulk_trade_lots set id = id;

-- Last sync of trade files before the swap (anything written since the first backfill).
insert into crm_bulk_listing_documents (id, bulk_listing_id, title, doc_type, file_name, file_type, content_type, byte_size, content,
  source_label, source_date, visibility, uploaded_by, created_at)
select f.id, f.lot_id, f.file_name, f.file_type, f.file_name, f.file_type, f.content_type, f.byte_size, f.content,
  f.source_label, f.source_date, f.visibility, f.uploaded_by, f.created_at
from crm_bulk_trade_files f
on conflict (id) do nothing;

-- Documents the agents recorded as missing become needed documents (the original text is the title).
insert into crm_bulk_listing_documents (id, bulk_listing_id, title, doc_type, state, direction, note, visibility, created_at)
select 'bdoc_' || md5(l.id || ':' || d.text), l.id, left(d.text, 300), 'Other', 'needed', 'received',
  case when length(d.text) > 300 then d.text end, 'never', now()
from crm_bulk_listings l, jsonb_array_elements_text(l.context->'missing_documents') as d(text)
where l.kind = 'demand' and btrim(d.text) <> ''
on conflict (id) do nothing;

-- Swap: the old trade files table becomes a view over documents that hold a file.
alter table crm_bulk_trade_files rename to crm_bulk_trade_files_legacy;
create view crm_bulk_trade_files as
select d.id, d.bulk_listing_id as lot_id, d.file_name, d.file_type, d.content_type, d.byte_size, d.content,
  d.source_label, d.source_date, d.visibility, d.uploaded_by, d.created_at
from crm_bulk_listing_documents d where d.content is not null;

create or replace function bulk_trade_files_view_write() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then delete from crm_bulk_listing_documents where id = OLD.id; return OLD; end if;
  if TG_OP = 'INSERT' then
    insert into crm_bulk_listing_documents (id, bulk_listing_id, title, doc_type, file_name, file_type, content_type, byte_size, content,
      source_label, source_date, visibility, uploaded_by, created_at)
    values (NEW.id, NEW.lot_id, NEW.file_name, NEW.file_type, NEW.file_name, NEW.file_type, NEW.content_type, NEW.byte_size, NEW.content,
      NEW.source_label, NEW.source_date, coalesce(NEW.visibility, 'never'), NEW.uploaded_by, coalesce(NEW.created_at, now()));
    return NEW;
  end if;
  update crm_bulk_listing_documents set bulk_listing_id = NEW.lot_id, file_name = NEW.file_name, file_type = NEW.file_type,
    title = NEW.file_name, doc_type = NEW.file_type, content_type = NEW.content_type, byte_size = NEW.byte_size, content = NEW.content,
    source_label = NEW.source_label, source_date = NEW.source_date, visibility = NEW.visibility, uploaded_by = NEW.uploaded_by,
    updated_at = now()
  where id = OLD.id;
  return NEW;
end $$;
create trigger crm_bulk_trade_files_write instead of insert or update or delete on crm_bulk_trade_files
  for each row execute function bulk_trade_files_view_write();

grant select on crm_bulk_listing_documents, crm_bulk_trade_files to crm_web_sql;
grant select, insert, update, delete on crm_bulk_listing_documents, crm_bulk_trade_files to crm_agent_sql;

commit;
