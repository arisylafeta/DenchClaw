import { likelihoodScoreSql } from "../bulk-likelihood";
import { randomUUID } from "node:crypto";
import { queryPg } from "../postgres";
import { todayInLondon } from "../bulk-trades";
import type { Basis, ClosedReason, Demand, DemandInput, SuggestedBuyer } from "../bulk-demand";
import type { Buyer, Proposal } from "../bulk-trade-details";
import { addBuyer } from "./bulk-trade-details";
import { addDemandActivity } from "./bulk-demand-activity";
import { companyContextSql } from "./company-context";

// Both qualification gaps and visible inventory use exactly the feed's availability rules. Lots matched by the
// demand matcher are open supply listings; since migration 079 the feed calls them 'trade' only once a buyer is at LOI or won.
const ELIGIBLE_INVENTORY = `
  select feed.*, matched.strength, matched.reason from crm_bulk_trade_demand_matches matched
  join crm_bulk_listing_supply_feed feed on feed.id = matched.lot_id and feed.kind in ('trade', 'auction', 'supply')
  where matched.demand_id = demand.id and not matched.hidden
  union all
  select feed.*, matched.strength, matched.reason from crm_bulk_trade_supply_matches matched
  join crm_bulk_listing_supply_feed feed on feed.id = matched.supply_id and feed.kind = 'supply'
  where matched.demand_id = demand.id and not matched.hidden`;

const DEMAND_SELECT = `
  select demand.id, demand.kind, demand.basis, demand.buyer, demand.company_id, demand.person_id, demand.contact,
    demand.priority, ${companyContextSql("demand.company_id")} as context_notes,
    case when demand.status = 'closed' then '{}'::text[] else array_remove(array[
      case when demand.max_price is null then 'no price' end,
      case when nullif(trim(demand.quantity), '') is null and demand.volume is null then 'no quantity' end,
      case when demand.kind = 'request' and demand.needed_by is null then 'no timeline' end,
      case when nullif(trim(demand.qualify_question), '') is not null and demand.qualify_asked_on is null then 'question not sent' end,
      case when not exists(${ELIGIBLE_INVENTORY}) then 'no supply match' end
    ]::text[], null) end as missing,
    case when demand.status = 'closed' then '[]'::json else coalesce((select json_agg(row_to_json(inventory) order by inventory.strength desc, inventory.title)
      from (${ELIGIBLE_INVENTORY}) inventory), '[]'::json) end as inventory_matches,
    demand.email, demand.wants, demand.quantity, demand.location, demand.note,
    to_char(demand.needed_by, 'YYYY-MM-DD') as needed_by, demand.volume::float8 as volume, demand.volume_unit,
    demand.max_price::float8 as max_price, demand.price_currency, demand.price_unit, demand.spec, demand.context, demand.source_kind,
    demand.source_label, demand.source_url, demand.source_quote, to_char(demand.observed_on, 'YYYY-MM-DD') as observed_on,
    demand.status, demand.closed_reason, to_char(demand.confirmed_on, 'YYYY-MM-DD') as confirmed_on, demand.updated_at,
    demand.product_family, demand.fee_eur::float8 as fee_eur, demand.price_basis, demand.reputation,
    demand.qualify_question, demand.moved_to,
    to_char(demand.qualify_asked_on, 'YYYY-MM-DD') as qualify_asked_on,
    to_char(demand.qualify_entered_on, 'YYYY-MM-DD') as qualify_entered_on,
    (select count(*)::int from crm_bulk_listing_activity activity where activity.bulk_listing_id = demand.id) as activity_count,
    (select max(activity.occurred_at)::text from crm_bulk_listing_activity activity where activity.bulk_listing_id = demand.id) as last_activity_at,
    to_char(greatest(demand.observed_on, demand.confirmed_on), 'YYYY-MM-DD') as asked_on,
    case when demand.status <> 'closed' then ${likelihoodScoreSql(`bulk_demand_score(demand.fee_eur, demand.price_basis, demand.reputation,
      greatest(demand.observed_on, demand.confirmed_on))`, "demand.context")} end as score,
    case when demand.status <> 'closed' then bulk_demand_expected_fee(demand.fee_eur, demand.price_basis, demand.reputation,
      greatest(demand.observed_on, demand.confirmed_on))::float8 end as expected_fee,
    (demand.status <> 'closed' and demand.product_family is not null and (
      exists(select 1 from crm_bulk_listing_supply_feed stock where stock.kind in ('trade', 'auction', 'supply')
        and stock.title ilike '%' || demand.product_family || '%')
    )) as has_stock,
    coalesce((
      select json_agg(json_build_object('lot_id', lot.id, 'title', lot.title, 'strength', m.strength, 'reason', m.reason,
        'buyer_id', m.buyer_id) order by m.strength desc, lot.title)
      from crm_bulk_trade_demand_matches m join crm_bulk_listing_supply_feed lot on lot.id = m.lot_id and lot.kind in ('trade', 'auction', 'supply')
      where m.demand_id = demand.id and demand.status = 'open' and not m.hidden
    ), '[]'::json) as fits,
    coalesce((
      select json_agg(json_build_object('lot_id', listing.id, 'title', coalesce(nullif(listing.spec->>'listing_title', ''), nullif(listing.context->>'listing_title', ''), listing.summary), 'status', case offer.stage
          when 'candidate' then 'To contact' when 'offered' then 'Offered' when 'contract_out' then 'Contract out'
          when 'signed' then 'Signed' when 'invoiced' then 'Invoice out' when 'paid' then 'Paid' when 'complete' then 'Complete'
          when 'declined' then 'Declined' when 'lost' then 'Lost' else 'To contact' end) order by offer.created_at)
      from crm_bulk_offers offer join crm_bulk_listings listing on listing.id = offer.bulk_listing_id
      where offer.counterpart_id = demand.id and offer.role = 'counterparty' and listing.id <> demand.id
    ), '[]'::json) as trades,
    (select company.buyer_tier from crm_companies company where company.id = demand.company_id) as tier
  from crm_bulk_demand demand`;

