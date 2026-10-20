-- Cutover: demand, supply and demand activity now live in crm_trade_listings / crm_trade_listing_activity.
-- The old table names stay as compatibility views with the same columns, so the app and the Python scripts keep
-- working unchanged while they are moved to the new tables one file at a time. The old tables are renamed *_legacy
-- (not dropped). Matches keep their own tables; their foreign keys now point at crm_trade_listings.
-- Run through scripts/migrate-trade-listings.sh, which locks the old tables, re-runs the 058 and 059 backfills to pick up
-- late writes, and applies this file in one transaction.
-- Dropped for good (never filled): demand.created_by, demand.moved_to, supply.est_value_usd. Writes to them are ignored.
-- Apply only after a current backup and explicit schema approval.

-- Moved-out keys of demand spec (the typed columns of the old table).
create or replace function trade_listing_demand_keys(s jsonb) returns jsonb language sql immutable as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from jsonb_each(s)
  where key in ('intent','basis','needed_by','volume','volume_unit','max_price','price_currency','price_unit','price_basis','fee_eur',
    'reputation','qualify_question','qualify_asked_on','qualify_entered_on','product_family','confirmed_on','supply_match_hash','priority')
$$;
create or replace function trade_listing_demand_rest(s jsonb) returns jsonb language sql immutable as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from jsonb_each(s)
  where key not in ('intent','basis','needed_by','volume','volume_unit','max_price','price_currency','price_unit','price_basis','fee_eur',
    'reputation','qualify_question','qualify_asked_on','qualify_entered_on','product_family','confirmed_on','supply_match_hash','priority')
$$;

alter table crm_trade_listings add constraint crm_trade_listings_demand_intent_check
  check (kind <> 'demand' or spec->>'intent' in ('request', 'standing'));

-- Repoint foreign keys at the listings table (ids are unchanged).
alter table crm_bulk_trade_demand_matches drop constraint crm_bulk_trade_demand_matches_demand_id_fkey;
alter table crm_bulk_trade_demand_matches add constraint crm_bulk_trade_demand_matches_demand_id_fkey
  foreign key (demand_id) references crm_trade_listings(id) on delete cascade;
alter table crm_bulk_trade_buyers drop constraint crm_bulk_trade_buyers_demand_id_fkey;
alter table crm_bulk_trade_buyers add constraint crm_bulk_trade_buyers_demand_id_fkey
  foreign key (demand_id) references crm_trade_listings(id) on delete set null;
alter table crm_bulk_trade_supply_matches drop constraint crm_bulk_trade_supply_matches_supply_id_fkey;
alter table crm_bulk_trade_supply_matches add constraint crm_bulk_trade_supply_matches_supply_id_fkey
  foreign key (supply_id) references crm_trade_listings(id) on delete cascade;
alter table crm_bulk_trade_supply_matches drop constraint crm_bulk_trade_supply_matches_demand_id_fkey;
alter table crm_bulk_trade_supply_matches add constraint crm_bulk_trade_supply_matches_demand_id_fkey
  foreign key (demand_id) references crm_trade_listings(id) on delete cascade;

-- Superseded by the match tables above; it was only a copy.
drop table crm_trade_matches;

-- Views that read the old tables are recreated on top of the compatibility views.
drop view crm_buyer_engagement;
drop view crm_bulk_trade_buyer_waiting;
drop view crm_bulk_trade_seller_candidates;
drop view crm_bulk_trade_supply_feed;

alter table crm_bulk_trade_demand rename to crm_bulk_trade_demand_legacy;
alter table crm_bulk_trade_supply rename to crm_bulk_trade_supply_legacy;
alter table crm_bulk_trade_demand_activity rename to crm_bulk_trade_demand_activity_legacy;
drop trigger bulk_demand_qualification_clock on crm_bulk_trade_demand_legacy;
drop trigger bulk_demand_status_activity on crm_bulk_trade_demand_legacy;

create view crm_bulk_trade_demand as
select l.id, l.party as buyer, l.company_id, l.person_id, l.contact, l.email, l.summary as wants, l.quantity, l.location, l.note,
  l.source_label, l.source_url, l.source_quote, l.status, l.closed_reason,
  (l.spec->>'confirmed_on')::date as confirmed_on, null::uuid as created_by, l.created_at, l.updated_at,
  l.spec->>'intent' as kind, l.spec->>'basis' as basis, (l.spec->>'needed_by')::date as needed_by,
  (l.spec->>'volume')::numeric as volume, l.spec->>'volume_unit' as volume_unit, (l.spec->>'max_price')::numeric as max_price,
  l.spec->>'price_currency' as price_currency, l.spec->>'price_unit' as price_unit,
  trade_listing_demand_rest(l.spec) as spec, l.source_kind, l.source_id, l.observed_on, l.match_hash,
  l.spec->>'supply_match_hash' as supply_match_hash, l.spec->>'product_family' as product_family,
  (l.spec->>'fee_eur')::numeric as fee_eur, l.spec->>'price_basis' as price_basis, l.spec->>'reputation' as reputation,
  l.spec->>'qualify_question' as qualify_question, null::text as moved_to,
  (l.spec->>'qualify_asked_on')::date as qualify_asked_on, (l.spec->>'qualify_entered_on')::date as qualify_entered_on,
  coalesce((l.spec->>'priority')::boolean, false) as priority, l.context, l.source_thread
