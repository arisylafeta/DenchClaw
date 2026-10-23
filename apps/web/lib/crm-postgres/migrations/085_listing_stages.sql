-- 085: listing stages New, Qualified, Matched, Offered, Signed & Paid, Complete.
-- Offer stages shrink to what happens to one counterparty: candidate (found by research), offered (sent),
-- the signing-and-paying track (contract_out, signed, invoiced, paid), complete (delivered), declined, lost.
-- NDA, specs and bids are Story and documents, not stages. The old stage is kept in data.previous_stage.
alter table crm_bulk_offers drop constraint if exists crm_bulk_offers_stage_check;
update crm_bulk_offers set
  data = data || jsonb_build_object('previous_stage', stage),
  stage = case stage
    when 'to_contact' then 'candidate'
    when 'teaser_sent' then 'offered' when 'specs_nda' then 'offered' when 'bid_in' then 'offered'
    when 'loi' then 'contract_out' when 'won' then 'signed' else stage end
where stage in ('to_contact', 'teaser_sent', 'specs_nda', 'bid_in', 'loi', 'won');
alter table crm_bulk_offers add constraint crm_bulk_offers_stage_check check (stage is null or stage = any (array[
  'candidate', 'offered', 'contract_out', 'signed', 'invoiced', 'paid', 'complete', 'declined', 'lost']));

-- Basics for Qualified. Demand: buyer linked, a volume or quantity, a product family. Supply: seller linked,
-- quantity, location, and state of health or test data. A demand we have asked a qualifying question of stays New.
create or replace function bulk_listing_qualified(listing_id text) returns boolean language sql stable as $$
  select coalesce((select case
    when l.kind = 'demand' then l.status <> 'qualifying'
      and (l.company_id is not null or l.person_id is not null)
      and (l.spec->>'volume' is not null or nullif(btrim(coalesce(l.quantity, '')), '') is not null)
      and nullif(l.spec->>'product_family', '') is not null
    else (l.company_id is not null or l.person_id is not null)
      and nullif(btrim(coalesce(l.quantity, '')), '') is not null
      and nullif(btrim(coalesce(l.location, '')), '') is not null
      and exists (select 1 from crm_bulk_listing_fields f where f.bulk_listing_id = l.id
        and f.field_key in ('soh', 'test_data') and nullif(btrim(coalesce(f.value, '')), '') is not null and f.status <> 'missing')
    end from crm_bulk_listings l where l.id = listing_id), false)
$$;

-- The listing stage: the furthest of its offers, else Matched when research found a counterparty (a saved match),
-- else Qualified when the basics are in, else New.
create or replace function bulk_listing_stage(listing_id text) returns text language sql stable as $$
  select case
    when r.rank >= 4 then 'Complete'
    when r.rank = 3 then 'Signed & Paid'
    when r.rank = 2 then 'Offered'
    when r.rank = 1 or exists (select 1 from crm_bulk_trade_demand_matches m where not m.hidden and (m.demand_id = listing_id or m.lot_id = listing_id))
      or exists (select 1 from crm_bulk_trade_supply_matches m where not m.hidden and (m.supply_id = listing_id or m.demand_id = listing_id)) then 'Matched'
    when bulk_listing_qualified(listing_id) then 'Qualified'
    else 'New' end
  from (select coalesce(max(case o.stage when 'complete' then 4 when 'paid' then 3 when 'invoiced' then 3 when 'signed' then 3
      when 'contract_out' then 3 when 'offered' then 2 when 'candidate' then 1 end), 0) as rank
    from crm_bulk_offers o where o.role = 'counterparty' and (o.bulk_listing_id = listing_id or o.counterpart_id = listing_id)) r
$$;