// Live requests first (soonest date first), then agreed, stated and estimated buy-boxes.
const RANK = `case when demand.kind = 'request' then 0 when demand.basis = 'agreed' then 1 when demand.basis = 'stated' then 2 else 3 end`;
// A-tier buyers first (the procurement-desk shortlist), then B, C and untiered.
const TIER_RANK = `case (select company.buyer_tier from crm_companies company where company.id = demand.company_id)
  when 'A' then 0 when 'B' then 1 when 'C' then 2 else 3 end`;

// Priority moves a row within its score band, never above a hotter qualified opportunity.
const DEMAND_ORDER = `case status when 'open' then 0 when 'qualifying' then 1 else 2 end,
  case when score >= 80 then 0 when score >= 60 then 1 when score >= 40 then 2
    when score is not null then 3 else 4 end,
  priority desc, score desc nulls last, buyer, id`;

/** Open shortlist by expected-fee score, then qualification and closed history. */
export async function listDemand(): Promise<Demand[]> {
  return withWaiting(await queryPg<Demand>(
    `select * from (${DEMAND_SELECT}) ranked order by ${DEMAND_ORDER}`,
  ));
}

/** A company's demand rows, open first, in the same order as the Demand page. */
export async function listDemandForCompany(companyId: string): Promise<Demand[]> {
  return withWaiting(await queryPg<Demand>(
    `select * from (${DEMAND_SELECT} where demand.company_id = $1) ranked order by ${DEMAND_ORDER}`,
    [companyId],
  ));
}

export async function getDemand(id: string): Promise<Demand | null> {
  const [row] = await withWaiting(await queryPg<Demand>(`${DEMAND_SELECT} where demand.id = $1`, [id]));
  return row ?? null;
}

/** Unanswered buyer email older than this has usually moved to WhatsApp or the phone, so it is not flagged. */
const WAITING_DAYS = 30;

type WaitingRow = { person_id: string; company_id: string | null; full_name: string | null; waiting_since: string; last_in_subject: string | null };

