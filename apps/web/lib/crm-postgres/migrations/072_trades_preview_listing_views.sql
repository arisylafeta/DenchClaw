-- Trades Preview re-routing: listing-based replacements for the two Bulk Trades views that Trades Preview still read.
-- Additive only. The old crm_bulk_trade_* tables and views are left untouched (Bulk Trades keeps working on them until it is removed).
begin;

-- Every open supply listing a demand can be matched against: plain supply, trades (spec.is_trade) and live auctions.
-- Same columns as crm_bulk_trade_supply_feed; ids are the listing ids, so the existing demand/supply match rows still join.
create or replace view crm_bulk_listing_supply_feed as
select l.id,
  case when coalesce(l.auction_id, l.spec->>'auction_id') is not null then 'auction' when l.spec ? 'is_trade' then 'trade' else 'supply' end as kind,
  coalesce(nullif(l.spec->>'listing_title', ''), nullif(l.context->>'listing_title', ''), l.summary) as title,
  l.party as seller,
  coalesce((select nullif(f.value, '') from crm_bulk_listing_fields f where f.bulk_listing_id = l.id and f.field_key = 'quantity'),
    nullif(l.quantity, '')) as size,
  coalesce((select nullif(f.value, '') from crm_bulk_listing_fields f where f.bulk_listing_id = l.id and f.field_key = 'location'),
    nullif(l.location, '')) as location,
  coalesce((select max(a.occurred_at) from crm_bulk_listing_activity a where a.bulk_listing_id = l.id), l.updated_at)::text as seen,
  l.status,
  '/?path=~trades-preview&listing=' || l.id as href,
  array_remove(array[l.party], null) as suppliers,
  null::boolean as verified,
  null::integer as count
from crm_bulk_listings l
where l.kind = 'supply' and l.status = 'open' and coalesce(l.spec->>'origin', 'supply') <> 'demand'
  and coalesce(l.spec->>'trade_stage', '') <> 'On hold'
  and (l.hold_until is null or l.hold_until < current_date)
  -- Lot-synced listings carry the auction in spec until Bulk Trades is removed; the columns win when set.
  and (coalesce(l.auction_id, l.spec->>'auction_id') is null
    or (coalesce(l.auction_status, l.spec->>'auction_status') = 'published'
      and coalesce(l.auction_closes_at, (l.spec->>'auction_closes_at')::timestamptz, 'infinity') > now()));

-- Buyers waiting on our reply: open demand people, plus buyer offers (counterparties) on open supply listings.
create or replace view crm_bulk_buyer_waiting as
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
                   FROM crm_bulk_demand d
                  WHERE d.status = 'open'::text AND (d.person_id = p.id OR d.company_id IS NOT NULL AND d.company_id = p.company_id))) OR (EXISTS ( SELECT 1
                   FROM crm_bulk_offers o
                     JOIN crm_bulk_listings l ON l.id = o.bulk_listing_id
                  WHERE o.person_id = p.id AND o.role = 'counterparty'::text AND l.kind = 'supply'::text AND l.status = 'open'::text))
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

commit;
