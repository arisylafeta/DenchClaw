-- 118: Stored matching for bulk deals (decisions of 12 Nov 2026, docs/bulk-relay-system/matching-design.md). Safe to run twice.
--
-- crm_bulk_matches: one row per deal and candidate. A person starts a run on a deal ("Find matches"); the scorer narrows,
-- the best five are stored with the scorer's order (scorer_rank) and the model's order (rank), and every answer is kept
-- here: asked, the supplier's or buyer's yes or no, the offer a yes became, and the reservation an offer holds.
--
-- What a reservation holds (stock_kind, stock_id): the candidate on a request (a supply listing, a stock line or a
-- marketplace listing), or the deal itself on a supply deal, where the candidates are buyers. It holds a quantity, not the
-- whole lot, and is internal only: nothing is taken off the marketplace. Quantities are counted in units (packs, modules,
-- cells, as the candidate is counted). The rule, enforced by the trigger below rather than a unique index: live reserved
-- quantity across all deals may never exceed what the candidate has (candidate_qty); when that or the reserved quantity
-- is unknown, one live reservation only (the whole lot is held). A reservation is live (bulk_match_live) while the row is
-- offered and either its offer has moved past offered (negotiating to paid: live until the offer ends) or, at offered,
-- reserved_until is today (London) or later. At offered it lapses by date with no write; bulk_matches_expire() marks
-- lapsed rows expired for the daily job. A complete offer has consumed its reservation; declined or lost releases it.
--
-- Stage: bulk_listing_has_match() now also counts a live stored match (asked, confirmed or offered) on the deal or on the
-- listing it names. A merely proposed match does not count: a run proposes five on every deal it touches, and counting
-- those would move every qualified request to Sourcing and every supply to Available the moment a run happened.
-- Supply Reserved now also comes from a live reservation against the listing, alongside hold_until.
begin;

create table if not exists crm_bulk_matches (
  id text primary key,
  deal_id text not null references crm_bulk_listings(id) on delete cascade,
  -- listing (a supply listing or a request, by crm_bulk_listings id), marketplace (marketplace listing id), stock
  -- (crm_stock_opportunities id) or company (a buyer company, by its dossier).
  candidate_kind text not null check (candidate_kind in ('listing', 'marketplace', 'stock', 'company')),
  candidate_id text not null,
  -- The Matches row key it came from (supply:..., group:stock:..., company:...), so a row maps back to the live list.
  candidate_key text not null,
  name text not null,
  company_id text references crm_companies(id) on delete set null,
  person_id text references crm_people(id) on delete set null,
  contact text,
  stock_kind text not null check (stock_kind in ('listing', 'marketplace', 'stock')),
  stock_id text not null,
  -- What the candidate has, as the scorer read it at the run (units). Null when it does not say.
  candidate_qty numeric check (candidate_qty is null or candidate_qty > 0),
  rank int check (rank between 1 and 5),
  scorer_rank int check (scorer_rank > 0),
  checks jsonb not null default '{}'::jsonb check (jsonb_typeof(checks) = 'object'),
  reason text,
  scored_by jsonb not null default '{}'::jsonb check (jsonb_typeof(scored_by) = 'object'),
  state text not null default 'proposed'
    check (state in ('proposed', 'asked', 'confirmed', 'declined', 'replaced', 'offered', 'expired')),
  note text,
  asked_at timestamptz,
  chases int not null default 0 check (chases between 0 and 3),
  verdict text check (verdict in ('yes', 'no')),
  verdict_reason text,
  verdict_at timestamptz,
  verdict_by text,
  -- On yes: how many (what the supplier confirmed for this request, or what the buyer would take), the price as quoted
  -- ({amount, currency, unit}; never sent to a seller) and until when the quote holds.
  confirmed_qty numeric check (confirmed_qty is null or confirmed_qty > 0),
  quote jsonb check (quote is null or jsonb_typeof(quote) = 'object'),
  quote_valid_until date,
  reserved_qty numeric check (reserved_qty is null or reserved_qty > 0),
  reserved_until date,
  offer_id text references crm_bulk_offers(id) on delete set null,
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_bulk_matches_verdict_pair_check check ((verdict is null) = (verdict_at is null)),
  constraint crm_bulk_matches_no_reason_check check (verdict is distinct from 'no' or nullif(btrim(coalesce(verdict_reason, '')), '') is not null)
);
create unique index if not exists crm_bulk_matches_candidate_uidx on crm_bulk_matches (deal_id, candidate_kind, candidate_id);
create index if not exists crm_bulk_matches_deal_idx on crm_bulk_matches (deal_id, rank);
create index if not exists crm_bulk_matches_stock_idx on crm_bulk_matches (stock_kind, stock_id) where reserved_until is not null;
-- data.kwh_per_unit: the candidate's kWh per unit as the run read it (a single-product listing), so a per-kWh offer
-- quantity can be counted in units. data.reservation_refused: why the last reservation was refused, for the send to say.
create index if not exists crm_bulk_matches_candidate_idx on crm_bulk_matches (candidate_kind, candidate_id);
create unique index if not exists crm_bulk_matches_offer_uidx on crm_bulk_matches (offer_id) where offer_id is not null;