from crm_trade_listings l where l.kind = 'demand';

create or replace function trade_demand_view_write() returns trigger language plpgsql as $$
declare moved jsonb; begin
  if TG_OP = 'DELETE' then delete from crm_trade_listings where id = OLD.id and kind = 'demand'; return OLD; end if;
  moved := jsonb_strip_nulls(jsonb_build_object('intent', coalesce(NEW.kind, 'standing'),
    'basis', case when coalesce(NEW.kind, 'standing') = 'standing' then coalesce(NEW.basis, 'stated') else NEW.basis end,
    'needed_by', NEW.needed_by, 'volume', NEW.volume, 'volume_unit', NEW.volume_unit, 'max_price', NEW.max_price,
    'price_currency', NEW.price_currency, 'price_unit', NEW.price_unit, 'price_basis', NEW.price_basis, 'fee_eur', NEW.fee_eur,
    'reputation', NEW.reputation, 'qualify_question', NEW.qualify_question, 'qualify_asked_on', NEW.qualify_asked_on,
    'qualify_entered_on', NEW.qualify_entered_on, 'product_family', NEW.product_family, 'confirmed_on', NEW.confirmed_on,
    'supply_match_hash', NEW.supply_match_hash, 'priority', case when NEW.priority then true end));
  if TG_OP = 'INSERT' then
    insert into crm_trade_listings (id, kind, party, company_id, person_id, contact, email, summary, quantity, location, note, status,
      closed_reason, observed_on, source_kind, source_id, source_thread, source_label, source_url, source_quote, match_hash, spec, context,
      created_at, updated_at)
    values (NEW.id, 'demand', NEW.buyer, NEW.company_id, NEW.person_id, NEW.contact, NEW.email, NEW.wants, NEW.quantity, NEW.location, NEW.note,
      coalesce(NEW.status, 'open'), NEW.closed_reason, NEW.observed_on, NEW.source_kind, NEW.source_id, NEW.source_thread, NEW.source_label,
      NEW.source_url, NEW.source_quote, NEW.match_hash, coalesce(NEW.spec, '{}'::jsonb) || moved, coalesce(NEW.context, '{}'::jsonb),
      coalesce(NEW.created_at, now()), coalesce(NEW.updated_at, now()))
    on conflict (id) do nothing;  -- lets 'insert ... on conflict do nothing' through the view behave as before
    return NEW;
  end if;
  update crm_trade_listings set id = NEW.id, party = NEW.buyer, company_id = NEW.company_id, person_id = NEW.person_id, contact = NEW.contact,
    email = NEW.email, summary = NEW.wants, quantity = NEW.quantity, location = NEW.location, note = NEW.note, status = NEW.status,
    closed_reason = NEW.closed_reason, observed_on = NEW.observed_on, source_kind = NEW.source_kind, source_id = NEW.source_id,
    source_thread = NEW.source_thread, source_label = NEW.source_label, source_url = NEW.source_url, source_quote = NEW.source_quote,
    match_hash = NEW.match_hash, spec = coalesce(NEW.spec, '{}'::jsonb) || moved, context = coalesce(NEW.context, '{}'::jsonb),
    created_at = NEW.created_at, updated_at = NEW.updated_at
  where id = OLD.id and kind = 'demand';
  return NEW;
end $$;
create trigger crm_bulk_trade_demand_write instead of insert or update or delete on crm_bulk_trade_demand
  for each row execute function trade_demand_view_write();

create view crm_bulk_trade_supply as
select l.id, l.party as seller, l.company_id, l.person_id, l.contact, l.email, l.summary as offers, l.spec->>'trade_kind' as trade_kind,
  l.quantity, l.location, (l.spec->>'est_tonnes')::numeric as est_tonnes, null::numeric as est_value_usd, l.spec->>'size_note' as size_note,
  l.source_kind, l.source_id, l.source_thread, l.source_label, l.source_url, l.source_quote, l.observed_on, l.status, l.closed_reason,
  l.match_hash, l.created_at, l.updated_at
from crm_trade_listings l where l.kind = 'supply' and not (l.spec ? 'is_trade');

