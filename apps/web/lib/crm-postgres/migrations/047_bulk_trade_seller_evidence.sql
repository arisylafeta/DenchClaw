-- A contact is not a seller. Resolve only supplier-side identities, then reject every
-- known buyer, bidder and auction participant. Keep unknown inventory owners blank.
create or replace view crm_bulk_trade_seller_candidates as
with candidates as (
  select lot.id as lot_id, company.id as company_id, company.name as company_name,
    party.display_name as source_name, null::text as email, 0 as rank,
    'Explicit supplier party'::text as reason
  from crm_bulk_trade_lots lot
  join crm_bulk_trade_parties party on party.lot_id = lot.id and party.role = 'supplier'
  left join crm_companies company on company.id = party.company_id
    or (party.company_id is null and lower(company.name) = lower(party.display_name))
  union all
  select lot.id, company.id, company.name, lot.seller_name, null, 1,
    'Existing named supplier company; no buyer-side evidence'
  from crm_bulk_trade_lots lot
  join crm_companies company on lot.seller_ref = 'company:' || company.id
  where lot.seller_name !~ '@' and lower(lot.seller_name) not in ('seller', 'supplier', 'unknown')
    and ('Supplier' = any(coalesce(company.purpose, '{}'::text[])) or lower(company.platform_role) = 'supplier')
  union all
  select lot.id, company.id, company.name, person.full_name, contact.email, 2,
    case when 'Supplier' = any(coalesce(company.purpose, '{}'::text[])) or lower(company.platform_role) = 'supplier'
      then 'Trade contact resolves to a supplier company'
      when 'Dismantler' = any(coalesce(company.purpose, '{}'::text[]))
      then 'Dismantler contact corroborated by a linked trade thread'
      else 'Incoming stock offer in an explicitly linked trade thread' end
  from crm_bulk_trade_lots lot
  join crm_bulk_trade_contacts contact on contact.lot_id = lot.id
  join crm_people person on lower(person.email) = lower(contact.email)
  left join crm_companies company on company.id = person.company_id
  where 'Supplier' = any(coalesce(company.purpose, '{}'::text[])) or lower(company.platform_role) = 'supplier'
    or exists (
      select 1 from crm_bulk_trade_threads linked
      join crm_email_threads thread on linked.thread_key = 'gmail:' || thread.gmail_thread_id
      join crm_email_messages message on message.thread_id = thread.id and lower(message.from_email) = lower(contact.email)
      where linked.lot_id = lot.id and linked.verdict = 'trade'
        and ('Dismantler' = any(coalesce(company.purpose, '{}'::text[]))
          or concat_ws(' ', message.subject, message.body_preview) ~* '(we (currently )?have.{0,80}(available|stock)|asking price for|installation available|offering for sale)')
    )
), safe as (
  select candidate.*,
    coalesce(nullif(company_name, ''), case when source_name !~ '@'
      and lower(trim(source_name)) !~ '^(seller|supplier|unknown|.*supplier route)$' then nullif(source_name, '') end) as display_name
  from candidates candidate
  left join crm_companies company on company.id = candidate.company_id
  where not (
    lower(coalesce(company.platform_role, '')) = 'buyer'
    or 'Buyer' = any(coalesce(company.purpose, '{}'::text[]))
    or 'buyer' = any(coalesce(company.roles, '{}'::text[]))
    or company.buyer_stage is not null or company.buyer_tier is not null
    or exists(select 1 from crm_bulk_trade_demand demand where demand.company_id = candidate.company_id)
  )
  and not exists (
    select 1 from crm_bulk_trade_parties party where party.lot_id = candidate.lot_id and party.role = 'buyer'
      and (party.company_id = candidate.company_id or lower(party.display_name) = lower(candidate.company_name)
        or lower(party.display_name) = lower(candidate.source_name))
  )
  and not exists (
    select 1 from crm_bulk_trade_buyers buyer
    left join crm_people person on person.id = buyer.person_id
    left join crm_bulk_trade_demand demand on demand.id = buyer.demand_id
    where buyer.lot_id = candidate.lot_id and (
      person.company_id = candidate.company_id or demand.company_id = candidate.company_id
      or lower(buyer.name) in (lower(candidate.company_name), lower(candidate.source_name), lower(candidate.email))
      or (candidate.email is not null and position(lower(candidate.email) in lower(coalesce(buyer.contact, ''))) > 0)
      or exists(select 1 from crm_people member where member.company_id = candidate.company_id
        and (member.id = buyer.person_id or lower(buyer.name) in (lower(member.full_name), lower(member.email))
          or position(lower(member.email) in lower(coalesce(buyer.contact, ''))) > 0))
    )
  )
  and not exists (
    select 1 from crm_bulk_trade_auction_people participant
    left join crm_people person on person.id = participant.person_id
    left join crm_people address on lower(address.email) = lower(participant.email)
    where participant.lot_id = candidate.lot_id and (
      person.company_id = candidate.company_id or address.company_id = candidate.company_id
      or lower(participant.email) = lower(candidate.email)
      or lower(split_part(participant.email, '@', 2)) = lower(company.domain)
    )
  )
)
select distinct on (lot_id) lot_id, display_name as seller_name,
  case when company_id is not null then 'company:' || company_id end as seller_ref, reason
from safe where display_name is not null
order by lot_id, rank, company_id nulls last, display_name;

-- Repeatable repair: only evidence-supported candidates survive, never arbitrary first contacts.
update crm_bulk_trade_lots lot set seller_name = candidate.seller_name, seller_ref = candidate.seller_ref
from (select source.id, picked.seller_name, picked.seller_ref
  from crm_bulk_trade_lots source left join crm_bulk_trade_seller_candidates picked on picked.lot_id = source.id
) candidate
where lot.id = candidate.id
  and (lot.seller_name is distinct from candidate.seller_name or lot.seller_ref is distinct from candidate.seller_ref);
