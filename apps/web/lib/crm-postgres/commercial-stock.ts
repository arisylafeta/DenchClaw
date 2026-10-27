import { randomUUID } from "node:crypto";
import { queryPg, withPgTransaction, type PgTransaction } from "../postgres";
import { allocate, bySupplier, normalFormat, type Allocation, type BuyLine, type StockRow } from "../commercial-stock";

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

export type BuyRequestInput = {
  sourcingRequestId: string;
  conversationId: string | null;
  email: string;
  wants: string;
  country: string | null;
  neededBy: string | null;
  timing: string | null;
  lines: BuyLine[];
};

export type BuyRequestResult = {
  listingId: string;
  created: boolean;
  lines: { groupKey: string; label: string | null; wanted: number; allocated: number }[];
  suppliers: number;
  offersAdded: number;
};

const SITE = "https://www.rebattery.io";

async function buyerPerson(tx: PgTransaction, email: string) {
  const found = await tx.query<{ id: string; company_id: string | null; company: string | null }>(
    `select p.id, p.company_id, c.name as company from crm_people p left join crm_companies c on c.id = p.company_id
     where lower(p.email) = lower($1) order by p.updated_at desc nulls last limit 1`, [email]);
  if (found.rows[0]) {
    await tx.query(
      `update crm_people set tags = array(select distinct unnest(coalesce(tags, '{}') || array['commercial-buyer'])), updated_at = now()
       where id = $1 and not (coalesce(tags, '{}') @> array['commercial-buyer'])`, [found.rows[0].id]);
    return found.rows[0];
  }
  const id = randomUUID();
  await tx.query("insert into crm_people (id, email, tags) values ($1, $2, array['commercial-buyer'])", [id, email.toLowerCase()]);
  return { id, company_id: null, company: null };
}

function lineSummary(allocation: Allocation) {
  return `${allocation.wanted}x ${allocation.label ?? allocation.groupKey}${allocation.targetPriceEur ? ` at EUR ${allocation.targetPriceEur} each` : ""}`;
}

/**
 * One demand listing for a Jules commercial-buyer request, with the matching stock attached as one candidate offer per
 * supplier. Idempotent on the sourcing request: a retry (or the daily importer, which uses the same source key) finds
 * the same listing and only adds offers for suppliers it does not have yet. Never sends anything.
 */