create or replace function trade_supply_view_write() returns trigger language plpgsql as $$
declare moved jsonb; begin
  if TG_OP = 'DELETE' then delete from crm_trade_listings where id = OLD.id and kind = 'supply' and not (spec ? 'is_trade'); return OLD; end if;
  moved := jsonb_strip_nulls(jsonb_build_object('trade_kind', NEW.trade_kind, 'est_tonnes', NEW.est_tonnes, 'size_note', NEW.size_note));
  if TG_OP = 'INSERT' then
    insert into crm_trade_listings (id, kind, party, company_id, person_id, contact, email, summary, quantity, location, status, closed_reason,
      observed_on, source_kind, source_id, source_thread, source_label, source_url, source_quote, match_hash, spec, created_at, updated_at)
    values (NEW.id, 'supply', NEW.seller, NEW.company_id, NEW.person_id, NEW.contact, NEW.email, NEW.offers, NEW.quantity, NEW.location,
      coalesce(NEW.status, 'open'), NEW.closed_reason, NEW.observed_on, NEW.source_kind, NEW.source_id, NEW.source_thread, NEW.source_label,
      NEW.source_url, NEW.source_quote, NEW.match_hash, moved, coalesce(NEW.created_at, now()), coalesce(NEW.updated_at, now()))
    on conflict (id) do nothing;  -- lets 'insert ... on conflict do nothing' through the view behave as before
    return NEW;
  end if;
  update crm_trade_listings set id = NEW.id, party = NEW.seller, company_id = NEW.company_id, person_id = NEW.person_id, contact = NEW.contact,
    email = NEW.email, summary = NEW.offers, quantity = NEW.quantity, location = NEW.location, status = NEW.status,
    closed_reason = NEW.closed_reason, observed_on = NEW.observed_on, source_kind = NEW.source_kind, source_id = NEW.source_id,
    source_thread = NEW.source_thread, source_label = NEW.source_label, source_url = NEW.source_url, source_quote = NEW.source_quote,
    match_hash = NEW.match_hash, spec = (spec - 'trade_kind' - 'est_tonnes' - 'size_note') || moved,
    created_at = NEW.created_at, updated_at = NEW.updated_at
  where id = OLD.id and kind = 'supply' and not (spec ? 'is_trade');
  return NEW;
end $$;
create trigger crm_bulk_trade_supply_write instead of insert or update or delete on crm_bulk_trade_supply
  for each row execute function trade_supply_view_write();

create view crm_bulk_trade_demand_activity as
select a.id, a.listing_id as demand_id, a.kind, a.title, a.body, a.ref_kind, a.ref_id, a.data, a.actor_user_id, a.occurred_at, a.created_at
from crm_trade_listing_activity a join crm_trade_listings l on l.id = a.listing_id and l.kind = 'demand' where a.offer_id is null;

create or replace function trade_demand_activity_view_write() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then delete from crm_trade_listing_activity where id = OLD.id; return OLD; end if;
  if TG_OP = 'INSERT' then
    insert into crm_trade_listing_activity (id, listing_id, kind, title, body, ref_kind, ref_id, data, actor_user_id, occurred_at, created_at)
    values (coalesce(NEW.id, nextval(pg_get_serial_sequence('crm_trade_listing_activity', 'id'))), NEW.demand_id, NEW.kind, NEW.title, NEW.body,
      NEW.ref_kind, NEW.ref_id, coalesce(NEW.data, '{}'::jsonb), NEW.actor_user_id, coalesce(NEW.occurred_at, now()), coalesce(NEW.created_at, now()))
    returning id into NEW.id;
    return NEW;
  end if;
  update crm_trade_listing_activity set listing_id = NEW.demand_id, kind = NEW.kind, title = NEW.title, body = NEW.body, ref_kind = NEW.ref_kind,
    ref_id = NEW.ref_id, data = NEW.data, actor_user_id = NEW.actor_user_id, occurred_at = NEW.occurred_at where id = OLD.id;
  return NEW;
end $$;
create trigger crm_bulk_trade_demand_activity_write instead of insert or update or delete on crm_bulk_trade_demand_activity
  for each row execute function trade_demand_activity_view_write();

create view crm_bulk_trade_supply_feed as
 SELECT supply.id,
    'supply'::text AS kind,
    supply.offers AS title,
    supply.seller,
    supply.quantity AS size,
    supply.location,
    supply.observed_on::text AS seen,
    supply.status,
    '/?path=bulk_trade&supply='::text || supply.id AS href,
    ARRAY[supply.seller] AS suppliers,
    NULL::boolean AS verified,
    NULL::integer AS count
   FROM crm_bulk_trade_supply supply
  WHERE supply.status = 'open'::text
UNION ALL
 SELECT lot.id,
        CASE
            WHEN lot.auction_id IS NOT NULL THEN 'auction'::text
            ELSE 'trade'::text
        END AS kind,
    lot.title,
    bulk_trade_seller_display(lot.seller_ref, lot.seller_name) AS seller,
    COALESCE(( SELECT NULLIF(field.value, ''::text) AS "nullif"
           FROM crm_bulk_trade_fields field
          WHERE field.lot_id = lot.id AND field.field_key = 'quantity'::text), NULLIF(concat_ws(' '::text, lot.observed_quantity::text, lot.quantity_unit), ''::text)) AS size,
    ( SELECT field.value
           FROM crm_bulk_trade_fields field
          WHERE field.lot_id = lot.id AND field.field_key = 'location'::text) AS location,
    COALESCE(lot.latest_activity_at, lot.updated_at)::text AS seen,
    lot.trade_stage AS status,
    '/?path=bulk_trade&trade='::text || lot.id AS href,
    array_remove(ARRAY[bulk_trade_seller_display(lot.seller_ref, lot.seller_name)], NULL::text) AS suppliers,
    NULL::boolean AS verified,
    NULL::integer AS count
   FROM crm_bulk_trade_lots lot
  WHERE lot.origin = 'supply'::text AND (lot.trade_stage = ANY (ARRAY['Needs info'::text, 'With buyers'::text, 'Closing'::text])) AND (lot.auction_id IS NULL OR lot.auction_status = 'published'::text AND (lot.auction_closes_at IS NULL OR lot.auction_closes_at > now()))
