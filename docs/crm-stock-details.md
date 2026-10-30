# CRM stock details (`crm_stock_opportunities.details`, schema v1)

One schema for every writer and reader of stock rows. Source of truth: `apps/web/lib/crm-postgres/stock-details.schema.json`; TS type: `apps/web/lib/crm-postgres/stock-details.ts`. The enrichments repo keeps an identical copy at `apps/stock-pipeline/dismantler-sync/stock-details.schema.json`, plus the shared write rules in `details-schema.mjs`. Applied to every row on 30 Oct 2026 (`dismantler-sync normalize-details --all`); every row carries `schema_version: 1`.

## Writers and readers

| Side | Code | Role |
|---|---|---|
| Supplier sync | enrichments `dismantler-sync pull <slug> --apply` (`sync.mjs` `crmDetails`) | writes `supplier` facts; raw site values under `sync.supplied` |
| Pipeline | enrichments `dismantler-sync crm-update` | writes supported pipeline values as `pipeline` facts; pipeline state in `enrichment` |
| Marketplace sync | `scripts/rebattery/stock_opportunity_marketplace_sync.py` (`details_v1`) | new rows from marketplace listings as `marketplace` facts |
| Stock search (Jules) | `lib/crm-postgres/commercial-stock.ts` | reads facts |
| Duplicate check | `lib/crm-postgres/bulk-trade-proposals.ts` `duplicateStockFor` | marketplace-sourced `model`, first `part_numbers` |
| Investigator | `profiles/investigator/tools/commercial_stock_lines.py` | reads facts |
| Dismantler queue | view `crm_dismantler_stock_queue` | reads `enrichment.state`, `enriched_at`, `checked_on` |

## Facts (top level, one key each)

`make`, `model`, `variant`, `year`, `part_numbers` (only part-number key, whole literal codes), `format` (`pack` / `module` / `cell`), `powertrain` (`BEV` / `PHEV` / `HEV` / `MHEV`), `chemistry` (specific family when known), `capacity_kwh` (**marketed** kWh) with `capacity_basis` (`marketed` / `label` / `listing_text` / `estimate`), optional `capacity_kwh_gross` / `capacity_kwh_usable` (only when a source states them), `voltage_nominal`, `capacity_ah`, `pack_weight_kg`, `soh_percent`, `condition`, `damaged`, `tested`, `vin` (private, never leaves the CRM).

## Provenance and state

- `field_source`: `{ fact: owner | pipeline | supplier | marketplace }` for every fact present.
- `sync`: source sync state (`adapter`, `sourceKey`, `firstSeen`, `lastSeen`, `available`, `supplied`).
- `enrichment`: pipeline state only (`state` imported / enriched / ready / rejected, `ready`, `missing`, `supported`, `item_id`, `namespace`, `enriched_at`, `checked_on`, `link`, filtered `decisions`, `conflicts`).
- `marketplace`: listing link state only (`slug`, ...).
- `delivery`: the last push sync that delivered the row (`plan`, `by`, `on`, `environment`).
- `stale`, `stale_history`, `rejected`, `status_history`, `previous_listings`, `history`, `evidence`, `sources`, `attributes`.
- Operational: `quantity_available`, `availability`, `price_eur`, `price_eur_ex_vat`, `vat_basis`, `fx`, `deliver`, `sync_class`, `photos`, `damage`, `battery_graph` (research lead only).
- `extra`: supplier-specific keys that are not facts (`grade_raw`, `donor_mileage_km`, `bildelsbasen_listing_id`, ...).

Retired keys: `part_number`, `marketplace.{manufacturer,model,format,chemistry,pack_kwh,year_manufacture,soh}`, top-level `seo_slug`, `enriched_by` / `enriched_on` (now `enrichment.legacy`), `enrichment.fields` / `enrichment.listing`.

## Write rules (every writer)

1. A writer fills an empty fact, or refreshes a fact whose `field_source` is its own source.
2. `owner` values are never overwritten.
3. Precedence: owner > pipeline (supported values only) > supplier > marketplace. A higher source may refine a lower one; a disagreement beyond the margin (kWh more than 2 apart, a different chemistry family, a different format or powertrain) is not written but recorded in `enrichment.conflicts`.
4. `part_numbers` accumulate across sources. A generic "Li-ion" never replaces a specific chemistry. `capacity_basis` is set only by the source holding `capacity_kwh`.
5. Writers validate against the schema and fail closed. New keys need a schema change (Ari's approval), not ad hoc additions.