-- Monday to Friday only; no bank holidays (the chase rule in lib/match/working-days.ts counts the same way).
create or replace function bulk_add_working_days(start_on date, days int) returns date language plpgsql immutable as $$
declare
  d date := start_on;
  left_to_add int := greatest(days, 0);
begin
  while left_to_add > 0 loop
    d := d + 1;
    if extract(isodow from d) < 6 then left_to_add := left_to_add - 1; end if;
  end loop;
  return d;
end $$;

-- The seller's quote on a supply listing holds until spec.seller_quote_valid_until (set when the seller confirms it).
create or replace function bulk_listing_quote_until(listing_id text) returns date language sql stable as $$
  select case when l.spec->>'seller_quote_valid_until' ~ '^\d{4}-\d{2}-\d{2}$' then (l.spec->>'seller_quote_valid_until')::date end
  from crm_bulk_listings l where l.id = listing_id
$$;

-- Whether one reservation holds now. At offered, by its date; once the offer is negotiating, contract_out, signed,
-- invoiced or paid, until the offer ends. Complete has consumed it. TS twin: reservationLive in lib/match/stored-match.ts.
create or replace function bulk_match_live(state text, reserved_until date, offer_id text) returns boolean language sql stable as $$
  select state = 'offered' and reserved_until is not null
    and coalesce((select o.stage from crm_bulk_offers o where o.id = offer_id), 'offered') <> 'complete'
    and (reserved_until >= bulk_today()
      or exists (select 1 from crm_bulk_offers o where o.id = offer_id and o.stage in ('negotiating', 'contract_out', 'signed', 'invoiced', 'paid')))
$$;

-- Live reservations against one piece of stock, other than `except_id`: how many rows, their summed quantity, and how
-- many hold the lot without a quantity.
create or replace function bulk_match_reserved(kind text, stock text, except_id text default null,
  out holds int, out qty numeric, out whole int) language sql stable as $$
  select count(*)::int, coalesce(sum(m.reserved_qty), 0), (count(*) filter (where m.reserved_qty is null))::int
  from crm_bulk_matches m
  where m.stock_kind = kind and m.stock_id = stock and bulk_match_live(m.state, m.reserved_until, m.offer_id)
    and m.id is distinct from except_id
$$;

-- The quantity rule. Runs before any write that makes or changes a live reservation; an advisory lock per stock makes
-- two deals reserving the same lot at the same moment take turns, so the sum is never read stale.
create or replace function bulk_match_check_reservation() returns trigger language plpgsql as $$
declare
  r record;
begin
  if not bulk_match_live(new.state, new.reserved_until, new.offer_id) then
    return new;
  end if;
  if TG_OP = 'UPDATE' and old.state = new.state and old.reserved_until is not distinct from new.reserved_until
     and old.reserved_qty is not distinct from new.reserved_qty and old.candidate_qty is not distinct from new.candidate_qty
     and old.stock_kind = new.stock_kind and old.stock_id = new.stock_id
     and bulk_match_live(old.state, old.reserved_until, old.offer_id) then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('crm_bulk_matches:' || new.stock_kind || ':' || new.stock_id));
  select * into r from bulk_match_reserved(new.stock_kind, new.stock_id, new.id);
  if new.candidate_qty is null then
    if r.holds > 0 then
      raise exception using errcode = '23P01',
        message = 'This lot does not state its quantity and is already reserved for another deal, so it cannot be reserved twice.';
    end if;
    return new;
  end if;
  -- No quantity in units (an offer priced per kWh with no kWh per unit to convert by): the whole lot is held, so no other
  -- deal may hold any of it.
  if new.reserved_qty is null then
    if r.holds > 0 then
      raise exception using errcode = '23P01',
        message = 'The quantity to reserve is not known in units, so the whole lot would be held, and another deal already holds some of it.';
    end if;
    return new;
  end if;
  if r.whole > 0 or r.qty + new.reserved_qty > new.candidate_qty then
    raise exception using errcode = '23P01',
      message = format('Only %s of %s are free to reserve.', greatest(case when r.whole > 0 then 0 else new.candidate_qty - r.qty end, 0), new.candidate_qty);
  end if;
  return new;