/** Adds the buyer contact waiting longest on our reply (by person, else anyone at the company), from one view read. */
async function withWaiting(rows: Demand[]): Promise<Demand[]> {
  const open = rows.filter((row) => row.status === "open" && (row.person_id || row.company_id));
  const waiting = open.length ? await queryPg<WaitingRow>(
    `select person_id, company_id, full_name, waiting_since, last_in_subject from crm_bulk_buyer_waiting
     where waiting_since > now() - interval '${WAITING_DAYS} days' and (person_id = any($1::text[]) or company_id = any($2::text[]))
     order by waiting_since`,
    [open.map((row) => row.person_id).filter(Boolean), open.map((row) => row.company_id).filter(Boolean)],
  ) : [];
  return rows.map((row) => {
    const hit = row.status === "open"
      ? waiting.find((w) => w.person_id === row.person_id) ?? waiting.find((w) => row.company_id && w.company_id === row.company_id)
      : undefined;
    return { ...row, waiting: hit ? { since: new Date(hit.waiting_since).toISOString(), who: hit.full_name, subject: hit.last_in_subject } : null };
  });
}

/** Open "possible demand" cards from the inbox check, newest first. */
export async function possibleDemand(): Promise<Proposal[]> {
  return queryPg<Proposal>(
    `select id::text as id, lot_id, kind, target, proposed, summary, quote, source_kind, source_url, source_label,
       source_at, created_at
     from crm_bulk_trade_proposals where status = 'new' and (kind = 'possible_demand'
       or (source_kind='whatsapp' and kind='needs_triage')) order by created_at desc limit 30`,
  );
}

/** Accepted demand cards stay undoable even when no trade exists. */
export async function acceptedDemandProposals(): Promise<Proposal[]> {
  return queryPg<Proposal>(`select id::text as id,lot_id,kind,target,proposed,summary,quote,source_kind,source_url,
    source_label,source_at,created_at from crm_bulk_trade_proposals
    where status='applied' and kind='possible_demand' order by applied_at desc,id desc limit 30`);
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
  "status", "product_family", "fee_eur", "price_basis", "reputation", "qualify_question", "qualify_asked_on",
  "priority", "context",
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
    context: JSON.stringify(input.context ?? {}),
    observed_on: input.observed_on ?? input.confirmed_on ?? todayInLondon(),
    // Our own estimate is not a confirmation from the buyer.
    confirmed_on: input.confirmed_on ?? (input.basis === "estimated" ? null : todayInLondon()),
    status: input.status ?? "open",
    priority: input.priority ?? false,
  };
  const values = INSERT_KEYS.map((key) => row[key] ?? null);
  const sourceKeys = ["source_kind", "source_id", "source_label", "source_url", "source_quote"] as const;
  await queryPg(
    `insert into crm_bulk_demand (id, ${[...INSERT_KEYS, ...sourceKeys, "created_by"].join(", ")})
     values ($1, ${[...INSERT_KEYS, ...sourceKeys, "created_by"].map((_, i) => `$${i + 2}`).join(", ")})`,
    [id, ...values, ...sourceKeys.map((key) => source[key] ?? null), userId],
  );
  return (await getDemand(id))!;
}

