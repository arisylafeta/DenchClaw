// Generated from stock-details.schema.json (crm_stock_opportunities.details v1). Do not edit by hand.
// Regenerate when the schema changes; writers and readers use the same keys.

export type StockFactSource = "owner" | "pipeline" | "supplier" | "marketplace";
export const STOCK_FACTS = ["make", "model", "variant", "year", "part_numbers", "format", "powertrain", "chemistry", "capacity_kwh", "capacity_basis", "capacity_kwh_gross", "capacity_kwh_usable", "voltage_nominal", "capacity_ah", "pack_weight_kg", "soh_percent", "condition", "damaged", "tested", "vin"] as const;
export type StockFactKey = (typeof STOCK_FACTS)[number];

export interface StockDetailsV1 {
  schema_version?: 1;
  make?: string;
  model?: string;
  variant?: string;
  year?: number;
  part_numbers?: string[];
  format?: "pack" | "module" | "cell";
  powertrain?: "BEV" | "PHEV" | "HEV" | "MHEV";
  chemistry?: string;
  capacity_kwh?: number;
  capacity_basis?: "marketed" | "label" | "listing_text" | "estimate";
  capacity_kwh_gross?: number;
  capacity_kwh_usable?: number;
  voltage_nominal?: number;
  capacity_ah?: number;
  pack_weight_kg?: number;
  soh_percent?: number;
  condition?: string;
  damaged?: boolean;
  tested?: boolean;
  vin?: string;
  field_source?: Partial<Record<StockFactKey, StockFactSource>>;
  quantity_available?: number | string;
  availability?: Record<string, unknown>;
  price_eur?: number;
  price_eur_ex_vat?: number;
  price_eur_basis?: string;
  price_ex_vat?: number | null;
  price_basis?: string;
  vat?: string;
  vat_basis?: string;
  fx?: Record<string, unknown>;
  eur_per_kwh?: number;
  deliver?: boolean;
  sync_class?: "synced" | "syncable" | "static" | "marketplace" | "pipeline";
  source_url?: string;
  photos?: unknown[];
  damage?: unknown[];
  battery_graph?: Record<string, unknown>;
  sync?: Record<string, unknown>;
  enrichment?: Record<string, unknown>;
  marketplace?: Record<string, unknown>;
  delivery?: Record<string, unknown>;
  stale?: Record<string, unknown>;
  stale_history?: unknown[];
  rejected?: Record<string, unknown>;
  status_history?: unknown[];
  previous_listings?: unknown[];
  history?: unknown[] | string;
  evidence?: Record<string, unknown>;
  sources?: unknown[];
  attributes?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}