end $$;

drop trigger if exists bulk_match_check_reservation on crm_bulk_matches;
create trigger bulk_match_check_reservation before insert or update on crm_bulk_matches
  for each row execute function bulk_match_check_reservation();

-- Marks lapsed reservations expired and takes them out of the five. Reads already treat them as free; this only tidies
-- the state. Only reservations whose offer is still at offered lapse: one whose offer moved on is live until the offer
-- ends, and a complete offer's is consumed, not expired. Called by the same daily job as bulk_stage_check_all() (not
-- scheduled here).
create or replace function bulk_matches_expire() returns int language plpgsql as $$
declare
  n int;
begin
  update crm_bulk_matches
    set state = 'expired', rank = null, note = concat_ws(' ', nullif(note, ''), format('Reservation lapsed on %s.', reserved_until)), updated_at = now()
    where state = 'offered' and reserved_until is not null and reserved_until < bulk_today()
      and not bulk_match_live(state, reserved_until, offer_id)
      and not exists (select 1 from crm_bulk_offers o where o.id = offer_id and o.stage = 'complete');
  get diagnostics n = row_count;
  return n;
end $$;

-- The one seam from migration 116: a live counterparty offer, or now a live stored match (asked, confirmed or offered)
-- on the listing as the deal, or naming it as the candidate.
create or replace function bulk_listing_has_match(listing_id text) returns boolean language sql stable as $$
  select exists (select 1 from crm_bulk_offers o
      where o.role = 'counterparty' and (o.bulk_listing_id = listing_id or o.counterpart_id = listing_id)
        and o.stage is not null and o.stage not in ('declined', 'lost'))
    or exists (select 1 from crm_bulk_matches m
      where m.state in ('asked', 'confirmed', 'offered')
        and (m.deal_id = listing_id or (m.candidate_kind = 'listing' and m.candidate_id = listing_id)))
$$;

-- True while a live reservation holds some of this listing.
create or replace function bulk_listing_reserved(listing_id text) returns boolean language sql stable as $$
  select (bulk_match_reserved('listing', listing_id)).holds > 0
$$;

-- As in migration 116, with supply Reserved also coming from a live reservation against the listing.
create or replace function bulk_listing_stage(listing_id text) returns text language sql stable as $$
  select case
    when l.kind = 'demand' then case
      when l.status = 'closed' then 'Closed'
      when r.rank >= 2 then 'Found'
      when bulk_listing_has_match(l.id) then 'Sourcing'
      when bulk_listing_qualified(l.id) then case when x.owned then 'Sourcing' else 'Qualified' end
      else 'New' end
    else case
      when r.rank >= 5 or (l.status = 'closed' and l.closed_reason in ('sold', 'became_trade')) then 'Sold'
      when l.status = 'closed' then 'Closed'
      when l.hold_until >= bulk_today() or bulk_listing_reserved(l.id) then 'Reserved'
      when bulk_listing_has_match(l.id) then 'Available'
      when bulk_listing_qualified(l.id) then case when x.owned then 'Available' else 'Qualified' end
      else 'New' end
    end
  from crm_bulk_listings l
  cross join lateral bulk_listing_offer_rank(l.id) r
  cross join lateral (select nullif(btrim(coalesce(l.context->>'owner', '')), '') is not null as owned) x
  where l.id = listing_id
$$;