// Column names below come only from validated DemandInput keys.
export async function updateDemand(id: string, input: DemandInput, source: Source = {}): Promise<Demand | null> {
  const patch: Record<string, unknown> = { ...input, ...Object.fromEntries(Object.entries(source).filter(([, v]) => v)) };
  if (input.status === "open" || input.status === "qualifying") {
    patch.closed_reason = null;
    patch.moved_to = null;
  }
  if ("spec" in patch) patch.spec = JSON.stringify(patch.spec ?? {});
  if ("context" in patch) patch.context = JSON.stringify(patch.context);
  const keys = Object.keys(patch);
  // Turning a request into a standing buy-box keeps any basis it has, else it becomes stated.
  const basisFix = input.kind === "standing" && !("basis" in input) ? ", basis = coalesce(basis, 'stated')" : "";
  const matchingFix = input.status === "qualifying" ? ", match_hash = null, supply_match_hash = null"
    : input.status === "open" ? ", match_hash = case when status <> 'open' then null else match_hash end, supply_match_hash = case when status <> 'open' then null else supply_match_hash end" : "";
  if (keys.length) {
    const rows = await queryPg(
      `update crm_bulk_demand set ${keys.map((key, i) => `${key} = $${i + 2}`).join(", ")}${basisFix}${matchingFix}, updated_at = now()
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
    `update crm_bulk_demand set basis = $2,
       confirmed_on = case when $2 = 'estimated' then confirmed_on else $3::date end, updated_at = now()
     where id = $1 and kind = 'standing' returning id`,
    [id, basis, todayInLondon()],
  );
  return rows.length ? getDemand(id) : null;
}

/** A request that keeps coming back becomes a standing buy-box the buyer stated, keeping its history. */
export async function makeStanding(id: string): Promise<Demand | null> {
  const rows = await queryPg(
    `update crm_bulk_demand set kind = 'standing', basis = 'stated', needed_by = null, updated_at = now()
     where id = $1 and kind = 'request' returning id`,
    [id],
  );
  return rows.length ? getDemand(id) : null;
}

/** "Still wanted": confirmed today, and reopened if it was closed. */
export async function confirmDemand(id: string): Promise<Demand | null> {
  // Status transitions are logged atomically by 045; a reconfirmation is useful even while already open.
  const current = await getDemand(id);
  const rows = await queryPg(
    // A reopened row lost its suggestions when it closed, so the next matching passes judge it again.
    `update crm_bulk_demand set confirmed_on = $2, status = 'open', closed_reason = null, updated_at = now(),
       match_hash = case when status <> 'open' then null else match_hash end,
       supply_match_hash = case when status <> 'open' then null else supply_match_hash end
     where id = $1 returning id`,
    [id, todayInLondon()],
  );
  if (rows.length && current?.status === "open") {
    await addDemandActivity({ demandId: id, kind: "status", title: "Still wanted", data: { confirmed_on: todayInLondon() } });
  }
  return rows.length ? getDemand(id) : null;
}

export async function closeDemand(id: string, reason: ClosedReason): Promise<Demand | null> {
  const rows = await queryPg(
    "update crm_bulk_demand set status = 'closed', closed_reason = $2, updated_at = now() where id = $1 returning id",
    [id, reason],
  );
  return rows.length ? getDemand(id) : null;
}

/** Categorizing History never confirms, reopens or changes matching state. */
export async function categorizeDemand(id: string, reason: ClosedReason): Promise<Demand | null> {
  const rows = await queryPg(
    "update crm_bulk_demand set closed_reason = $2, updated_at = now() where id = $1 and status = 'closed' returning id",
    [id, reason],
  );
  return rows.length ? getDemand(id) : null;
}

// One buyer: the CRM company when the row has one, else the buyer name.
const BUYER_KEY = `coalesce(demand.company_id, 'name:' || lower(demand.buyer))`;

/**
 * Open demand the matching picked for a trade, one line per buyer: the buyer's best-fitting row (strong before
 * partial, then requests, agreed, stated, estimated), with their other fitting rows under `more`. Hidden pairs and
 * buyers already on the trade are left out.
 * Two groups: "offer" (buyers we deal with, who told us what they want, or that Alex has tiered) before "introduce"
 * (an untiered company still at Stage New, or without a company, matched only on ReBattery's estimated buy-box). Within a group: A-tier buyers
 * first, then B, C and untiered; then requests, agreed, stated, estimated; strong before partial; then Active,
 * Engaged, Contacted, New.
 */
export async function suggestedBuyers(lotId: string): Promise<SuggestedBuyer[]> {
  return queryPg<SuggestedBuyer>(
    `with fitting as (
       select demand.id as demand_id, demand.kind, demand.basis, demand.buyer, demand.contact, demand.wants,
         to_char(demand.needed_by, 'YYYY-MM-DD') as needed_by, to_char(demand.confirmed_on, 'YYYY-MM-DD') as confirmed_on,
         m.strength, m.reason,
         company.buyer_tier as tier, company.relationship_stage as stage,
         case when demand.basis = 'estimated' and coalesce(company.relationship_stage, 'New') = 'New'
             and company.buyer_tier is null
           then 'introduce' else 'offer' end as "group",
         case company.relationship_stage when 'Active' then 0 when 'Engaged' then 1 when 'Contacted' then 2 else 3 end
           as stage_rank,
         ${BUYER_KEY} as buyer_key,
         ${TIER_RANK} as tier_rank,
         row_number() over (partition by ${BUYER_KEY}
           order by m.strength desc, ${RANK}, demand.needed_by nulls last, demand.confirmed_on desc nulls last, demand.id) as place
       from crm_bulk_trade_demand_matches m join crm_bulk_demand demand on demand.id = m.demand_id
         left join crm_companies company on company.id = demand.company_id
       where m.lot_id = $1 and not m.hidden and m.buyer_id is null and demand.status = 'open'
         and (demand.kind <> 'request' or demand.needed_by is null or demand.needed_by >= current_date)
         and not exists (
           select 1 from crm_bulk_trade_buyers buyer where buyer.lot_id = m.lot_id
             and ((demand.person_id is not null and buyer.person_id = demand.person_id) or lower(buyer.name) = lower(demand.buyer)))
     )
     select best.demand_id, best.kind, best.basis, best.buyer, best.contact, best.wants, best.needed_by, best.confirmed_on,
       best.strength, best.reason, best.tier, best.stage, best."group",
       coalesce((select json_agg(json_build_object('demand_id', other.demand_id, 'wants', other.wants, 'strength', other.strength,
                  'reason', other.reason) order by other.place)
                 from fitting other where other.buyer_key = best.buyer_key and other.place > 1), '[]'::json) as more
     from fitting best
     where best.place = 1
     order by best."group" = 'introduce', best.tier_rank, case when best.kind = 'request' then 0 when best.basis = 'agreed' then 1
       when best.basis = 'stated' then 2 else 3 end, best.strength desc, best.stage_rank, best.needed_by nulls last,
       best.confirmed_on desc nulls last`,
    [lotId],
  );
}

/** "Not a fit": hides the buyer (every row of theirs) for this trade; it stays hidden after re-matching. */
export async function hideSuggestion(lotId: string, demandId: string): Promise<boolean> {
  const rows = await queryPg(
    `update crm_bulk_trade_demand_matches m set hidden = true
     from crm_bulk_demand demand
     where m.lot_id = $1 and demand.id = m.demand_id
       and ${BUYER_KEY} = (select ${BUYER_KEY} from crm_bulk_demand demand where demand.id = $2)
     returning m.demand_id`,
    [lotId, demandId],
  );
  return rows.length > 0;
}

/** The latest demand-matching pass, for the "Matched 08:00" line. */
export async function lastMatchRun(): Promise<{ at: string; status: "running" | "ok" | "failed"; matches: number } | null> {
  const [row] = await queryPg<{ at: string; status: "running" | "ok" | "failed"; matches: number }>(
    `select coalesce(finished_at, started_at) as at, status, proposals_made as matches
     from crm_bulk_trade_check_runs where kind = 'match' order by started_at desc limit 1`,
  );
  return row ?? null;
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
  // Trades Preview reads buyers as offers; the offer shares the buyer's id, as the Bulk Trades reconcile does.
  await queryPg(
    `insert into crm_bulk_offers (id, bulk_listing_id, role, person_id, company_id, name, contact, wants, counterpart_id, stage, data)
     select $1, l.id, 'counterparty', $3, $4, $5, $6, $7, $2, 'candidate', '{"source": "suggested buyer"}'
     from crm_bulk_listings l where l.id = $8
     on conflict (id) do update set counterpart_id = excluded.counterpart_id`,
    [buyer.id, demandId, demand.person_id, demand.company_id, demand.buyer, contact, demand.wants, lotId],
  );
  await queryPg(
    `insert into crm_bulk_trade_demand_matches (demand_id, lot_id, strength, reason, buyer_id)
     values ($1, $2, 'partial', 'Added by hand', $3)
     on conflict (demand_id, lot_id) do update set buyer_id = excluded.buyer_id`,
    [demandId, lotId, buyer.id],
  );
  return buyer;
}
