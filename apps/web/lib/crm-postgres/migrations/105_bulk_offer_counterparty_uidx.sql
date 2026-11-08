-- Matches v3: one counterparty offer per counterparty on a listing, even when the offer is not linked to an
-- opposite listing. The existing crm_bulk_offers_pair_uidx (091) only covers offers that point at a counterpart
-- listing. Researched buyers and unlisted stock have no counterpart listing, so repeated clicks on "Add to offers"
-- would otherwise create duplicates.
--
-- The key is (bulk_listing_id, coalesce(company_id, person_id)): a company wins over its contact, so two contacts at
-- one company still count as one counterparty. Offers that are linked (counterpart_id set) and offers with no CRM
-- identity are untouched here; addOffer handles the unlinked-by-name case in code.
--
-- Additive and idempotent. Rollback: drop index crm_bulk_offers_counterparty_uidx.
begin;

create unique index if not exists crm_bulk_offers_counterparty_uidx
  on crm_bulk_offers (bulk_listing_id, coalesce(company_id, person_id))
  where role = 'counterparty'
    and counterpart_id is null
    and coalesce(company_id, person_id) is not null;

insert into crm_data_migrations (id) values ('105_bulk_offer_counterparty_uidx') on conflict do nothing;
commit;