export async function createBuyRequest(input: BuyRequestInput, stock?: StockRow[]): Promise<BuyRequestResult> {
  const rows = stock ?? await liveStock();
  const allocations = allocate(input.lines, rows);
  const suppliers = bySupplier(allocations);
  const units = input.lines.reduce((sum, line) => sum + line.quantity, 0);
  const summary = allocations.map(lineSummary).join("; ");
  const prices = input.lines.map((line) => line.targetPriceEur).filter((price): price is number => typeof price === "number" && price > 0);

  const write = () => withPgTransaction(async (tx) => {
    const sourceId = `sourcing_request:${input.sourcingRequestId}`;
    // Serialise concurrent calls for the same request.
    await tx.query("select pg_advisory_xact_lock(hashtext($1))", [sourceId]);
    const existing = await tx.query<{ id: string }>(
      "select id from crm_bulk_listings where kind = 'demand' and source_kind = 'jules' and source_id = $1", [sourceId]);
    let listingId = existing.rows[0]?.id;
    const created = !listingId;
    const person = await buyerPerson(tx, input.email);
    // The demand checks allow one volume unit; mixed formats keep the count in `quantity` only.
    const formats = new Set(allocations.flatMap((a) => a.rows.map((r) => normalFormat(r.row.format))));
    const format = formats.size === 1 ? [...formats][0] : null;
    const facts = {
      models: [...new Set(allocations.map((a) => a.label).filter(Boolean))],
      ...(format ? { volume: units, volume_unit: `${format}s`, formats: [`${format[0].toUpperCase()}${format.slice(1)}s`] } : {}),
      ...(prices.length === input.lines.length && prices.length && (format === "pack" || format === "cell")
        ? { max_price: Math.max(...prices), price_currency: "EUR", price_unit: format } : {}),
      ...(input.neededBy ? { needed_by: input.neededBy } : {}),
      commercial_buyer: true,
    };
    const buyRequest = { sourcing_request_id: input.sourcingRequestId, conversation_id: input.conversationId, lines: input.lines };
    const note = [summary, input.timing ? `When: ${input.timing}` : null].filter(Boolean).join("\n");
    if (!listingId) {
      listingId = `btd_${randomUUID()}`;
      const context = {
        listing_title: `${units}x ${allocations.map((a) => a.label ?? "battery").slice(0, 3).join(", ")}`.slice(0, 160),
        buy_request: buyRequest,
        next_action: "Review the attached stock per supplier and prepare buying requests.",
      };
      await tx.query(
        `insert into crm_bulk_listings (id, kind, party, company_id, person_id, email, summary, quantity, location, note, status,
           observed_on, source_kind, source_id, source_label, source_url, spec, context)
         values ($1, 'demand', $2, $3, $4, $5, $6, $7, $8, $9, 'open', current_date, 'jules', $10, 'Jules commercial buyer', $11, $12, $13)`,
        [listingId, person.company ?? input.email, person.company_id, person.id, input.email, input.wants.slice(0, 2000), `${units} units`,
          input.country, note, sourceId, input.conversationId ? `${SITE}/operations/jules/${input.conversationId}` : null,
          JSON.stringify({ intent: "request", ...facts }), JSON.stringify(context)]);
    } else {
      // A resend or an edited request: bring the demand up to date. Price, volume and timing facts are replaced as a set
      // so a removed target price does not linger; the importer's fallback row gains the same shape.
      await tx.query(
        `update crm_bulk_listings set summary = $2, quantity = $3, note = $4, location = coalesce($5, location),
           spec = (spec - array['models', 'volume', 'volume_unit', 'formats', 'max_price', 'price_currency', 'price_unit', 'needed_by']) || $6::jsonb,
           context = jsonb_set(context, '{buy_request}', $7::jsonb), updated_at = now()
         where id = $1`,
        [listingId, input.wants.slice(0, 2000), `${units} units`, note, input.country, JSON.stringify(facts), JSON.stringify(buyRequest)]);
    }

    let offersAdded = 0, offersUpdated = 0, offersDropped = 0;
    const current = await tx.query<{ id: string; company_id: string | null; person_id: string | null; stage: string | null; data: { source?: string } }>(
      "select id, company_id, person_id, stage, data from crm_bulk_offers where bulk_listing_id = $1 and role = 'counterparty'", [listingId]);
    const seen = new Set<string>();
    for (const supplier of suppliers) {
      const stock = supplier.lines.map(({ allocation, row, units: taken }) => ({
        stock_id: row.id, group_key: allocation.groupKey, label: allocation.label, units: taken,
        price_eur_ex_vat: row.price_eur_ex_vat, price_eur: row.price_eur, target_price_eur: allocation.targetPriceEur,
      }));
      const wanted = supplier.lines.reduce((sum, line) => sum + line.units, 0);
      const wants = `Buy ${wanted} unit${wanted === 1 ? "" : "s"} from their stock for a commercial buyer`;
      const terms = stock.every((line) => line.target_price_eur) ? { amount: Math.max(...stock.map((line) => line.target_price_eur!)), unit: "unit", currency: "EUR" } : {};
      const prior = current.rows.find((offer) => supplier.company_id ? offer.company_id === supplier.company_id : !offer.company_id && offer.person_id === supplier.person_id);
      if (prior) {
        seen.add(prior.id);
        // Only offers still at candidate follow the request; anything staff have moved on is theirs.
        if (prior.stage !== "candidate" || prior.data?.source !== "commercial_buyer") continue;
        await tx.query(
          `update crm_bulk_offers set wants = $2, terms = $3, data = data || $4::jsonb, updated_at = now() where id = $1`,
          [prior.id, wants, JSON.stringify(terms), JSON.stringify({ stock })]);
        offersUpdated += 1;
        continue;
      }
      await tx.query(
        `insert into crm_bulk_offers (id, bulk_listing_id, role, person_id, company_id, name, wants, stage, terms, data)
         values ($1, $2, 'counterparty', $3, $4, $5, $6, 'candidate', $7, $8)`,
        [`bof_${randomUUID()}`, listingId, supplier.person_id, supplier.company_id, supplier.supplier ?? "Supplier", wants,
          JSON.stringify(terms), JSON.stringify({ source: "commercial_buyer", stock, next_step: "Prepare a buying request (draft only)" })]);
      offersAdded += 1;
    }
    for (const offer of current.rows) {
      if (seen.has(offer.id) || offer.stage !== "candidate" || offer.data?.source !== "commercial_buyer") continue;
      await tx.query(
        `update crm_bulk_offers set stage = 'declined', declined_reason = 'Buyer changed the request; this stock is no longer wanted',
           data = data || '{"stock": []}'::jsonb, updated_at = now() where id = $1`, [offer.id]);
      offersDropped += 1;
    }

    await tx.query(
      `insert into crm_bulk_listing_activity (bulk_listing_id, person_id, kind, title, body, data)
       values ($1, $2, 'supply', $3, $4, $5)`,
      [listingId, person.id,
        created ? `Buy request from Jules: ${units} units, stock from ${suppliers.length} supplier${suppliers.length === 1 ? "" : "s"} attached`
          : `Buy request resent: ${offersAdded} supplier offer${offersAdded === 1 ? "" : "s"} added, ${offersUpdated} updated, ${offersDropped} dropped`,
        summary,
        JSON.stringify({ sourcing_request_id: input.sourcingRequestId, allocations: allocations.map((a) => ({
          group_key: a.groupKey, label: a.label, wanted: a.wanted, allocated: a.allocated, stock_ids: a.rows.map((r) => r.row.id) })) })]);

    return {
      listingId, created, suppliers: suppliers.length, offersAdded,
      lines: allocations.map((a) => ({ groupKey: a.groupKey, label: a.label, wanted: a.wanted, allocated: a.allocated })),
    };
  });

  try {
    return await write();
  } catch (error) {
    // The daily importer may insert the same demand between our lookup and insert; the second try finds it.
    if ((error as { code?: string }).code === "23505") return write();
    throw error;
  }
}