UNION ALL
 SELECT 'stock:'::text || COALESCE(NULLIF(TRIM(BOTH FROM concat_ws(' '::text, stock.make, stock.model)), ''::text), 'Unspecified family'::text) AS id,
    'stock'::text AS kind,
    COALESCE(NULLIF(TRIM(BOTH FROM concat_ws(' '::text, stock.make, stock.model)), ''::text), 'Unspecified family'::text) AS title,
    string_agg(DISTINCT stock.supplier, ', '::text ORDER BY stock.supplier) AS seller,
    count(*)::text || ' stock rows'::text AS size,
    string_agg(DISTINCT NULLIF(stock.location, ''::text), ', '::text) AS location,
    max(stock.updated_at)::text AS seen,
        CASE
            WHEN bool_and(COALESCE(stock.supplier_confirmed, false)) THEN 'verified'::text
            ELSE 'unverified'::text
        END AS status,
    '/?path=stock'::text AS href,
    array_agg(DISTINCT stock.supplier ORDER BY stock.supplier) AS suppliers,
    bool_and(COALESCE(stock.supplier_confirmed, false)) AS verified,
    count(*)::integer AS count
   FROM crm_stock_items stock
  WHERE stock.stock_status <> ALL (ARRAY['sold'::text, 'unavailable'::text])
  GROUP BY (COALESCE(NULLIF(TRIM(BOTH FROM concat_ws(' '::text, stock.make, stock.model)), ''::text), 'Unspecified family'::text));

