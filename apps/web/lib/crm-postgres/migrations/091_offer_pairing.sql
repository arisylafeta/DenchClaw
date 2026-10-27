-- REB-565: one offer row per supply-demand pairing, linked both ways through counterpart_id.
-- Adds: a unique pair, a reverse-duplicate guard, a repoint function used when a listing is closed as a duplicate,
-- and a view of offers whose link is missing or points at a closed listing that has a live replacement.

create unique index if not exists crm_bulk_offers_pair_uidx
  on crm_bulk_offers (bulk_listing_id, counterpart_id)
  where role = 'counterparty' and counterpart_id is not null;

create or replace function crm_bulk_offers_no_reverse_pair() returns trigger language plpgsql as $$
begin
  if new.role = 'counterparty' and new.counterpart_id is not null and exists (
    select 1 from crm_bulk_offers o
    where o.role = 'counterparty' and o.id <> new.id
      and o.bulk_listing_id = new.counterpart_id and o.counterpart_id = new.bulk_listing_id) then
    raise exception 'offer pairing already exists in the other direction (% <-> %)', new.bulk_listing_id, new.counterpart_id
      using errcode = '23505', constraint = 'crm_bulk_offers_reverse_pair';
  end if;
  return new;
end $$;

drop trigger if exists crm_bulk_offers_no_reverse_pair on crm_bulk_offers;
create trigger crm_bulk_offers_no_reverse_pair before insert or update of counterpart_id, bulk_listing_id on crm_bulk_offers
  for each row execute function crm_bulk_offers_no_reverse_pair();

-- Move offers from a closed duplicate listing to the one that survives. The old value is kept in the offer's data.
-- An offer that would collide with an existing pairing stays where it is and is counted as skipped.
create or replace function crm_bulk_repoint_offers(p_loser text, p_keeper text) returns jsonb language plpgsql as $$
declare
  o record;
  moved int := 0;
  skipped int := 0;
begin
  if p_loser = p_keeper then raise exception 'cannot repoint a listing to itself'; end if;
  for o in select id, bulk_listing_id, counterpart_id from crm_bulk_offers
           where role = 'counterparty' and (counterpart_id = p_loser or bulk_listing_id = p_loser) loop
    begin
      if o.counterpart_id = p_loser then
        update crm_bulk_offers set counterpart_id = p_keeper,
          data = data || jsonb_build_object('previous_counterpart_id', p_loser), updated_at = now() where id = o.id;
      else
        update crm_bulk_offers set bulk_listing_id = p_keeper,
          data = data || jsonb_build_object('previous_listing_id', p_loser), updated_at = now() where id = o.id;
      end if;
      moved := moved + 1;
    exception when unique_violation or check_violation then
      skipped := skipped + 1;
    end;
  end loop;
  return jsonb_build_object('moved', moved, 'skipped', skipped);
end $$;

-- Closing a listing as a duplicate of another (context.duplicate_of = survivor id) repoints its offers.
create or replace function crm_bulk_listing_close_repoint() returns trigger language plpgsql as $$
declare keeper text := new.context->>'duplicate_of';
begin
  if new.status = 'closed' and new.closed_reason = 'duplicate' and keeper is not null and keeper <> new.id
     and (old.status is distinct from 'closed' or old.closed_reason is distinct from 'duplicate')
     and exists (select 1 from crm_bulk_listings k where k.id = keeper and k.status <> 'closed' and k.kind = new.kind) then
    perform crm_bulk_repoint_offers(new.id, keeper);
  end if;
  return new;
end $$;

drop trigger if exists crm_bulk_listing_close_repoint on crm_bulk_listings;
create trigger crm_bulk_listing_close_repoint after update of status, closed_reason on crm_bulk_listings
  for each row execute function crm_bulk_listing_close_repoint();

-- Offers whose link should be set or changed: both listings exist and are live on the opposite sides, but counterpart_id is
-- empty, or it points at a closed listing that was closed for another reason than an answered offer (offer_reply is history).
create or replace view crm_bulk_offer_link_gaps as
select o.id as offer_id, o.bulk_listing_id as listing_id, o.name, o.stage,
       case when o.counterpart_id is null then 'unlinked' else 'closed_target' end as issue,
       array(select c.id from crm_bulk_listings c
             where c.status <> 'closed' and c.kind <> l.kind
               and ((o.company_id is not null and c.company_id = o.company_id) or (o.person_id is not null and c.person_id = o.person_id))
             order by c.id) as candidates
from crm_bulk_offers o
join crm_bulk_listings l on l.id = o.bulk_listing_id and l.status <> 'closed'
left join crm_bulk_listings t on t.id = o.counterpart_id
where o.role = 'counterparty'
  and (o.counterpart_id is null or (t.status = 'closed' and coalesce(t.closed_reason, '') <> 'offer_reply'))
  and exists (select 1 from crm_bulk_listings c
              where c.status <> 'closed' and c.kind <> l.kind
                and ((o.company_id is not null and c.company_id = o.company_id) or (o.person_id is not null and c.person_id = o.person_id)));
