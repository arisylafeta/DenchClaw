-- 115: Next step, always prepared (bulk and Relay slice 3). Safe to run twice.
--
-- Stage (A2, Alex 12 Nov 2026: "a match run starts when a person marks the deal ready"). New deals get owner Alex the
-- moment they open, so "qualified with an owner" skipped Qualified altogether. A qualified deal now stays Qualified
-- until a person has started a match run on it (crm_bulk_listings.context.match_run, written by runMatches in
-- lib/crm-postgres/bulk-matches.ts) or it has a live match (bulk_listing_has_match). The owner no longer moves a stage.
-- The listing trigger already fires on context, so starting a run logs the Qualified to Sourcing / Available event.
--
-- One chase clock (docs/bulk-relay-system/next-step.md): chases fall due on working day 1, 3 and 5 after our message
-- that went unanswered, and stop the moment they reply; after the third, parking is proposed (never done by itself).
--   relay_item.chase: the scan's reading of the clock for a thread Alex wrote last on: {"state": "waiting" | "due" |
--     "park", "chases": sent so far, "waited": working days, "next": the chase now due (1 to 3), "since": our first
--     unanswered message}. Null when nobody owes a chase. Read by the chase pass that prepares the draft.
--   relay_draft origin 'predraft' (allowed since 100, unused until now): a chase draft Relay prepared by itself into
--     Review. At most one open per thread (the index below); a reply from them skips it.
-- Team notes with @mentions are crm_bulk_listing_activity rows (kind 'note', data.mentions, data.ticked): no column.
begin;

alter table relay_item add column if not exists chase jsonb;

create unique index if not exists relay_draft_one_open_chase on relay_draft (item_id)
  where origin = 'predraft' and state in ('draft', 'gmail');

-- Open mentions for one person's Today tab.
create index if not exists crm_bulk_listing_activity_mentions_idx on crm_bulk_listing_activity using gin ((data->'mentions'))
  where kind = 'note' and data ? 'mentions';

-- Started: a person ran matching on the deal ("marks the deal ready"). Slice 4 keeps the last run in context.match_run.
create or replace function bulk_listing_match_started(listing_id text) returns boolean language sql stable as $$
  select coalesce((select jsonb_typeof(l.context->'match_run') = 'object' and nullif(l.context->'match_run'->>'at', '') is not null
    from crm_bulk_listings l where l.id = listing_id), false)
$$;

-- As in migration 113, with "qualified with an owner" replaced by "qualified and a match run started".
create or replace function bulk_listing_stage(listing_id text) returns text language sql stable as $$
  select case
    when l.kind = 'demand' then case
      when l.status = 'closed' then 'Closed'
      when r.rank >= 2 then 'Found'
      when bulk_listing_has_match(l.id) then 'Sourcing'
      when bulk_listing_qualified(l.id) then case when bulk_listing_match_started(l.id) then 'Sourcing' else 'Qualified' end
      else 'New' end
    else case
      when r.rank >= 5 or (l.status = 'closed' and l.closed_reason in ('sold', 'became_trade')) then 'Sold'
      when l.status = 'closed' then 'Closed'
      when l.hold_until >= current_date or bulk_listing_reserved(l.id) then 'Reserved'
      when bulk_listing_has_match(l.id) then 'Available'
      when bulk_listing_qualified(l.id) then case when bulk_listing_match_started(l.id) then 'Available' else 'Qualified' end
      else 'New' end
    end
  from crm_bulk_listings l
  cross join lateral bulk_listing_offer_rank(l.id) r
  where l.id = listing_id
$$;

-- Deals the old rule moved on by owner alone go back to Qualified, with an event (actor 'system'), so the log matches
-- the stage. A second run finds nothing to log.
select bulk_stage_check_all();

commit;
