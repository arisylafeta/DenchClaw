import { randomUUID } from "node:crypto";
import { queryPg } from "../postgres";
import { todayInLondon } from "../bulk-trades";
import type { Basis, ClosedReason, Demand, DemandInput, SuggestedBuyer } from "../bulk-demand";
import type { Buyer, Proposal } from "../bulk-trade-details";
import { addBuyer } from "./bulk-trade-details";

const DEMAND_SELECT = `
  select demand.id, demand.kind, demand.basis, demand.buyer, demand.company_id, demand.person_id, demand.contact,
    demand.email, demand.wants, demand.quantity, demand.location, demand.note,
    to_char(demand.needed_by, 'YYYY-MM-DD') as needed_by, demand.volume::float8 as volume, demand.volume_unit,
    demand.max_price::float8 as max_price, demand.price_currency, demand.price_unit, demand.spec, demand.source_kind,
    demand.source_label, demand.source_url, demand.source_quote, to_char(demand.observed_on, 'YYYY-MM-DD') as observed_on,
    demand.status, demand.closed_reason, to_char(demand.confirmed_on, 'YYYY-MM-DD') as confirmed_on, demand.updated_at,
    coalesce((
      select json_agg(json_build_object('lot_id', lot.id, 'title', lot.title, 'strength', m.strength, 'reason', m.reason,
        'buyer_id', m.buyer_id) order by m.strength desc, lot.title)
      from crm_bulk_trade_demand_matches m join crm_bulk_trade_lots lot on lot.id = m.lot_id
      where m.demand_id = demand.id and not m.hidden
        and lot.trade_stage in ('Needs info', 'With buyers', 'Closing')
    ), '[]'::json) as fits,
    coalesce((
      select json_agg(json_build_object('lot_id', lot.id, 'title', lot.title, 'status', buyer.status) order by buyer.created_at)
      from crm_bulk_trade_buyers buyer join crm_bulk_trade_lots lot on lot.id = buyer.lot_id
      where buyer.demand_id = demand.id
    ), '[]'::json) as trades
  from crm_bulk_trade_demand demand`;

// Live requests first (soonest date first), then agreed, stated and estimated buy-boxes.
const RANK = `case when demand.kind = 'request' then 0 when demand.basis = 'agreed' then 1 when demand.basis = 'stated' then 2 else 3 end`;

/** Every demand row: open first, then requests by date, then buy-boxes by basis and buyer. */
export async function listDemand(): Promise<Demand[]> {
  return queryPg<Demand>(
    `${DEMAND_SELECT} order by demand.status = 'closed', ${RANK}, demand.needed_by nulls last, demand.buyer,
       demand.confirmed_on desc nulls last`,
  );
}

export async function getDemand(id: string): Promise<Demand | null> {
  const [row] = await queryPg<Demand>(`${DEMAND_SELECT} where demand.id = $1`, [id]);
  return row ?? null;
}

/** Open "possible demand" cards from the inbox check, newest first. */
export async function possibleDemand(): Promise<Proposal[]> {
  return queryPg<Proposal>(
    `select id::text as id, lot_id, kind, target, proposed, summary, quote, source_kind, source_url, source_label,
       source_at, created_at
     from crm_bulk_trade_proposals where status = 'new' and kind = 'possible_demand' order by created_at desc limit 30`,
  );
}

/** The CRM person and company for an email address, when the CRM knows it. */
export async function crmIdsForEmail(email: string | null | undefined) {
  if (!email) return { person_id: null, company_id: null };
  const [row] = await queryPg<{ person_id: string; company_id: string | null }>(
    "select id as person_id, company_id from crm_people where lower(email) = lower($1) order by updated_at desc nulls last limit 1",
    [email],
  );
  return row ?? { person_id: null, company_id: null };
}

type Source = {
  source_kind?: string | null;
  source_id?: string | null;
  source_label?: string | null;
  source_url?: string | null;
  source_quote?: string | null;
};

const INSERT_KEYS = [
  "kind", "basis", "buyer", "company_id", "person_id", "contact", "email", "wants", "quantity", "location", "note",
  "needed_by", "volume", "volume_unit", "max_price", "price_currency", "price_unit", "spec", "observed_on", "confirmed_on",
] as const;

export async function addDemand(input: DemandInput & { buyer: string; wants: string }, userId: string | null, source: Source = {}) {
  const id = `btd_${randomUUID()}`;
  const kind = input.kind ?? "standing";
  const row: Record<string, unknown> = {
    ...input,
    kind,
    basis: kind === "standing" ? input.basis ?? "stated" : null,
    needed_by: kind === "request" ? input.needed_by ?? null : null,
    spec: JSON.stringify(input.spec ?? {}),
    observed_on: input.observed_on ?? input.confirmed_on ?? todayInLondon(),
    // Our own estimate is not a confirmation from the buyer.
    confirmed_on: input.confirmed_on ?? (input.basis === "estimated" ? null : todayInLondon()),
  };
  const values = INSERT_KEYS.map((key) => row[key] ?? null);
  const sourceKeys = ["source_kind", "source_id", "source_label", "source_url", "source_quote"] as const;
  await queryPg(
    `insert into crm_bulk_trade_demand (id, ${[...INSERT_KEYS, ...sourceKeys, "created_by"].join(", ")})
     values ($1, ${[...INSERT_KEYS, ...sourceKeys, "created_by"].map((_, i) => `$${i + 2}`).join(", ")})`,
    [id, ...values, ...sourceKeys.map((key) => source[key] ?? null), userId],
  );
  return (await getDemand(id))!;
}