-- Match writes re-check every listing the row touches, the same way offer writes do (migration 116).
create or replace function bulk_match_stage_events() returns trigger language plpgsql as $$
begin
  if TG_OP <> 'DELETE' then
    perform bulk_stage_check_listing(new.deal_id);
    if new.candidate_kind = 'listing' then perform bulk_stage_check_listing(new.candidate_id); end if;
    if new.stock_kind = 'listing' and new.stock_id <> new.deal_id then perform bulk_stage_check_listing(new.stock_id); end if;
  end if;
  if TG_OP = 'DELETE' or old.candidate_id is distinct from new.candidate_id or old.stock_id is distinct from new.stock_id then
    perform bulk_stage_check_listing(old.deal_id);
    if old.candidate_kind = 'listing' then perform bulk_stage_check_listing(old.candidate_id); end if;
    if old.stock_kind = 'listing' then perform bulk_stage_check_listing(old.stock_id); end if;
  end if;
  return null;
end $$;

drop trigger if exists bulk_match_stage_events on crm_bulk_matches;
create trigger bulk_match_stage_events after insert or delete or update of state, reserved_qty, reserved_until, candidate_id, stock_id
  on crm_bulk_matches for each row execute function bulk_match_stage_events();

-- When a matched offer moves to offered, the match is offered and reserves its quantity in units: what the yes confirmed,
-- else the offer's quantity (per pack, module, cell or unit as it is; per kWh or MWh divided by the candidate's kWh per
-- unit; otherwise unknown, so the whole lot is held). Held for 5 working days or until the quote runs out if sooner (the
-- supplier's quote on a request, the seller's quote on a supply deal); past offered it holds until the offer ends. A
-- reservation the quantity rule refuses does not stop the offer: the match is offered without one, its note says why
-- and data.reservation_refused keeps the reason, which the send reports. When the offer is declined or lost, the match is
-- a no and its reservation ends at once.
create or replace function bulk_match_offered() returns trigger language plpgsql as $$
declare
  m record;
  until date;
  qty numeric;
  unit text;
  per numeric;
begin
  if new.stage in ('declined', 'lost') and old.stage is distinct from new.stage then
    update crm_bulk_matches
      set state = 'declined', rank = null, reserved_qty = null, reserved_until = null, verdict = 'no',
          verdict_reason = coalesce(nullif(btrim(new.declined_reason), ''), 'Offer ' || new.stage), verdict_at = now(),
          verdict_by = bulk_stage_actor(), updated_at = now()
      where offer_id = new.id and state in ('confirmed', 'offered');
    return null;
  end if;
  if new.stage is distinct from 'offered' or old.stage is not distinct from 'offered' then return null; end if;
  select x.*, d.kind as deal_kind into m from crm_bulk_matches x join crm_bulk_listings d on d.id = x.deal_id
    where x.offer_id = new.id and x.state = 'confirmed';
  if not found then return null; end if;
  until := least(bulk_add_working_days(bulk_today(), 5),
    coalesce(m.quote_valid_until, case when m.deal_kind = 'supply' then bulk_listing_quote_until(m.deal_id) end));
  qty := m.confirmed_qty;
  if qty is null and new.quantity is not null then
    unit := bulk_qty_unit(new.terms->>'unit');
    per := case when m.data->>'kwh_per_unit' ~ '^[0-9]+(\.[0-9]+)?$' then nullif((m.data->>'kwh_per_unit')::numeric, 0) end;
    qty := case
      when unit in ('pack', 'module', 'cell', 'unit') then new.quantity
      when unit = 'kwh' and per is not null then round(new.quantity / per, 3)
      when unit = 'mwh' and per is not null then round(new.quantity * 1000 / per, 3)
    end;
    if qty is not null and qty <= 0 then qty := null; end if;
  end if;
  begin
    update crm_bulk_matches
      set state = 'offered', reserved_qty = qty, reserved_until = until, data = data - 'reservation_refused', updated_at = now()
      where id = m.id;
  exception when exclusion_violation then
    update crm_bulk_matches
      set state = 'offered', reserved_qty = null, reserved_until = null,
          note = concat_ws(' ', nullif(note, ''), 'Not reserved: ' || sqlerrm),
          data = data || jsonb_build_object('reservation_refused', sqlerrm), updated_at = now()
      where id = m.id;
  end;
  return null;
end $$;

drop trigger if exists bulk_match_offered on crm_bulk_offers;
create trigger bulk_match_offered after update of stage on crm_bulk_offers
  for each row execute function bulk_match_offered();

commit;
