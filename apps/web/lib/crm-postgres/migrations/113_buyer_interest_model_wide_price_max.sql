-- Buyer interest, two follow-ups to 112 (additive; 112 itself stays as applied).
--
-- 1. price_max: a buyer's price is a target, never a hard limit. When the text states a flexible upper figure
--    ("under $30/kWh, flexible up to $50") the line keeps both: price = 30 (price_basis 'target') and price_max = 50.
--    Matching never filters on either figure.
--
-- 2. Model-level key: a stated model with no kWh and no part number is `model:<make>-<model>` and covers every pack
--    size of that model (a lot "Kia EV3 81.4 kWh pack" rolls up to `model:kia-ev3`). The TypeScript builder
--    (apps/web/lib/match/product-key-for.ts, modelWideKey) is the other half; buyer_interest_model_wide_text() is the
--    SQL mirror of its model text: kWh figures and the words battery/pack/module are dropped, and a leading make is
--    dropped, so "Kia EV3 81.4 kWh pack" and "EV3" are one model. A prose model (a list, years, four or more words)
--    never enters a key. Lines already written keep their keys until their source is re-synced.
--
-- Apply after a current backup and outside the 08:00 importer window: create or replace of a function that the sync
-- triggers call needs no table lock, but the column add takes a short one (lock_timeout 3s, re-run on timeout).
begin;
set local lock_timeout = '3s';

alter table buyer_interest add column if not exists price_max numeric;
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'buyer_interest'::regclass and conname = 'buyer_interest_price_max_check') then
    alter table buyer_interest add constraint buyer_interest_price_max_check
      check (price_max is null or (price is not null and price_max >= price));
  end if;
end $$;

-- The model as a model-level key writes it: no kWh figure, no battery/pack/module word, no leading make.
create or replace function buyer_interest_model_wide_text(p_make text, p_model text) returns text language sql immutable as $$
  with step as (
    select btrim(regexp_replace(regexp_replace(btrim(coalesce(p_model, '')),
             '\y[0-9]+(\.[0-9]+)?\s*kwh\y', ' ', 'gi'),
             '\y(hv\s+)?(battery|batteries|packs?|modules?)\y', ' ', 'gi')) as text
  ), squashed as (
    select btrim(regexp_replace(text, '\s+', ' ', 'g')) as text from step
  )
  select nullif(btrim(case
    when btrim(coalesce(p_make, '')) <> '' and lower(text) like lower(btrim(p_make)) || ' %'
      then substr(text, length(btrim(p_make)) + 2)
    else text end), '')
  from squashed
$$;

create or replace function buyer_interest_product_key(facts jsonb) returns text language sql immutable as $$
  with kwh as (
    select coalesce(buyer_interest_number(facts->'kwh'),
      case when facts->>'kwh_min' is not null and facts->>'kwh_min' = facts->>'kwh_max'
        then buyer_interest_number(facts->'kwh_min') end) as value
  ), part as (
    select 'part:' || buyer_interest_part(part) as key
    from jsonb_array_elements_text(coalesce(facts->'part_numbers', '[]'::jsonb)) part
    where buyer_interest_part(part) is not null
    order by 1 limit 1
  ), wide as (
    select buyer_interest_model_wide_text(facts->>'make', facts->>'model') as model
  )
  select coalesce(
    (select key from part),
    case when buyer_interest_make(facts->>'make') is not null
        and buyer_interest_fold(buyer_interest_model_text(facts->>'model')) is not null
        and not buyer_interest_prose_model(facts->>'model')
        and (select value from kwh) is not null
      then 'model:' || buyer_interest_make(facts->>'make') || '-' || buyer_interest_fold(buyer_interest_model_text(facts->>'model')) || '-'
        || buyer_interest_kwh_text((select value from kwh)) || 'kwh' end,
    case when buyer_interest_slug(facts->>'cell_maker') is not null
        and buyer_interest_slug(facts->>'model') is not null
        and not buyer_interest_prose_model(facts->>'model')
      then 'cell:' || buyer_interest_slug(facts->>'cell_maker') || '-' || buyer_interest_slug(facts->>'model') end,
    -- A model with no single kWh figure (none stated, or a range) covers every pack size of that model.
    case when buyer_interest_make(facts->>'make') is not null
        and buyer_interest_fold((select model from wide)) is not null
        and not buyer_interest_prose_model((select model from wide))
        and (select value from kwh) is null
      then 'model:' || buyer_interest_make(facts->>'make') || '-' || buyer_interest_fold((select model from wide)) end,
    -- Broad is the last level. A stated make stays on the key, so two makes in one ask keep two lines.
    'broad:' || coalesce(buyer_interest_make(facts->>'make') || '-', '')
      || coalesce(buyer_interest_slug(buyer_interest_chemistry(facts->>'chemistry')), 'any') || '-'
      || case buyer_interest_format(facts->>'format')
           when 'pack' then 'packs' when 'module' then 'modules' when 'cell' then 'cells' when 'system' then 'systems'
           else 'batteries' end
  )
$$;

commit;