// Column names below come only from validated DemandInput keys.
export async function updateDemand(id: string, input: DemandInput, source: Source = {}): Promise<Demand | null> {
  const patch: Record<string, unknown> = { ...input, ...Object.fromEntries(Object.entries(source).filter(([, v]) => v)) };
  if ("spec" in patch) patch.spec = JSON.stringify(patch.spec ?? {});
  const keys = Object.keys(patch);
  // Turning a request into a standing buy-box keeps any basis it has, else it becomes stated.
  const basisFix = input.kind === "standing" && !("basis" in input) ? ", basis = coalesce(basis, 'stated')" : "";
  if (keys.length) {
    const rows = await queryPg(
      `update crm_bulk_trade_demand set ${keys.map((key, i) => `${key} = $${i + 2}`).join(", ")}${basisFix}, updated_at = now()
       where id = $1 returning id`,
      [id, ...keys.map((key) => patch[key])],
    );
    if (!rows.length) return null;
  }
  return getDemand(id);
}

/** Moves a standing buy-box to a basis. Agreeing with the buyer also confirms it today. */
export async function setBasis(id: string, basis: Basis): Promise<Demand | null> {
  const rows = await queryPg(
    `update crm_bulk_trade_demand set basis = $2,
       confirmed_on = case when $2 = 'estimated' then confirmed_on else $3::date end, updated_at = now()
     where id = $1 and kind = 'standing' returning id`,
    [id, basis, todayInLondon()],
  );
  return rows.length ? getDemand(id) : null;
}

/** A request that keeps coming back becomes a standing buy-box the buyer stated, keeping its history. */
export async function makeStanding(id: string): Promise<Demand | null> {
  const rows = await queryPg(
    `update crm_bulk_trade_demand set kind = 'standing', basis = 'stated', needed_by = null, updated_at = now()
     where id = $1 and kind = 'request' returning id`,
    [id],
  );
  return rows.length ? getDemand(id) : null;
}

/** "Still wanted": confirmed today, and reopened if it was closed. */
export async function confirmDemand(id: string): Promise<Demand | null> {
  const rows = await queryPg(
    `update crm_bulk_trade_demand set confirmed_on = $2, status = 'open', closed_reason = null, updated_at = now()
     where id = $1 returning id`,
    [id, todayInLondon()],
  );
  return rows.length ? getDemand(id) : null;
}

export async function closeDemand(id: string, reason: ClosedReason): Promise<Demand | null> {
  const rows = await queryPg(
    "update crm_bulk_trade_demand set status = 'closed', closed_reason = $2, updated_at = now() where id = $1 returning id",
    [id, reason],
  );
  return rows.length ? getDemand(id) : null;
}

/** Open demand the matching picked for a trade, minus hidden ones and buyers already on the trade. Requests
 * first, then agreed, stated and estimated buy-boxes; strong before partial within each. */
export async function suggestedBuyers(lotId: string): Promise<SuggestedBuyer[]> {
  return queryPg<SuggestedBuyer>(
    `select demand.id as demand_id, demand.kind, demand.basis, demand.buyer, demand.contact, demand.wants,
       to_char(demand.needed_by, 'YYYY-MM-DD') as needed_by, to_char(demand.confirmed_on, 'YYYY-MM-DD') as confirmed_on,
       m.strength, m.reason
     from crm_bulk_trade_demand_matches m join crm_bulk_trade_demand demand on demand.id = m.demand_id
     where m.lot_id = $1 and not m.hidden and m.buyer_id is null and demand.status = 'open'
       and (demand.kind <> 'request' or demand.needed_by is null or demand.needed_by >= current_date)
       and not exists (
         select 1 from crm_bulk_trade_buyers buyer where buyer.lot_id = m.lot_id
           and ((demand.person_id is not null and buyer.person_id = demand.person_id) or lower(buyer.name) = lower(demand.buyer)))
     order by ${RANK}, m.strength desc, demand.needed_by nulls last, demand.confirmed_on desc nulls last`,
    [lotId],
  );
}

/** "Not a fit": hidden for this trade, and stays hidden after re-matching. */
export async function hideSuggestion(lotId: string, demandId: string): Promise<boolean> {
  const rows = await queryPg(
    "update crm_bulk_trade_demand_matches set hidden = true where lot_id = $1 and demand_id = $2 returning demand_id",
    [lotId, demandId],
  );
  return rows.length > 0;
}

/** Adds the demand's buyer to the trade at To contact, with their want as Wants, and links the buyer and the match
 * to the demand so offers and wins count against it. */
export async function addSuggestedBuyer(lotId: string, demandId: string, userId: string): Promise<Buyer | null> {
  const demand = await getDemand(demandId);
  if (!demand) return null;
  const contact = [demand.contact, demand.email].filter(Boolean).join(" · ") || null;
  const buyer = await addBuyer(lotId, { name: demand.buyer, contact, wants: demand.wants, person_id: demand.person_id }, userId);
  if (!buyer) return null;
  await queryPg("update crm_bulk_trade_buyers set demand_id = $2 where id = $1", [buyer.id, demandId]);
  await queryPg(
    `insert into crm_bulk_trade_demand_matches (demand_id, lot_id, strength, reason, buyer_id)
     values ($1, $2, 'partial', 'Added by hand', $3)
     on conflict (demand_id, lot_id) do update set buyer_id = excluded.buyer_id`,
    [demandId, lotId, buyer.id],
  );
  return buyer;
}
