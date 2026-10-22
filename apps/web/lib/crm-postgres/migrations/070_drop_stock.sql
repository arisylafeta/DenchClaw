-- Supplier stock lives on the marketplace only. Drop the CRM stock list: its table, enrichment queue and trigger,
-- and the stock families in the supply feed. The Stock page and the stock-list source in demand matching are removed
-- in the same release. Back up crm_stock_items and crm_stock_enrich_queue to S3 before applying.
begin;
create or replace view crm_bulk_trade_supply_feed as
 SELECT supply.id,
    'supply'::text AS kind,
    supply.offers AS title,
    supply.seller,
    supply.quantity AS size,
    supply.location,
    (supply.observed_on)::text AS seen,
    supply.status,
    ('/?path=bulk_trade&supply='::text || supply.id) AS href,
    ARRAY[supply.seller] AS suppliers,
    NULL::boolean AS verified,
    NULL::integer AS count
   FROM crm_bulk_supply supply
  WHERE (supply.status = 'open'::text)
UNION ALL
 SELECT lot.id,
        CASE
            WHEN (lot.auction_id IS NOT NULL) THEN 'auction'::text
            ELSE 'trade'::text
        END AS kind,
    lot.title,
    bulk_trade_seller_display(lot.seller_ref, lot.seller_name) AS seller,
    COALESCE(( SELECT NULLIF(field.value, ''::text) AS "nullif"
           FROM crm_bulk_trade_fields field
          WHERE ((field.lot_id = lot.id) AND (field.field_key = 'quantity'::text))), NULLIF(concat_ws(' '::text, (lot.observed_quantity)::text, lot.quantity_unit), ''::text)) AS size,
    ( SELECT field.value
           FROM crm_bulk_trade_fields field
          WHERE ((field.lot_id = lot.id) AND (field.field_key = 'location'::text))) AS location,
    (COALESCE(lot.latest_activity_at, lot.updated_at))::text AS seen,
    lot.trade_stage AS status,
    ('/?path=bulk_trade&trade='::text || lot.id) AS href,
    array_remove(ARRAY[bulk_trade_seller_display(lot.seller_ref, lot.seller_name)], NULL::text) AS suppliers,
    NULL::boolean AS verified,
    NULL::integer AS count
   FROM crm_bulk_trade_lots lot
  WHERE ((lot.origin = 'supply'::text) AND (lot.trade_stage = ANY (ARRAY['Needs info'::text, 'With buyers'::text, 'Closing'::text])) AND ((lot.auction_id IS NULL) OR ((lot.auction_status = 'published'::text) AND ((lot.auction_closes_at IS NULL) OR (lot.auction_closes_at > now())))));
drop table crm_stock_enrich_queue;
drop table crm_stock_items;
drop function crm_stock_items_queue_enrichment();
commit;
