-- 084: supply listings are scored on value alone.
-- spec.value_eur is the approximate value of ALL stock in the listing (seller ask when stated, otherwise a
-- labelled estimate; spec.value_basis says which and how). Log scale: EUR 1k = 43, EUR 100k = 71, EUR 10M = 100.
create or replace function bulk_supply_score(value_eur numeric) returns integer
language sql immutable as $$
  select case when value_eur is null or value_eur <= 0 then null
    else least(100, round(100 * log(1 + value_eur) / 7))::int end
$$;
