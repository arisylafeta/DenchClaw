begin;

-- A changed source row must report pending both on the item and in the queue.
-- Enrichment-output and commercial-status changes are intentionally not watched,
-- preventing the enrichment worker from re-queuing itself.
create or replace function crm_stock_items_queue_enrichment()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'insert' then
    insert into crm_stock_enrich_queue (stock_item_id, status, next_attempt_at, updated_at)
    values (new.id, 'pending', now(), now())
    on conflict (stock_item_id)
    do update set status = 'pending', next_attempt_at = now(), updated_at = now();
    return new;
  end if;
  if new.supplier is distinct from old.supplier
    or new.stock_id is distinct from old.stock_id
    or new.make is distinct from old.make
    or new.model is distinct from old.model
    or new.model_detail is distinct from old.model_detail
    or new.year is distinct from old.year
    or new.powertrain is distinct from old.powertrain
    or new.part_number is distinct from old.part_number
    or new.description is distinct from old.description
    or new.quantity is distinct from old.quantity
    or new.price is distinct from old.price
    or new.location is distinct from old.location
    or new.condition is distinct from old.condition
    or new.comments is distinct from old.comments
    or new.aged_12m is distinct from old.aged_12m
    or new.in_august is distinct from old.in_august
    or new.in_september_aged is distinct from old.in_september_aged
    or new.listing_id is distinct from old.listing_id
    or new.attributes is distinct from old.attributes
  then
    update crm_stock_items
      set enrich_status = 'pending', enriched_at = null
      where id = new.id and enrich_status <> 'pending';
    insert into crm_stock_enrich_queue (stock_item_id, status, next_attempt_at, updated_at)
    values (new.id, 'pending', now(), now())
    on conflict (stock_item_id)
    do update set status = 'pending', next_attempt_at = now(), updated_at = now();
  end if;
  return new;
end;
$$;

commit;
