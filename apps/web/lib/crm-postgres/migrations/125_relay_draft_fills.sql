-- Relay's prices: the values for the price gaps in a draft. A writer leaves [BLANK: price for <label> (ref <key>)]
-- where a price goes; Relay works out a price for each from the stock it names (cost plus margin, or the listed
-- price) and keeps it here, with its working, until Alex accepts or changes it. Sending, scheduling or copying the
-- draft to Gmail writes the filled values into the email first, so the approved and pinned version carries them.
begin;

-- fills: [{key, label, value, basis, working, warnings, needsDeliveryQuote, by, floor, pennyRange}] (PriceFill in
-- apps/web/lib/relay-price-types.ts). by = 'alex' once he set or accepted it; a re-price keeps those.
alter table relay_draft add column if not exists fills jsonb not null default '[]'::jsonb;
commit;
