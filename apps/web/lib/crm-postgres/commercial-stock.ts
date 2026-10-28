import { queryPg } from "../postgres";
import type { StockRow } from "../commercial-stock";

const num = (path: string) => `case when jsonb_typeof(${path}) = 'number' then (${path})::text::numeric
  when (${path}) #>> '{}' ~ '^[0-9]+(\\.[0-9]+)?$' then ((${path}) #>> '{}')::numeric end`;

/**
 * Live dismantler stock a buyer may be offered: opportunity and listed rows only (stale rows are internal), never rows
 * marked `deliver: false`, sold or gone. Supplier columns stay on the CRM side.
 */
const LIVE_STOCK = `
  select s.id, s.company_id, s.person_id, c.name as supplier, s.status,
    s.details->>'make' as make, s.details->>'model' as model, s.details->>'format' as format,
    coalesce(${num("s.details->'capacity_kwh'")}, ${num("s.details->'capacity_kwh_gross'")},
      ${num("s.details->'battery_graph'->'gross_kwh'")})::float8 as capacity_kwh,
    s.details->>'chemistry' as chemistry, s.details->>'powertrain' as powertrain,
    ${num("s.details->'year'")}::int as year,
    coalesce(nullif(c.country, ''), nullif(s.location, '')) as country,
    floor(coalesce(${num("s.details->'quantity_available'")}, s.quantity, 1))::int as quantity,
    ${num("s.details->'price_eur_ex_vat'")}::float8 as price_eur_ex_vat,
    ${num("s.details->'price_eur'")}::float8 as price_eur,
    coalesce(s.details->'sync'->>'lastSeen', s.details->'availability'->>'checked_on', s.observed_on::text, s.updated_at::date::text) as seen_on,
    s.details->>'sync_class' as sync_class,
    case when s.details->'battery_graph'->>'found' = 'yes' then s.details->'battery_graph'->>'pack_key' end as pack_key,
    case when s.details->'battery_graph'->>'found' = 'yes' then s.details->'battery_graph'->>'pack' end as pack_name,
    case when s.details->'battery_graph'->>'found' = 'yes' then s.details->'battery_graph'->>'fits' end as fits,
    case when s.details->'battery_graph'->>'found' = 'yes' then ${num("s.details->'battery_graph'->'usable_kwh'")}::float8 end as usable_kwh,
    case when s.details->'battery_graph'->>'found' = 'yes' then ${num("s.details->'battery_graph'->'gross_kwh'")}::float8 end as gross_kwh,
    case when jsonb_typeof(s.details->'part_numbers') = 'array' and jsonb_array_length(s.details->'part_numbers') > 0
      then array(select jsonb_array_elements_text(s.details->'part_numbers'))
      when nullif(trim(s.details->>'part_number'), '') is not null then array[s.details->>'part_number'] end as part_numbers,
    case when lower(s.details->>'tested') in ('true', 'yes') then true when lower(s.details->>'tested') in ('false', 'no') then false end as tested,
    ${num("s.details->'soh_percent'")}::float8 as soh_percent,
    case when lower(s.details->>'damaged') in ('true', 'yes')
        or (jsonb_typeof(s.details->'damage') = 'array' and jsonb_array_length(s.details->'damage') > 0) then true
      when lower(s.details->>'damaged') in ('false', 'no') then false end as damaged
  from crm_stock_opportunities s
  left join crm_companies c on c.id = s.company_id
  where s.status in ('opportunity', 'listed')
    and coalesce(s.details->>'deliver', 'true') <> 'false'
    and coalesce(s.details->'availability'->>'state', '') not in ('sold', 'not_found', 'gone')
    and coalesce(s.details->'sync'->>'available', 'true') <> 'false'
    and nullif(trim(s.details->>'make'), '') is not null
    and coalesce(${num("s.details->'quantity_available'")}, s.quantity, 1) >= 1`;

export async function liveStock(): Promise<StockRow[]> {
  return queryPg<StockRow>(LIVE_STOCK);
}