create view crm_bulk_trade_seller_candidates as
 WITH candidates AS (
         SELECT lot.id AS lot_id,
            company.id AS company_id,
            company.name AS company_name,
            party.display_name AS source_name,
            NULL::text AS email,
            0 AS rank,
            'Explicit supplier party'::text AS reason
           FROM crm_bulk_trade_lots lot
             JOIN crm_bulk_trade_parties party ON party.lot_id = lot.id AND party.role = 'supplier'::text
             LEFT JOIN crm_companies company ON company.id = party.company_id OR party.company_id IS NULL AND lower(company.name) = lower(party.display_name)
        UNION ALL
         SELECT lot.id,
            company.id,
            company.name,
            lot.seller_name,
            NULL::text,
            1,
            'Existing named supplier company; no buyer-side evidence'::text
           FROM crm_bulk_trade_lots lot
             JOIN crm_companies company ON lot.seller_ref = ('company:'::text || company.id)
          WHERE lot.seller_name !~ '@'::text AND (lower(lot.seller_name) <> ALL (ARRAY['seller'::text, 'supplier'::text, 'unknown'::text])) AND (('Supplier'::text = ANY (COALESCE(company.purpose, '{}'::text[]))) OR lower(company.platform_role) = 'supplier'::text)
        UNION ALL
         SELECT lot.id,
            company.id,
            company.name,
            person.full_name,
            contact.email,
            2,
                CASE
                    WHEN ('Supplier'::text = ANY (COALESCE(company.purpose, '{}'::text[]))) OR lower(company.platform_role) = 'supplier'::text THEN 'Trade contact resolves to a supplier company'::text
                    WHEN 'Dismantler'::text = ANY (COALESCE(company.purpose, '{}'::text[])) THEN 'Dismantler contact corroborated by a linked trade thread'::text
                    ELSE 'Incoming stock offer in an explicitly linked trade thread'::text
                END AS "case"
           FROM crm_bulk_trade_lots lot
             JOIN crm_bulk_trade_contacts contact ON contact.lot_id = lot.id
             JOIN crm_people person ON lower(person.email) = lower(contact.email)
             LEFT JOIN crm_companies company ON company.id = person.company_id
          WHERE ('Supplier'::text = ANY (COALESCE(company.purpose, '{}'::text[]))) OR lower(company.platform_role) = 'supplier'::text OR (EXISTS ( SELECT 1
                   FROM crm_bulk_trade_threads linked
                     JOIN mail_thread thread ON linked.thread_key = ('gmail:'::text || thread.gmail_thread_id)
                     JOIN mail_message message ON message.thread_id = thread.id AND lower(message.from_email) = lower(contact.email)
                  WHERE message.crm_visible AND message.direction = 'inbound'::text AND linked.lot_id = lot.id AND linked.verdict = 'trade'::text AND (('Dismantler'::text = ANY (COALESCE(company.purpose, '{}'::text[]))) OR concat_ws(' '::text, message.subject, message.body_preview) ~* '(we (currently )?have.{0,80}(available|stock)|asking price for|installation available|offering for sale)'::text)))
        ), safe AS (
         SELECT candidate.lot_id,
            candidate.company_id,
            candidate.company_name,
            candidate.source_name,
            candidate.email,
            candidate.rank,
            candidate.reason,
            COALESCE(NULLIF(candidate.company_name, ''::text),
                CASE
                    WHEN candidate.source_name !~ '@'::text AND lower(TRIM(BOTH FROM candidate.source_name)) !~ '^(seller|supplier|unknown|.*supplier route)$'::text THEN NULLIF(candidate.source_name, ''::text)
                    ELSE NULL::text
                END) AS display_name
           FROM candidates candidate
             LEFT JOIN crm_companies company ON company.id = candidate.company_id
          WHERE NOT (lower(COALESCE(company.platform_role, ''::text)) = 'buyer'::text OR ('Buyer'::text = ANY (COALESCE(company.purpose, '{}'::text[]))) OR ('buyer'::text = ANY (COALESCE(company.roles, '{}'::text[]))) OR company.buyer_stage IS NOT NULL OR company.buyer_tier IS NOT NULL OR (EXISTS ( SELECT 1
                   FROM crm_bulk_trade_demand demand
                  WHERE demand.company_id = candidate.company_id))) AND NOT (EXISTS ( SELECT 1
                   FROM crm_bulk_trade_parties party
                  WHERE party.lot_id = candidate.lot_id AND party.role = 'buyer'::text AND (party.company_id = candidate.company_id OR lower(party.display_name) = lower(candidate.company_name) OR lower(party.display_name) = lower(candidate.source_name)))) AND NOT (EXISTS ( SELECT 1
                   FROM crm_bulk_trade_buyers buyer
                     LEFT JOIN crm_people person ON person.id = buyer.person_id
                     LEFT JOIN crm_bulk_trade_demand demand ON demand.id = buyer.demand_id
                  WHERE buyer.lot_id = candidate.lot_id AND (person.company_id = candidate.company_id OR demand.company_id = candidate.company_id OR (lower(buyer.name) = ANY (ARRAY[lower(candidate.company_name), lower(candidate.source_name), lower(candidate.email)])) OR candidate.email IS NOT NULL AND POSITION((lower(candidate.email)) IN (lower(COALESCE(buyer.contact, ''::text)))) > 0 OR (EXISTS ( SELECT 1
                           FROM crm_people member
                          WHERE member.company_id = candidate.company_id AND (member.id = buyer.person_id OR lower(buyer.name) = lower(member.full_name) OR lower(buyer.name) = lower(member.email) OR POSITION((lower(member.email)) IN (lower(COALESCE(buyer.contact, ''::text)))) > 0)))))) AND NOT (EXISTS ( SELECT 1
                   FROM crm_bulk_trade_auction_people participant
                     LEFT JOIN crm_people person ON person.id = participant.person_id
                     LEFT JOIN crm_people address ON lower(address.email) = lower(participant.email)
                  WHERE participant.lot_id = candidate.lot_id AND (person.company_id = candidate.company_id OR address.company_id = candidate.company_id OR lower(participant.email) = lower(candidate.email) OR lower(split_part(participant.email, '@'::text, 2)) = lower(company.domain))))
        )
 SELECT DISTINCT ON (lot_id) lot_id,
    display_name AS seller_name,
        CASE
            WHEN company_id IS NOT NULL THEN 'company:'::text || company_id
            ELSE NULL::text
        END AS seller_ref,
    reason
   FROM safe
  WHERE display_name IS NOT NULL
  ORDER BY lot_id, rank, company_id, display_name;