create or replace view crm_bulk_listing_supply_feed as
SELECT id,
        CASE
            WHEN COALESCE(auction_id, spec ->> 'auction_id'::text) IS NOT NULL THEN 'auction'::text
            WHEN (EXISTS ( SELECT 1
               FROM crm_bulk_offers o
              WHERE o.bulk_listing_id = l.id AND (o.stage = ANY (ARRAY['contract_out'::text, 'signed'::text, 'invoiced'::text, 'paid'::text, 'complete'::text])))) THEN 'trade'::text
            ELSE 'supply'::text
        END AS kind,
    COALESCE(NULLIF(spec ->> 'listing_title'::text, ''::text), NULLIF(context ->> 'listing_title'::text, ''::text), summary) AS title,
    party AS seller,
    COALESCE(( SELECT NULLIF(f.value, ''::text) AS "nullif"
           FROM crm_bulk_listing_fields f
          WHERE f.bulk_listing_id = l.id AND f.field_key = 'quantity'::text), NULLIF(quantity, ''::text)) AS size,
    COALESCE(( SELECT NULLIF(f.value, ''::text) AS "nullif"
           FROM crm_bulk_listing_fields f
          WHERE f.bulk_listing_id = l.id AND f.field_key = 'location'::text), NULLIF(location, ''::text)) AS location,
    COALESCE(( SELECT max(a.occurred_at) AS max
           FROM crm_bulk_listing_activity a
          WHERE a.bulk_listing_id = l.id), updated_at)::text AS seen,
    status,
    '/?path=~trades-preview&listing='::text || id AS href,
    array_remove(ARRAY[party], NULL::text) AS suppliers,
    NULL::boolean AS verified,
    NULL::integer AS count
   FROM crm_bulk_listings l
  WHERE kind = 'supply'::text AND status = 'open'::text AND COALESCE(spec ->> 'origin'::text, 'supply'::text) <> 'demand'::text AND COALESCE(spec ->> 'trade_stage'::text, ''::text) <> 'On hold'::text AND (hold_until IS NULL OR hold_until < CURRENT_DATE) AND (COALESCE(auction_id, spec ->> 'auction_id'::text) IS NULL OR COALESCE(auction_status, spec ->> 'auction_status'::text) = 'published'::text AND COALESCE(auction_closes_at, (spec ->> 'auction_closes_at'::text)::timestamp with time zone, 'infinity'::timestamp with time zone) > now());

create or replace view crm_buyer_engagement as
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
         SELECT COALESCE(p.company_id, o.company_id) AS company_id,
            count(DISTINCT o.bulk_listing_id) AS trades_offered,
            count(DISTINCT o.bulk_listing_id) FILTER (WHERE o.stage = ANY (ARRAY['paid'::text, 'complete'::text])) AS trades_won,
            count(*) FILTER (WHERE o.terms ? 'amount'::text) AS bids,
            max(o.last_touch_on::timestamp with time zone) FILTER (WHERE o.terms ? 'amount'::text) AS last_bid_at
           FROM crm_bulk_offers o
             JOIN crm_bulk_listings l ON l.id = o.bulk_listing_id AND l.kind = 'supply'::text
             LEFT JOIN people p ON p.person_id = o.person_id
          WHERE o.role = 'counterparty'::text AND COALESCE(p.company_id, o.company_id) IS NOT NULL
          GROUP BY (COALESCE(p.company_id, o.company_id))
        ), demand AS (
         SELECT crm_bulk_demand.company_id,
            count(*) FILTER (WHERE crm_bulk_demand.status = 'open'::text AND crm_bulk_demand.kind = 'request'::text) AS open_requests,
            count(*) FILTER (WHERE crm_bulk_demand.status = 'open'::text AND crm_bulk_demand.kind = 'standing'::text) AS open_buy_boxes,
            count(*) FILTER (WHERE crm_bulk_demand.status = 'open'::text AND crm_bulk_demand.kind = 'standing'::text AND crm_bulk_demand.basis = 'agreed'::text) AS agreed_buy_boxes,
            count(*) FILTER (WHERE crm_bulk_demand.source_kind = 'survey'::text) AS surveys
           FROM crm_bulk_demand
          WHERE crm_bulk_demand.company_id IS NOT NULL
          GROUP BY crm_bulk_demand.company_id
        ), waiting AS (
         SELECT crm_bulk_buyer_waiting.company_id,
            min(crm_bulk_buyer_waiting.waiting_since) AS waiting_since
           FROM crm_bulk_buyer_waiting
          WHERE crm_bulk_buyer_waiting.waiting_since IS NOT NULL AND crm_bulk_buyer_waiting.company_id IS NOT NULL
          GROUP BY crm_bulk_buyer_waiting.company_id
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
