-- REB-572 follow-up: Relay is the place Alex sees replies and chases, so the offer-mail index no longer alerts.
-- Drops its two alert stamps, and lets a Relay send on an item's deal count as a way an email was tied to an offer.
begin;
alter table crm_bulk_offer_mail drop column if exists reply_alerted_at;
alter table crm_bulk_offer_mail drop column if exists chase_alerted_at;
alter table crm_bulk_offer_mail drop constraint if exists crm_bulk_offer_mail_matched_by_check;
alter table crm_bulk_offer_mail add constraint crm_bulk_offer_mail_matched_by_check check (matched_by in ('thread_link', 'relay', 'recipient'));
commit;