create view crm_bulk_trade_buyer_waiting as
 WITH visible_messages AS (
         SELECT mail_message.id,
            mail_message.direction,
            mail_message.transport,
            mail_message.purpose,
            mail_message.identity_key,
            mail_message.mailbox_owner_id,
            mail_message.campaign_id,
            mail_message.thread_id,
            mail_message.subject,
            mail_message.body_text,
            mail_message.body_html,
            mail_message.body_preview,
            mail_message.from_email,
            mail_message.from_person_id,
            mail_message.to_emails,
            mail_message.cc_emails,
            mail_message.bcc_emails,
            mail_message.recipient_email,
            mail_message.person_id,
            mail_message.company_id,
            mail_message.listing_id,
            mail_message.auction_url,
            mail_message.personalization,
            mail_message.labels,
            mail_message.has_attachments,
            mail_message.state,
            mail_message.idempotency_key,
            mail_message.provider_message_id,
            mail_message.gmail_message_id,
            mail_message.rfc_message_id,
            mail_message.in_reply_to,
            mail_message.rfc_references,
            mail_message.claimed_at,
            mail_message.sent_at,
            mail_message.accepted_at,
            mail_message.delivered_at,
            mail_message.bounced_at,
            mail_message.opened_at,
            mail_message.clicked_at,
            mail_message.replied_at,
            mail_message.last_synced_at,
            mail_message.crm_visible,
            mail_message.crm_visible_reason,
            mail_message.created_at,
            mail_message.updated_at
           FROM mail_message
          WHERE mail_message.crm_visible AND NOT (mail_message.direction = 'outbound'::text AND mail_message.campaign_id IS NOT NULL)
        ), visible_recipients AS (
         SELECT r.message_id,
            r.person_id,
            r.recipient_type,
            r."position",
            r.created_at
           FROM mail_message_recipient r
             JOIN visible_messages m ON m.id = r.message_id
        ), buyers AS (
         SELECT p.id AS person_id,
            p.company_id,
            p.full_name,
            p.email
           FROM crm_people p
          WHERE (EXISTS ( SELECT 1
                   FROM crm_bulk_trade_demand d
                  WHERE d.status = 'open'::text AND (d.person_id = p.id OR d.company_id IS NOT NULL AND d.company_id = p.company_id))) OR (EXISTS ( SELECT 1
                   FROM crm_bulk_trade_buyers b_1
                     JOIN crm_bulk_trade_lots l ON l.id = b_1.lot_id
                  WHERE b_1.person_id = p.id AND (l.trade_stage = ANY (ARRAY['Needs info'::text, 'With buyers'::text, 'Closing'::text]))))
        ), inbound AS (
         SELECT DISTINCT ON (m.from_person_id) m.from_person_id AS person_id,
            m.sent_at,
            m.subject,
            m.thread_id
           FROM visible_messages m
             JOIN buyers b_1 ON b_1.person_id = m.from_person_id
          WHERE m.sent_at IS NOT NULL AND COALESCE(m.from_email, ''::text) !~* '@rebattery\.io$'::text AND COALESCE(m.subject, ''::text) !~* '^\s*(automatic reply|auto[- ]?reply|autoreply|out of (the )?office|abwesenheit)'::text
          ORDER BY m.from_person_id, m.sent_at DESC
        ), outbound AS (
         SELECT r.person_id,
            max(m.sent_at) AS sent_at
           FROM visible_recipients r
             JOIN visible_messages m ON m.id = r.message_id
             JOIN buyers b_1 ON b_1.person_id = r.person_id
          WHERE m.from_email ~* '@rebattery\.io$'::text
          GROUP BY r.person_id
        )
 SELECT b.person_id,
    b.company_id,
    b.full_name,
    b.email,
    i.sent_at AS last_in_at,
    i.subject AS last_in_subject,
    i.thread_id AS last_in_thread_id,
    o.sent_at AS last_out_at,
        CASE
            WHEN i.sent_at > COALESCE(o.sent_at, '-infinity'::timestamp with time zone) THEN i.sent_at
            ELSE NULL::timestamp with time zone
        END AS waiting_since
   FROM buyers b
     LEFT JOIN inbound i ON i.person_id = b.person_id
     LEFT JOIN outbound o ON o.person_id = b.person_id;

