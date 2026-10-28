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
    s.details->>'sync_class' as sync_class
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