create view crm_buyer_engagement as
 WITH visible_messages AS (
         SELECT mail_message.id,
            mail_message.direction,
            mail_message.transport,
            mail_message.purpose,
            mail_message.identity_key,
            mail_message.mailbox_owner_id,
            mail_message.campaign_id,
            mail_message.thread_id,
            mail_message.subject,
            mail_message.body_text,
            mail_message.body_html,
            mail_message.body_preview,
            mail_message.from_email,
            mail_message.from_person_id,
            mail_message.to_emails,
            mail_message.cc_emails,
            mail_message.bcc_emails,
            mail_message.recipient_email,
            mail_message.person_id,
            mail_message.company_id,
            mail_message.listing_id,
            mail_message.auction_url,
            mail_message.personalization,
            mail_message.labels,
            mail_message.has_attachments,
            mail_message.state,
            mail_message.idempotency_key,
            mail_message.provider_message_id,
            mail_message.gmail_message_id,
            mail_message.rfc_message_id,
            mail_message.in_reply_to,
            mail_message.rfc_references,
            mail_message.claimed_at,
            mail_message.sent_at,
            mail_message.accepted_at,
            mail_message.delivered_at,
            mail_message.bounced_at,
            mail_message.opened_at,
            mail_message.clicked_at,
            mail_message.replied_at,
            mail_message.last_synced_at,
            mail_message.crm_visible,
            mail_message.crm_visible_reason,
            mail_message.created_at,
            mail_message.updated_at
           FROM mail_message
          WHERE mail_message.crm_visible AND NOT (mail_message.direction = 'outbound'::text AND mail_message.campaign_id IS NOT NULL)
        ), visible_recipients AS (
         SELECT r.message_id,
            r.person_id,
            r.recipient_type,
            r."position",
            r.created_at
           FROM mail_message_recipient r
             JOIN visible_messages m ON m.id = r.message_id
        ), campaign_messages AS (
         SELECT mail_message.id,
            mail_message.direction,
            mail_message.transport,
            mail_message.purpose,
            mail_message.identity_key,
            mail_message.mailbox_owner_id,
            mail_message.campaign_id,
            mail_message.thread_id,
            mail_message.subject,
            mail_message.body_text,
            mail_message.body_html,
            mail_message.body_preview,
            mail_message.from_email,
            mail_message.from_person_id,
            mail_message.to_emails,
            mail_message.cc_emails,
            mail_message.bcc_emails,
            mail_message.recipient_email,
            mail_message.person_id,
            mail_message.company_id,
            mail_message.listing_id,
            mail_message.auction_url,
            mail_message.personalization,
            mail_message.labels,
            mail_message.has_attachments,
            mail_message.state,
            mail_message.idempotency_key,
            mail_message.provider_message_id,
            mail_message.gmail_message_id,
            mail_message.rfc_message_id,
            mail_message.in_reply_to,
            mail_message.rfc_references,
            mail_message.claimed_at,
            mail_message.sent_at,
            mail_message.accepted_at,
            mail_message.delivered_at,
            mail_message.bounced_at,
            mail_message.opened_at,
            mail_message.clicked_at,
            mail_message.replied_at,
            mail_message.last_synced_at,
            mail_message.crm_visible,
            mail_message.crm_visible_reason,
            mail_message.created_at,
            mail_message.updated_at
           FROM mail_message
          WHERE mail_message.campaign_id IS NOT NULL
        ), people AS (
         SELECT crm_people.id AS person_id,
            crm_people.company_id
           FROM crm_people
          WHERE crm_people.company_id IS NOT NULL
        ), mail AS (
         SELECT p.company_id,
            max(m.sent_at) FILTER (WHERE m.from_person_id = p.person_id AND COALESCE(m.from_email, ''::text) !~* '@rebattery\.io$'::text) AS last_in_at,
            count(*) FILTER (WHERE m.from_person_id = p.person_id AND COALESCE(m.from_email, ''::text) !~* '@rebattery\.io$'::text AND m.sent_at > (now() - '90 days'::interval)) AS emails_in_90d
           FROM visible_messages m
             JOIN people p ON p.person_id = m.from_person_id
          GROUP BY p.company_id
        ), sent AS (
         SELECT p.company_id,
            max(m.sent_at) AS last_out_at,
            count(DISTINCT m.id) FILTER (WHERE m.sent_at > (now() - '90 days'::interval)) AS emails_out_90d
           FROM visible_recipients r
             JOIN visible_messages m ON m.id = r.message_id
             JOIN people p ON p.person_id = r.person_id
          WHERE m.from_email ~* '@rebattery\.io$'::text
          GROUP BY p.company_id
        ), meetings AS (
         SELECT p.company_id,
            count(DISTINCT a.event_id) AS meetings,
            max(e.start_at) AS last_meeting_at
           FROM crm_calendar_event_attendees a
             JOIN crm_calendar_events e ON e.id = a.event_id
             JOIN people p ON p.person_id = a.person_id
          GROUP BY p.company_id
        ), campaigns AS (
         SELECT COALESCE(s.company_id, p.company_id) AS company_id,
            count(*) FILTER (WHERE s.clicked_at IS NOT NULL) AS campaign_clicks,
            max(s.clicked_at) AS last_click_at
           FROM campaign_messages s
             LEFT JOIN people p ON p.person_id = s.person_id
          GROUP BY (COALESCE(s.company_id, p.company_id))
        ), auctions AS (
         SELECT p.company_id,
            sum(ap.view_count) AS auction_views,
            sum(ap.offer_count) AS auction_offers,
            max(ap.last_activity_at) AS last_auction_at
           FROM crm_bulk_trade_auction_people ap
             JOIN people p ON p.person_id = ap.person_id
          GROUP BY p.company_id
        ), trades AS (
         SELECT p.company_id,
            count(DISTINCT b.lot_id) AS trades_offered,
            count(DISTINCT b.lot_id) FILTER (WHERE b.status = 'Won'::text) AS trades_won,
            count(bid.id) AS bids,
            max(bid.created_at) AS last_bid_at
           FROM crm_bulk_trade_buyers b
             JOIN people p ON p.person_id = b.person_id
             LEFT JOIN crm_bulk_trade_bids bid ON bid.buyer_id = b.id
          GROUP BY p.company_id
        ), demand AS (
         SELECT crm_bulk_trade_demand.company_id,
            count(*) FILTER (WHERE crm_bulk_trade_demand.status = 'open'::text AND crm_bulk_trade_demand.kind = 'request'::text) AS open_requests,
            count(*) FILTER (WHERE crm_bulk_trade_demand.status = 'open'::text AND crm_bulk_trade_demand.kind = 'standing'::text) AS open_buy_boxes,
            count(*) FILTER (WHERE crm_bulk_trade_demand.status = 'open'::text AND crm_bulk_trade_demand.kind = 'standing'::text AND crm_bulk_trade_demand.basis = 'agreed'::text) AS agreed_buy_boxes,
            count(*) FILTER (WHERE crm_bulk_trade_demand.source_kind = 'survey'::text) AS surveys
           FROM crm_bulk_trade_demand
          WHERE crm_bulk_trade_demand.company_id IS NOT NULL
          GROUP BY crm_bulk_trade_demand.company_id
        ), waiting AS (
         SELECT crm_bulk_trade_buyer_waiting.company_id,
            min(crm_bulk_trade_buyer_waiting.waiting_since) AS waiting_since
           FROM crm_bulk_trade_buyer_waiting
          WHERE crm_bulk_trade_buyer_waiting.waiting_since IS NOT NULL AND crm_bulk_trade_buyer_waiting.company_id IS NOT NULL
          GROUP BY crm_bulk_trade_buyer_waiting.company_id
        )
 SELECT c.id AS company_id,
    mail.last_in_at,
    sent.last_out_at,
    waiting.waiting_since,
    COALESCE(mail.emails_in_90d, 0::bigint) AS emails_in_90d,
    COALESCE(sent.emails_out_90d, 0::bigint) AS emails_out_90d,
    COALESCE(meetings.meetings, 0::bigint) AS meetings,
    meetings.last_meeting_at,
    COALESCE(campaigns.campaign_clicks, 0::bigint) AS campaign_clicks,
    campaigns.last_click_at,
    COALESCE(auctions.auction_views, 0::bigint) AS auction_views,
    COALESCE(auctions.auction_offers, 0::bigint) AS auction_offers,
    auctions.last_auction_at,
    COALESCE(trades.trades_offered, 0::bigint) AS trades_offered,
    COALESCE(trades.trades_won, 0::bigint) AS trades_won,
    COALESCE(trades.bids, 0::bigint) AS bids,
    trades.last_bid_at,
    COALESCE(demand.open_requests, 0::bigint) AS open_requests,
    COALESCE(demand.open_buy_boxes, 0::bigint) AS open_buy_boxes,
    COALESCE(demand.agreed_buy_boxes, 0::bigint) AS agreed_buy_boxes,
    COALESCE(demand.surveys, 0::bigint) AS surveys,
    GREATEST(mail.last_in_at, meetings.last_meeting_at, campaigns.last_click_at, auctions.last_auction_at, trades.last_bid_at) AS last_heard_at,
        CASE
            WHEN COALESCE(trades.trades_won, 0::bigint) > 0 THEN 'Customer'::text
            WHEN COALESCE(trades.bids, 0::bigint) > 0 OR COALESCE(auctions.auction_offers, 0::bigint) > 0 THEN 'Bidding'::text
            WHEN COALESCE(meetings.meetings, 0::bigint) > 0 OR mail.last_in_at IS NOT NULL AND sent.last_out_at IS NOT NULL AND COALESCE(mail.emails_in_90d, 0::bigint) >= 2 THEN 'In conversation'::text
            WHEN mail.last_in_at IS NOT NULL OR campaigns.last_click_at IS NOT NULL OR COALESCE(auctions.auction_views, 0::bigint) > 0 OR COALESCE(demand.surveys, 0::bigint) > 0 THEN 'Responded'::text
            WHEN sent.last_out_at IS NOT NULL THEN 'Contacted'::text
            ELSE 'Identified'::text
        END AS suggested_stage
   FROM crm_companies c
     LEFT JOIN mail ON mail.company_id = c.id
     LEFT JOIN sent ON sent.company_id = c.id
     LEFT JOIN meetings ON meetings.company_id = c.id
     LEFT JOIN campaigns ON campaigns.company_id = c.id
     LEFT JOIN auctions ON auctions.company_id = c.id
     LEFT JOIN trades ON trades.company_id = c.id
     LEFT JOIN demand ON demand.company_id = c.id
     LEFT JOIN waiting ON waiting.company_id = c.id;

grant select on crm_bulk_trade_supply_feed to crm_agent_sql;
grant select on crm_bulk_trade_supply_feed to crm_web_sql;
grant select on crm_bulk_trade_seller_candidates to crm_agent_sql;
grant select on crm_bulk_trade_seller_candidates to crm_web_sql;
grant select on crm_bulk_trade_buyer_waiting to crm_agent_sql;
grant select on crm_bulk_trade_buyer_waiting to crm_web_sql;
grant select on crm_buyer_engagement to crm_agent_sql;
grant select on crm_buyer_engagement to crm_web_sql;

-- Same access as the old tables.
grant select on crm_trade_listings, crm_trade_listing_activity, crm_trade_offers, crm_trade_listing_fields, crm_trade_listing_files,
  crm_bulk_trade_demand, crm_bulk_trade_supply, crm_bulk_trade_demand_activity to crm_web_sql;
grant select, insert, update, delete on crm_trade_listings, crm_trade_listing_activity, crm_trade_offers, crm_trade_listing_fields,
  crm_trade_listing_files, crm_bulk_trade_demand, crm_bulk_trade_supply, crm_bulk_trade_demand_activity to crm_agent_sql;
grant usage, select on sequence crm_trade_listing_activity_id_seq to crm_agent_sql;
