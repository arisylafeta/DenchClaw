import "server-only";

// Stored matching for one deal (crm_bulk_matches, migration 113). A person starts a run ("Find matches"); the scorer the
// live Matches tab uses narrows the candidates, the best five are stored with the scorer's order and the model's, and
// every answer after that lands on the same row: asked, yes (an offer row at candidate), no (with a reason, and the next
// best comes in), offered (by trigger, with a reservation of a quantity), extend and release. Nothing here sends: an ask
// returns a draft made by the offer draft path, and a person sends it.
import { randomUUID } from "node:crypto";
import { queryPg, type PgTransaction } from "../postgres";
import { buildProductKey, type FieldFact } from "../match/product-key";
import { addressParts, buildOfferEmail, OfferEmailRefused, type BuyerFacts, type OfferEmailKind, type RequestFacts } from "../match/offer-email";
import { createOfferEmailDraft, OfferDraftError } from "../match/offer-draft";
import { modelRanker, type MatchRanker } from "../match/match-ranker";
import {
  askedAgo, candidateFacts, candidateRef, checkRanking, checksOf, LIVE_STATES, NO_REASON_MAX, quoteInDate, reservationLive,
  reservationUntil, ruleReason, SCORER_VERSION, today as londonToday, TOP, unitKey,
  type CandidateRef, type MatchState,
} from "../match/stored-match";
import type { MatchesResult, MatchRow } from "../matches-types";
import { addOffer, OfferConflict, updateOffer } from "./bulk-offers";
import { asStageActor } from "./bulk-stage-events";
import { demandMatchesV2 } from "./demand-matches-v2";
import { supplyMatchesV2 } from "./supply-matches-v2";
import { readMailDraft } from "./mail";

export class MatchError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "MatchError";
  }
}

/** A route's answer to a refused match action: its status and plain message. Anything else is a real error. */
export function matchFailure(error: unknown): Response {
  if (error instanceof MatchError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  throw error;
}

export type MatchActor = { userId: string | null; email: string | null };

/** What a run needs from outside, so tests can stand in for the scorer, the model and the mail CLI. */
export type MatchDeps = {
  scorer?: (deal: Deal) => Promise<MatchesResult | null>;
  ranker?: MatchRanker | null;
  draft?: (input: { to: string[]; subject: string; body: string }) => Promise<string>;
  now?: Date;
};

type Deal = {
  id: string; kind: "supply" | "demand"; party: string; contact: string | null; email: string | null;
  person_id: string | null; company_id: string | null; location: string | null; status: string;
  spec: Record<string, unknown>; context: Record<string, unknown>; stage: string | null; qualified: boolean;
  title: string | null; person_name: string | null; company_name: string | null;
};

type StoredRow = {
  id: string; deal_id: string; candidate_kind: CandidateRef["kind"]; candidate_id: string; candidate_key: string;
  name: string; company_id: string | null; person_id: string | null; contact: string | null;
  stock_kind: CandidateRef["stockKind"]; stock_id: string; candidate_qty: number | null;
  rank: number | null; scorer_rank: number | null; checks: Record<string, unknown>; reason: string | null;
  scored_by: Record<string, unknown>; state: MatchState; note: string | null; asked_at: string | null; chases: number;
  verdict: "yes" | "no" | null; verdict_reason: string | null; verdict_at: string | null; verdict_by: string | null;
  confirmed_qty: number | null; quote: { amount?: number; currency?: string; unit?: string } | null; quote_valid_until: string | null;
  reserved_qty: number | null; reserved_until: string | null; offer_id: string | null; data: Record<string, unknown>;
  created_at: string; updated_at: string;
};

export type StoredMatchView = Omit<StoredRow, "data" | "deal_id"> & {
  /** The reservation counts only while it is live: offered and not past its last day. */
  reservation_live: boolean;
  /** Live reservations on the same stock by every deal: rows, summed quantity, rows holding the lot without a quantity. */
  stock_reserved: { holds: number; qty: number; whole: number };
  offer_stage: string | null;
  asked: { days: number; label: string } | null;
  open_draft_id: string | null;
};

export type SellerQuote = { value: string | null; status: string | null; validUntil: string | null; inDate: boolean };

export type StoredMatches = {
  deal: { id: string; kind: "supply" | "demand"; stage: string | null; qualified: boolean };
  run: { at: string; by: string | null; count: number } | null;
  /** The five, in the model's order (or the scorer's when the model step was not used). */
  matches: StoredMatchView[];
  /** Standing requests: new supply that may fit, found since the last run. Proposed, not in the five. */
  markers: StoredMatchView[];
  /** Everything else this deal has answered: declined, replaced and expired rows, newest first. */
  past: StoredMatchView[];
  /** Supply deals: the seller's quote, which must be in date before any buyer is asked. */
  sellerQuote: SellerQuote | null;
  reconfirm: { at: string; draft_id: string | null } | null;
};

const MATCH_COLUMNS = `m.id, m.deal_id, m.candidate_kind, m.candidate_id, m.candidate_key, m.name, m.company_id, m.person_id, m.contact,
  m.stock_kind, m.stock_id, m.candidate_qty::float8 as candidate_qty, m.rank, m.scorer_rank, m.checks, m.reason, m.scored_by,
  m.state, m.note, m.asked_at::text as asked_at, m.chases, m.verdict, m.verdict_reason, m.verdict_at::text as verdict_at,
  m.verdict_by, m.confirmed_qty::float8 as confirmed_qty, m.quote, m.quote_valid_until::text as quote_valid_until,
  m.reserved_qty::float8 as reserved_qty, m.reserved_until::text as reserved_until, m.offer_id, m.data,
  m.created_at::text as created_at, m.updated_at::text as updated_at`;

async function readDeal(dealId: string): Promise<Deal | null> {
  const [row] = await queryPg<Deal>(
    `select l.id, l.kind, l.party, l.contact, l.email, l.person_id, l.company_id, l.location, l.status, l.spec, l.context,
            bulk_listing_stage(l.id) as stage, bulk_listing_qualified(l.id) as qualified,
            coalesce(nullif(l.spec->>'listing_title', ''), nullif(l.context->>'listing_title', ''), l.summary) as title,
            p.full_name as person_name, c.name as company_name
     from crm_bulk_listings l left join crm_people p on p.id = l.person_id left join crm_companies c on c.id = l.company_id
     where l.id = $1`, [dealId]);
  return row ?? null;
}

async function readRows(dealId: string): Promise<StoredRow[]> {
  return queryPg<StoredRow>(`select ${MATCH_COLUMNS} from crm_bulk_matches m where m.deal_id = $1 order by m.rank nulls last, m.updated_at desc`, [dealId]);
}

async function readRow(dealId: string, matchId: string, tx?: PgTransaction): Promise<StoredRow | null> {
  const sql = `select ${MATCH_COLUMNS} from crm_bulk_matches m where m.deal_id = $1 and m.id = $2${tx ? " for update" : ""}`;
  const rows = tx ? (await tx.query<StoredRow>(sql, [dealId, matchId])).rows : await queryPg<StoredRow>(sql, [dealId, matchId]);
  return rows[0] ?? null;
}

const scoreDeal = (deal: Deal) => (deal.kind === "demand" ? demandMatchesV2(deal.id) : supplyMatchesV2(deal.id));

/** The seller's quote on a supply deal: the `seller_price` field and its last day (spec.seller_quote_valid_until). */
export async function sellerQuote(dealId: string, now: Date = new Date()): Promise<SellerQuote> {
  const [row] = await queryPg<{ value: string | null; status: string | null; valid_until: string | null }>(
    `select f.value, f.status, bulk_listing_quote_until(l.id)::text as valid_until
     from crm_bulk_listings l left join crm_bulk_listing_fields f on f.bulk_listing_id = l.id and f.field_key = 'seller_price'
     where l.id = $1`, [dealId]);
  const quote = { value: row?.value ?? null, status: row?.status ?? null, validUntil: row?.valid_until ?? null };
  return { ...quote, inDate: quoteInDate(quote, londonToday(now)) };
}

type Availability = { key: string; blocked: string | null; holds: number; qty: number; whole: number };

/**
 * Why a candidate may not be matched now (closed, gone or stale, sold, contracted, excluded), and what other deals hold
 * of its stock. Out-of-date reservations count as free: only offered rows whose last day is today or later are read.
 */
async function availability(dealId: string, refs: (CandidateRef & { key: string })[]): Promise<Map<string, Availability>> {
  if (!refs.length) {
    return new Map();
  }
  const rows = await queryPg<Availability>(
    `with refs as (select * from jsonb_to_recordset($1::jsonb) as r(key text, kind text, id text, "stockKind" text, "stockId" text))
     select r.key,
       case r.kind
         when 'listing' then (select case when l.id is null then 'gone' when l.status = 'closed' then 'closed'
             when (bulk_listing_offer_rank(l.id)).rank >= 5 then 'sold' when (bulk_listing_offer_rank(l.id)).rank >= 4 then 'contracted' end
           from (select 1) one left join crm_bulk_listings l on l.id = r.id)
         when 'stock' then (select case when s.id is null or s.status in ('stale', 'rejected') then 'stale'
             when coalesce(s.details->'availability'->>'state', '') in ('sold', 'not_found', 'gone') then 'sold'
             when exists (select 1 from crm_bulk_offers o where o.data->>'stock_opportunity_id' = s.id
               and o.stage in ('contract_out', 'signed', 'invoiced', 'paid', 'complete')) then 'contracted' end
           from (select 1) one left join crm_stock_opportunities s on s.id = r.id)
         when 'marketplace' then (select case when s.marketplace_status = 'completed' then 'sold' end
           from crm_stock_opportunities s where s.marketplace_listing_id = r.id limit 1)
         when 'company' then (select case when c.id is null then 'gone' when c.buyer_exclusion_reason is not null then 'excluded' end
           from (select 1) one left join crm_companies c on c.id = r.id)
       end as blocked,
       x.holds, x.qty::float8 as qty, x.whole
     from refs r cross join lateral (
       select count(*)::int as holds, coalesce(sum(m.reserved_qty), 0) as qty, (count(*) filter (where m.reserved_qty is null))::int as whole
       from crm_bulk_matches m
       where m.stock_kind = r."stockKind" and m.stock_id = r."stockId" and m.deal_id <> $2
         and m.state = 'offered' and m.reserved_until >= current_date) x`,
    [JSON.stringify(refs), dealId]);
  return new Map(rows.map((row) => [row.key, row]));
}

/** Fully reserved by other deals: nothing left of a stated quantity, or any hold on a lot that states none. */
const fullyReserved = (a: Availability | undefined, qty: number | null) =>
  !!a && a.holds > 0 && (qty == null || a.whole > 0 || a.qty >= qty);

const BLOCKED_TEXT: Record<string, string> = {
  gone: "no longer in the CRM", closed: "closed", stale: "stale or gone at the source", sold: "sold", contracted: "under contract",
  excluded: "excluded as a buyer", reserved: "fully reserved for another deal",
};

/** The candidate's units: a request row states its own; on a supply deal every candidate holds a share of the lot. */
const qtyFor = (deal: Deal, scored: MatchesResult, row: MatchRow) =>
  (deal.kind === "supply" ? scored.units ?? null : row.units ?? null);

/** A stored row read back as a Matches row, so a held candidate the scorer no longer lists still reaches the model. */
function rowFromStored(row: StoredRow): MatchRow {
  const checks = row.checks as { reason?: string; checks?: string[]; tags?: MatchRow["tags"]; fit?: MatchRow["fit"]; units?: number; country?: string; holds?: string; price?: string };
  return {
    key: row.candidate_key, rank: row.scorer_rank ?? 99, name: row.name, detail: null, tags: checks.tags ?? [],
    reason: checks.reason ?? row.reason ?? "", checks: checks.checks ?? [], price: checks.price ?? null, offer: null,
    companyId: row.company_id, personId: row.person_id, contact: row.contact, stockId: null,
    fit: checks.fit, units: checks.units ?? row.candidate_qty, country: checks.country ?? null, holds: checks.holds,
  };
}

type Pick = { ref: CandidateRef; row: MatchRow; scorerRank: number; held: StoredRow | null; qty: number | null };

/**
 * The five: what a person has already acted on stays (asked, confirmed, offered), then the scorer's best that are not
 * closed, gone, sold, contracted, fully reserved by another deal or already declined or expired on this deal.
 */
async function pickFive(deal: Deal, scored: MatchesResult, existing: StoredRow[]): Promise<{ picks: Pick[]; skipped: { key: string; why: string }[] }> {
  const byRef = new Map(existing.map((row) => [`${row.candidate_kind}:${row.candidate_id}`, row]));
  const held = existing.filter((row) => row.rank != null && (row.state === "asked" || row.state === "confirmed" || row.state === "offered"))
    .sort((a, b) => (a.rank ?? 9) - (b.rank ?? 9));
  const heldKeys = new Set(held.map((row) => `${row.candidate_kind}:${row.candidate_id}`));
  const fresh = scored.rows.map((row, index) => ({ row, index, ref: candidateRef(row.key, deal) }))
    .filter((item): item is { row: MatchRow; index: number; ref: CandidateRef } => !!item.ref);
  const free = await availability(deal.id, fresh.map(({ row, ref }) => ({ ...ref, key: row.key })));
  const skipped: { key: string; why: string }[] = [];
  const picks: Pick[] = held.map((row) => {
    const live = fresh.find((item) => item.ref.kind === row.candidate_kind && item.ref.id === row.candidate_id);
    return {
      ref: { kind: row.candidate_kind, id: row.candidate_id, stockKind: row.stock_kind, stockId: row.stock_id },
      row: live?.row ?? rowFromStored(row), scorerRank: live ? live.index + 1 : row.scorer_rank ?? 99, held: row,
      qty: live ? qtyFor(deal, scored, live.row) : row.candidate_qty,
    };
  });
  for (const item of fresh) {
    if (picks.length >= TOP) {
      break;
    }
    const id = `${item.ref.kind}:${item.ref.id}`;
    if (heldKeys.has(id)) {
      continue;
    }
    const before = byRef.get(id);
    if (before && (before.state === "declined" || before.state === "expired")) {
      skipped.push({ key: item.row.key, why: before.state === "declined" ? "declined for this deal" : "expired on this deal" });
      continue;
    }
    const qty = qtyFor(deal, scored, item.row);
    const status = free.get(item.row.key);
    const blocked = status?.blocked ?? (fullyReserved(status, qty) ? "reserved" : null);
    if (blocked) {
      skipped.push({ key: item.row.key, why: BLOCKED_TEXT[blocked] ?? blocked });
      continue;
    }
    picks.push({ ref: item.ref, row: item.row, scorerRank: item.index + 1, held: before ?? null, qty });
  }
  return { picks, skipped };
}

/** The deal's own side, which must never be named to a candidate: its party, contact and exact address. */
function privateValues(deal: Deal): string[] {
  return [deal.party, deal.contact, deal.email, deal.person_name, deal.company_name, ...addressParts(deal.location)]
    .map((value) => (value ?? "").trim()).filter(Boolean);
}

/** Every name the model's reasons must not contain: the deal's side and each candidate. */
const forbiddenNames = (deal: Deal, rows: MatchRow[]) => [...privateValues(deal), ...rows.flatMap((row) => [row.name, row.contact])];

type Ranked = { rank: Map<Pick, number>; reason: Map<Pick, string>; scoredBy: Record<string, unknown> };

/** The model step: reorder and explain, or the scorer's order and plain reasons when it fails or says too much. */
async function rankFive(deal: Deal, scored: MatchesResult, picks: Pick[], ranker: MatchRanker | null): Promise<Ranked> {
  const byScorer = [...picks].sort((a, b) => a.scorerRank - b.scorerRank);
  const ids = byScorer.map((_, index) => `c${index + 1}`);
  const facts = Object.fromEntries(byScorer.map((pick, index) => [ids[index], candidateFacts(pick.row)]));
  const forbidden = forbiddenNames(deal, picks.map((pick) => pick.row));
  const base = { scorer: SCORER_VERSION, at: new Date().toISOString() };
  const fallback = (why: string): Ranked => ({
    rank: new Map(byScorer.map((pick, index) => [pick, index + 1])),
    reason: new Map(byScorer.map((pick) => [pick, ruleReason(pick.row, forbidden)])),
    scoredBy: { ...base, model: null, fallback: why },
  });
  if (!ranker || !picks.length) {
    return fallback(ranker ? "nothing to rank" : "model step off");
  }
  const refused = (why: string): Ranked => {
    const out = fallback(why);
    return { ...out, scoredBy: { ...out.scoredBy, model: ranker.model, prompt: ranker.prompt } };
  };
  let raw: unknown;
  try {
    raw = await ranker.rank({ side: deal.kind, ask: scored.lotKey.line, candidates: ids.map((id) => ({ id, facts: facts[id] })) });
  } catch (error) {
    return refused(`model failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const checked = checkRanking(raw, { ids, facts, ask: scored.lotKey.line, forbidden });
  if (!checked.ok) {
    return refused(`model answer refused: ${checked.why}`);
  }
  const pickOf = new Map(ids.map((id, index) => [id, byScorer[index]]));
  return {
    rank: new Map(checked.ranking.order.map((id, index) => [pickOf.get(id)!, index + 1])),
    reason: new Map(ids.map((id) => [pickOf.get(id)!, checked.ranking.reasons[id]])),
    scoredBy: { ...base, model: ranker.model, prompt: ranker.prompt },
  };
}

async function activity(tx: PgTransaction, dealId: string, actor: MatchActor, title: string, data: Record<string, unknown>, body: string | null = null) {
  await tx.query(
    `insert into crm_bulk_listing_activity (bulk_listing_id, kind, title, body, data, actor_user_id) values ($1, 'supply', $2, $3, $4::jsonb, $5)`,
    [dealId, title, body, JSON.stringify(data), actor.userId]);
}

const matchId = () => `bmt_${randomUUID()}`;

async function upsert(tx: PgTransaction, deal: Deal, pick: Pick, values: { rank: number | null; reason: string; scoredBy: Record<string, unknown>; note?: string | null }) {
  await tx.query(
    `insert into crm_bulk_matches (id, deal_id, candidate_kind, candidate_id, candidate_key, name, company_id, person_id, contact,
       stock_kind, stock_id, candidate_qty, rank, scorer_rank, checks, reason, scored_by, note)
     values ($1, $2, $3, $4, $5, $6, (select id from crm_companies where id = $7), (select id from crm_people where id = $8), $9,
       $10, $11, $12, $13, $14, $15::jsonb, $16, $17::jsonb, $18)
     on conflict (deal_id, candidate_kind, candidate_id) do update set
       candidate_key = excluded.candidate_key, name = excluded.name, company_id = excluded.company_id, person_id = excluded.person_id,
       contact = coalesce(excluded.contact, crm_bulk_matches.contact),
       -- An offered row keeps the quantity its reservation was checked against.
       candidate_qty = case when crm_bulk_matches.state = 'offered' then crm_bulk_matches.candidate_qty else excluded.candidate_qty end,
       rank = excluded.rank,
       scorer_rank = excluded.scorer_rank, checks = excluded.checks, reason = excluded.reason, scored_by = excluded.scored_by,
       state = case when crm_bulk_matches.state = 'replaced' then 'proposed' else crm_bulk_matches.state end,
       note = case when excluded.rank is not null and crm_bulk_matches.state in ('proposed', 'replaced') then null
                   else coalesce(excluded.note, crm_bulk_matches.note) end,
       updated_at = now()`,
    [matchId(), deal.id, pick.ref.kind, pick.ref.id, pick.row.key, pick.row.name, pick.row.companyId, pick.row.personId, pick.row.contact,
      pick.ref.stockKind, pick.ref.stockId, pick.qty != null && pick.qty > 0 ? pick.qty : null, values.rank, pick.scorerRank,
      JSON.stringify(checksOf(pick.row)), values.reason, JSON.stringify(values.scoredBy), values.note ?? null]);
}

/**
 * A match run on one deal, started by a person. Stores the five with both orders and returns the tab's view. Rows a
 * person has acted on are kept; proposed rows that fall out are marked replaced, never deleted.
 */
export async function runMatches(dealId: string, actor: MatchActor, deps: MatchDeps = {}): Promise<StoredMatches> {
  const deal = await readDeal(dealId);
  if (!deal) {
    throw new MatchError(404, "Listing not found");
  }
  if (deal.status === "closed" || deal.stage === "Sold" || deal.stage === "Closed") {
    throw new MatchError(409, "This deal is closed, so there is nothing to match.");
  }
  const scored = await (deps.scorer ?? scoreDeal)(deal);
  if (!scored) {
    throw new MatchError(404, "Listing not found");
  }
  const existing = await readRows(dealId);
  const { picks, skipped } = await pickFive(deal, scored, existing);
  const ranked = await rankFive(deal, scored, picks, deps.ranker === undefined ? modelRanker : deps.ranker);
  const at = (deps.now ?? new Date()).toISOString();
  await asStageActor(actor.userId, async (tx) => {
    for (const pick of picks) {
      await upsert(tx, deal, pick, { rank: ranked.rank.get(pick)!, reason: ranked.reason.get(pick)!, scoredBy: ranked.scoredBy });
    }
    const kept = picks.map((pick) => `${pick.ref.kind}:${pick.ref.id}`);
    await tx.query(
      `update crm_bulk_matches set state = 'replaced', rank = null, updated_at = now()
       where deal_id = $1 and state = 'proposed' and rank is not null and not ((candidate_kind || ':' || candidate_id) = any($2::text[]))`,
      [dealId, kept]);
    const run = { at, by: actor.email, count: picks.length, checked_at: at };
    await tx.query(`update crm_bulk_listings set context = context || jsonb_build_object('match_run', $2::jsonb) where id = $1`, [dealId, JSON.stringify(run)]);
    await activity(tx, dealId, actor, picks.length ? `Found ${picks.length} ${picks.length === 1 ? "match" : "matches"}` : "Found no matches",
      { match_run: { count: picks.length, skipped: skipped.slice(0, 20), scored_by: ranked.scoredBy } });
  });
  return listStoredMatches(dealId, deps.now);
}

/** One deal's stored matches, as the tab shows them. Reservations past their last day read as free here and everywhere. */
export async function listStoredMatches(dealId: string, now: Date = new Date()): Promise<StoredMatches> {
  const deal = await readDeal(dealId);
  if (!deal) {
    throw new MatchError(404, "Listing not found");
  }
  const day = londonToday(now);
  const rows = await queryPg<StoredRow & { offer_stage: string | null; holds: number; reserved_total: number; whole: number }>(
    `select ${MATCH_COLUMNS}, o.stage as offer_stage, x.holds, x.qty::float8 as reserved_total, x.whole
     from crm_bulk_matches m
     left join crm_bulk_offers o on o.id = m.offer_id
     cross join lateral bulk_match_reserved(m.stock_kind, m.stock_id) x
     where m.deal_id = $1
     order by m.rank nulls last, m.updated_at desc`, [dealId]);
  const view = (row: (typeof rows)[number]): StoredMatchView => {
    const { data, deal_id: _deal, holds, reserved_total, whole, ...rest } = row;
    return {
      ...rest,
      reservation_live: reservationLive(row, day),
      stock_reserved: { holds, qty: reserved_total, whole },
      asked: askedAgo(row, now),
      open_draft_id: typeof data.open_draft_id === "string" ? data.open_draft_id : null,
    };
  };
  const run = deal.context.match_run as { at?: string; by?: string | null; count?: number } | undefined;
  const reconfirm = deal.context.match_reconfirm as { at?: string; draft_id?: string | null } | undefined;
  return {
    deal: { id: deal.id, kind: deal.kind, stage: deal.stage, qualified: deal.qualified },
    run: run?.at ? { at: run.at, by: run.by ?? null, count: run.count ?? 0 } : null,
    matches: rows.filter((row) => row.rank != null && LIVE_STATES.includes(row.state)).map(view),
    markers: rows.filter((row) => row.rank == null && row.state === "proposed").map(view),
    past: rows.filter((row) => row.rank == null && row.state !== "proposed").map(view),
    sellerQuote: deal.kind === "supply" ? await sellerQuote(dealId, now) : null,
    reconfirm: reconfirm?.at ? { at: reconfirm.at, draft_id: reconfirm.draft_id ?? null } : null,
  };
}

/** Live reservations held against one supply listing, for its card: how many, how much, and the last day. */
export async function listingReservations(listingId: string): Promise<{ holds: number; qty: number; whole: number; until: string | null; of: number | null }> {
  const [row] = await queryPg<{ holds: number; qty: number; whole: number; until: string | null; of: number | null }>(
    `select count(*)::int as holds, coalesce(sum(reserved_qty), 0)::float8 as qty, (count(*) filter (where reserved_qty is null))::int as whole,
            max(reserved_until)::text as until, max(candidate_qty)::float8 as of
     from crm_bulk_matches where stock_kind = 'listing' and stock_id = $1 and state = 'offered' and reserved_until >= current_date`, [listingId]);
  return row ?? { holds: 0, qty: 0, whole: 0, until: null, of: null };
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** Where an email to this person goes, or why it must not: no address, opted out, or on the do-not-send list. */
async function recipient(contact: string | null, personId: string | null): Promise<{ email: string; firstName: string | null }> {
  const [person] = personId
    ? await queryPg<{ email: string | null; full_name: string | null; opted_out: boolean }>(
      `select email, full_name, coalesce(email_opted_out, false) as opted_out from crm_people where id = $1`, [personId])
    : [];
  const email = ((contact ?? "").match(EMAIL)?.[0] ?? person?.email ?? "").toLowerCase();
  if (!email) {
    throw new MatchError(409, "There is no email address for this contact yet. Add one in the CRM first.");
  }
  if (person?.opted_out) {
    throw new MatchError(409, "This contact has opted out of email.");
  }
  const [suppressed] = await queryPg<{ reason: string }>(`select reason from mail_suppression where email = lower($1) limit 1`, [email]);
  if (suppressed) {
    throw new MatchError(409, `This address is on the do-not-send list (${suppressed.reason}).`);
  }
  const first = (person?.full_name ?? "").trim().split(/[\s,]+/)[0] || null;
  return { email, firstName: first && !first.includes("@") ? first : null };
}

async function dealFields(dealId: string): Promise<FieldFact[]> {
  return queryPg<FieldFact>(
    `select field_key, value, status, visibility, coalesce(alternatives, '[]'::jsonb) as alternatives
     from crm_bulk_listing_fields where bulk_listing_id = $1`, [dealId]);
}

async function requestFacts(dealId: string): Promise<RequestFacts | null> {
  const [row] = await queryPg<{ product_family: string | null; volume: string | null; volume_unit: string | null; quantity: string | null; needed_by: string | null; spec: Record<string, unknown> | null; max_price: string | null }>(
    `select product_family, volume::text, volume_unit, quantity, needed_by::text as needed_by, spec, max_price::text from crm_bulk_demand where id = $1`, [dealId]);
  if (!row) {
    return null;
  }
  const num = (value: string | null) => (value == null || value === "" ? null : Number(value));
  return { productFamily: row.product_family, volume: num(row.volume), volumeUnit: row.volume_unit, quantity: row.quantity, neededBy: row.needed_by, spec: row.spec ?? {}, maxPrice: num(row.max_price) };
}

async function buyerFacts(companyId: string | null): Promise<BuyerFacts | null> {
  if (!companyId) {
    return null;
  }
  const [row] = await queryPg<{ buyer_profile: Record<string, unknown> | null }>(`select buyer_profile from crm_companies where id = $1`, [companyId]);
  const profile = row?.buyer_profile;
  if (!profile) {
    return null;
  }
  const dossier = profile.dossier && typeof profile.dossier === "object" ? profile.dossier as Record<string, unknown> : null;
  return { wants: typeof profile.wants === "string" ? profile.wants : null, products: dossier?.products ?? null };
}

async function makeDraft(deps: MatchDeps, to: string, kind: OfferEmailKind, input: Omit<Parameters<typeof buildOfferEmail>[0], "kind">) {
  let email;
  try {
    email = buildOfferEmail({ ...input, kind });
  } catch (error) {
    if (error instanceof OfferEmailRefused) {
      throw new MatchError(409, error.message);
    }
    throw error;
  }
  try {
    const draftId = await (deps.draft ?? createOfferEmailDraft)({ to: [to], subject: email.subject, body: email.body });
    return { draftId, kind: email.kind, subject: email.subject, body: email.body };
  } catch (error) {
    if (error instanceof OfferDraftError) {
      throw new MatchError(error.status, error.message);
    }
    throw error;
  }
}

/** Marks a candidate expired when it is no longer available, and says why. Checked before asking and before a yes. */
async function stillAvailable(deal: Deal, row: StoredRow, actor: MatchActor): Promise<void> {
  const ref = { kind: row.candidate_kind, id: row.candidate_id, stockKind: row.stock_kind, stockId: row.stock_id, key: row.candidate_key };
  const status = (await availability(deal.id, [ref])).get(row.candidate_key);
  const blocked = status?.blocked ?? (fullyReserved(status, row.candidate_qty) ? "reserved" : null);
  if (!blocked) {
    return;
  }
  const why = BLOCKED_TEXT[blocked] ?? blocked;
  if (blocked !== "reserved") {
    await asStageActor(actor.userId, async (tx) => {
      await tx.query(`update crm_bulk_matches set state = 'expired', rank = null, note = $3, updated_at = now() where deal_id = $1 and id = $2`,
        [deal.id, row.id, `No longer available: ${why}.`]);
      await activity(tx, deal.id, actor, `No longer available: ${row.name}`, { match: { key: unitKey(row.candidate_key), verdict: "expired", stored_match_id: row.id } });
    });
  }
  throw new MatchError(409, `This candidate is ${why}, so it was not ${blocked === "reserved" ? "confirmed" : "asked"}.`);
}

export type MatchDraft = { draftId: string; kind: OfferEmailKind; subject: string; body: string; reused: boolean };

/**
 * Asks one candidate: marks the match asked and returns a draft for a person to read and send. On a request the supplier
 * is asked to confirm stock, quantity, price and until when; on a supply deal the buyer gets the offer email, and only
 * while the seller's quote is in date.
 */
export async function askMatch(dealId: string, id: string, actor: MatchActor, deps: MatchDeps = {}): Promise<MatchDraft> {
  const deal = await readDeal(dealId);
  const row = deal ? await readRow(dealId, id) : null;
  if (!deal || !row) {
    throw new MatchError(404, "Match not found");
  }
  if (row.state !== "proposed" && row.state !== "asked") {
    throw new MatchError(409, "Only a proposed or asked match can be asked.");
  }
  const open = typeof row.data.open_draft_id === "string" ? row.data.open_draft_id : null;
  if (open && actor.userId) {
    const draft = await readMailDraft(open, actor.userId);
    if (draft && draft.state === "draft") {
      return { draftId: draft.id, kind: deal.kind === "demand" ? "stock_confirm" : "supply_offer", subject: draft.subject ?? "", body: draft.body_text ?? "", reused: true };
    }
  }
  if (deal.kind === "supply" && !(await sellerQuote(dealId, deps.now)).inDate) {
    throw new MatchError(409, "The seller's quote is missing or out of date. Ask the seller to confirm it before any buyer is asked.");
  }
  await stillAvailable(deal, row, actor);
  const to = await recipient(row.contact, row.person_id);
  const fields = await dealFields(dealId);
  const key = buildProductKey({ fields, title: deal.title });
  const holds = typeof row.checks.holds === "string" ? row.checks.holds.split(" · ")[0] : null;
  const draft = deal.kind === "demand"
    ? await makeDraft(deps, to.email, "stock_confirm", {
      key, fields, recipientFirstName: to.firstName, location: deal.location, request: await requestFacts(dealId), side: "demand",
      holds, privateValues: privateValues(deal),
    })
    : await makeDraft(deps, to.email, "supply_offer", {
      key, fields, recipientFirstName: to.firstName, location: deal.location, buyer: await buyerFacts(row.company_id), side: "supply",
      privateValues: privateValues(deal),
    });
  await asStageActor(actor.userId, async (tx) => {
    await tx.query(
      `update crm_bulk_matches set state = 'asked', asked_at = coalesce(asked_at, now()),
         data = data || jsonb_build_object('open_draft_id', $3::text, 'asked_to', $4::text), updated_at = now()
       where deal_id = $1 and id = $2`, [dealId, id, draft.draftId, to.email]);
    await activity(tx, dealId, actor, `Asked ${row.name}: draft ready to send`, { match: { key: unitKey(row.candidate_key), verdict: "asked", stored_match_id: id }, draft_id: draft.draftId });
  });
  return { ...draft, reused: false };
}

export type YesInput = { quantity?: number | null; quote?: { amount: number; currency: string; unit: string } | null; validUntil?: string | null };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Yes: the verdict is stored and the match becomes exactly one counterparty offer at candidate. A second yes, or a yes
 * racing the first, returns the same offer. On a request the supplier's quote must say until when it holds.
 */
export async function matchYes(dealId: string, id: string, input: YesInput, actor: MatchActor, deps: MatchDeps = {}): Promise<StoredMatchView> {
  const deal = await readDeal(dealId);
  const first = deal ? await readRow(dealId, id) : null;
  if (!deal || !first) {
    throw new MatchError(404, "Match not found");
  }
  const day = londonToday(deps.now);
  if (input.validUntil != null && (!DATE.test(input.validUntil) || input.validUntil < day)) {
    throw new MatchError(400, "The quote's last day must be a date from today on.");
  }
  if (input.quantity != null && !(Number.isFinite(input.quantity) && input.quantity > 0)) {
    throw new MatchError(400, "The quantity must be more than zero.");
  }
  if (!first.offer_id) {
    if (first.state !== "proposed" && first.state !== "asked") {
      throw new MatchError(409, "Only a proposed or asked match can be confirmed.");
    }
    if (deal.kind === "demand" && !input.validUntil) {
      throw new MatchError(400, "Say until when the supplier's quote holds.");
    }
    if (deal.kind === "supply" && !(await sellerQuote(dealId, deps.now)).inDate) {
      throw new MatchError(409, "The seller's quote is missing or out of date. Confirm it with the seller first.");
    }
    await stillAvailable(deal, first, actor);
  }
  // One yes at a time per match: the lock is held while the offer is made, so a second click waits and then finds it.
  await asStageActor(actor.userId, async (tx) => {
    await tx.query(`select pg_advisory_xact_lock(hashtext('crm_bulk_matches:yes:' || $1))`, [id]);
    const row = await readRow(dealId, id, tx);
    if (!row || row.offer_id) {
      return;
    }
    let offerId: string;
    try {
      const offer = await addOffer(dealId, {
        name: row.name, contact: row.contact, personId: row.person_id, companyId: row.company_id, stage: "candidate",
        counterpartId: row.candidate_kind === "listing" ? row.candidate_id : null,
        data: {
          match: { stored_match_id: row.id, rank: row.rank, reason: row.reason, at: new Date().toISOString() },
          ...(row.candidate_kind === "stock" ? { stock_opportunity_id: row.candidate_id } : {}),
          ...(Array.isArray(row.checks.stock_ids) ? { stock_opportunity_ids: row.checks.stock_ids } : {}),
          ...(row.candidate_kind === "marketplace" ? { marketplace_listing_id: row.candidate_id } : {}),
        },
      });
      offerId = offer.id;
    } catch (error) {
      if (error instanceof OfferConflict && error.existingOfferId) {
        offerId = error.existingOfferId;
      } else if (error instanceof OfferConflict) {
        throw new MatchError(409, error.message);
      } else {
        throw error;
      }
    }
    const [taken] = (await tx.query<{ id: string }>(`select id from crm_bulk_matches where offer_id = $1 and id <> $2`, [offerId, id])).rows;
    if (taken) {
      throw new MatchError(409, "This counterparty already has an offer on this deal from another match.");
    }
    await tx.query(
      `update crm_bulk_matches set state = 'confirmed', verdict = 'yes', verdict_at = now(), verdict_by = $3, verdict_reason = null,
         confirmed_qty = $4, quote = $5::jsonb, quote_valid_until = $6::date, offer_id = $7,
         data = data - 'open_draft_id', updated_at = now()
       where deal_id = $1 and id = $2`,
      [dealId, id, actor.email ?? "system", input.quantity ?? null, input.quote ? JSON.stringify(input.quote) : null, input.validUntil ?? null, offerId]);
    await activity(tx, dealId, actor, `Yes: ${row.name}`, {
      match: { key: unitKey(row.candidate_key), verdict: "yes", stored_match_id: id, offer_id: offerId, quantity: input.quantity ?? null, valid_until: input.validUntil ?? null },
    });
  });
  const after = await readRow(dealId, id);
  if (after?.offer_id && input.quote && deal.kind === "demand" && after.verdict_at && !first.offer_id) {
    // The supplier's quote goes on the offer as its terms, firm until its last day. Internal: never sent to a seller.
    await updateOffer(dealId, after.offer_id, {
      terms: { amount: input.quote.amount, currency: input.quote.currency, unit: input.quote.unit, firmness: "firm", ...(input.validUntil ? { expires_on: input.validUntil } : {}) },
    }, actor.userId);
  }
  return (await listStoredMatches(dealId, deps.now)).matches.find((row) => row.id === id)
    ?? (() => { throw new MatchError(404, "Match not found"); })();
}

/** No, with the reason required. The match leaves the five and the next best candidate is pulled in to keep five. */
export async function matchNo(dealId: string, id: string, reason: string, actor: MatchActor, deps: MatchDeps = {}): Promise<StoredMatches> {
  const why = reason.trim();
  if (!why) {
    throw new MatchError(400, "Say briefly why it is a no.");
  }
  if (why.length > NO_REASON_MAX) {
    throw new MatchError(400, `Keep the reason under ${NO_REASON_MAX} characters.`);
  }
  const row = await readRow(dealId, id);
  if (!row) {
    throw new MatchError(404, "Match not found");
  }
  if (row.state !== "proposed" && row.state !== "asked") {
    throw new MatchError(409, row.offer_id ? "This match is already an offer: decline it in Offers." : "Only a proposed or asked match can be a no.");
  }
  await asStageActor(actor.userId, async (tx) => {
    await tx.query(
      `update crm_bulk_matches set state = 'declined', rank = null, verdict = 'no', verdict_reason = $3, verdict_at = now(), verdict_by = $4,
         data = data - 'open_draft_id', updated_at = now()
       where deal_id = $1 and id = $2`, [dealId, id, why, actor.email ?? "system"]);
    // The same Not a fit the live list reads, so the candidate stays out of "All candidates" too.
    await activity(tx, dealId, actor, `Not a fit: ${row.name}`, { match: { key: unitKey(row.candidate_key), verdict: "not_a_fit", reason: why, stored_match_id: id } });
  });
  await refill(dealId, actor, deps);
  return listStoredMatches(dealId, deps.now);
}

/** Keeps five after a no: the live rows close up, and the scorer's next best come in with plain reasons. */
async function refill(dealId: string, actor: MatchActor, deps: MatchDeps): Promise<void> {
  const deal = await readDeal(dealId);
  if (!deal) {
    return;
  }
  const existing = await readRows(dealId);
  const live = existing.filter((row) => row.rank != null && LIVE_STATES.includes(row.state)).sort((a, b) => (a.rank ?? 9) - (b.rank ?? 9));
  const scored = live.length < TOP ? await (deps.scorer ?? scoreDeal)(deal) : null;
  const { picks } = scored ? await pickFive(deal, scored, existing.filter((row) => row.state !== "proposed" || row.rank == null)) : { picks: [] as Pick[] };
  const liveKeys = new Set(live.map((row) => `${row.candidate_kind}:${row.candidate_id}`));
  const incoming = picks.filter((pick) => !pick.held && !liveKeys.has(`${pick.ref.kind}:${pick.ref.id}`)).slice(0, TOP - live.length);
  const forbidden = scored ? forbiddenNames(deal, picks.map((pick) => pick.row)) : [];
  await asStageActor(actor.userId, async (tx) => {
    for (const [index, row] of live.entries()) {
      await tx.query(`update crm_bulk_matches set rank = $2 where id = $1 and rank is distinct from $2`, [row.id, index + 1]);
    }
    for (const [index, pick] of incoming.entries()) {
      await upsert(tx, deal, pick, {
        rank: live.length + index + 1, reason: ruleReason(pick.row, forbidden),
        scoredBy: { scorer: SCORER_VERSION, at: new Date().toISOString(), model: null, fallback: "pulled in after a no" },
      });
    }
  });
}

/** Moves the reservation's last day on: five working days from today, never past the quote it rests on. */
export async function extendReservation(dealId: string, id: string, actor: MatchActor, deps: MatchDeps = {}): Promise<StoredMatchView> {
  const row = await readRow(dealId, id);
  if (!row) {
    throw new MatchError(404, "Match not found");
  }
  if (row.state !== "offered") {
    throw new MatchError(409, "Only an offered match holds a reservation.");
  }
  const day = londonToday(deps.now);
  const quoteUntil = row.quote_valid_until
    ?? (await queryPg<{ until: string | null }>(`select bulk_listing_quote_until(id)::text as until from crm_bulk_listings where id = $1 and kind = 'supply'`, [dealId]))[0]?.until
    ?? null;
  if (quoteUntil && quoteUntil < day) {
    throw new MatchError(409, `The quote ran out on ${quoteUntil}. Get it confirmed again before extending.`);
  }
  const from = row.reserved_until && row.reserved_until > day ? row.reserved_until : day;
  const until = reservationUntil(from, quoteUntil);
  const qty = row.reserved_qty ?? row.confirmed_qty;
  await writeReservation(dealId, row, actor, { qty, until }, `Reservation extended to ${until}: ${row.name}`);
  return (await listStoredMatches(dealId, deps.now)).matches.find((match) => match.id === id) ?? (() => { throw new MatchError(404, "Match not found"); })();
}

/** Ends a reservation now. The match stays offered; the stock is free for other deals at once. */
export async function releaseReservation(dealId: string, id: string, actor: MatchActor, deps: MatchDeps = {}): Promise<StoredMatches> {
  const row = await readRow(dealId, id);
  if (!row) {
    throw new MatchError(404, "Match not found");
  }
  if (row.state !== "offered" || !row.reserved_until) {
    throw new MatchError(409, "This match holds no reservation.");
  }
  await writeReservation(dealId, row, actor, { qty: null, until: null }, `Reservation released: ${row.name}`);
  return listStoredMatches(dealId, deps.now);
}

/** Sets or clears a reservation. The quantity rule lives in the database trigger; its refusal becomes a 409. */
async function writeReservation(dealId: string, row: StoredRow, actor: MatchActor, value: { qty: number | null; until: string | null }, title: string) {
  try {
    await asStageActor(actor.userId, async (tx) => {
      await tx.query(`update crm_bulk_matches set reserved_qty = $3, reserved_until = $4::date, updated_at = now() where deal_id = $1 and id = $2`,
        [dealId, row.id, value.qty, value.until]);
      await activity(tx, dealId, actor, title, { match: { key: unitKey(row.candidate_key), verdict: value.until ? "reserved" : "released", stored_match_id: row.id, quantity: value.qty, until: value.until } });
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23P01") {
      throw new MatchError(409, (error as Error).message);
    }
    throw error;
  }
}

/** One more chase sent on an asked match (at most three). The chase drafts themselves come in the next slice. */
export async function recordMatchChase(dealId: string, id: string): Promise<number | null> {
  const [row] = await queryPg<{ chases: number }>(
    `update crm_bulk_matches set chases = chases + 1, updated_at = now() where deal_id = $1 and id = $2 and state = 'asked' and chases < 3 returning chases`, [dealId, id]);
  return row?.chases ?? null;
}

/** Tidies lapsed reservations into expired. Reads already treat them as free; the daily job calls this with bulk_stage_check_all(). */
export async function expireMatches(): Promise<number> {
  const [row] = await queryPg<{ n: number }>(`select bulk_matches_expire() as n`);
  return row?.n ?? 0;
}

/**
 * A supply deal whose seller quote is missing or out of date: a draft to the seller asking them to confirm stock, price
 * and until when. Buyers stay blocked until the quote is recorded back.
 */
export async function sellerReconfirm(dealId: string, actor: MatchActor, deps: MatchDeps = {}): Promise<MatchDraft> {
  const deal = await readDeal(dealId);
  if (!deal) {
    throw new MatchError(404, "Listing not found");
  }
  if (deal.kind !== "supply") {
    throw new MatchError(400, "Only a supply deal has a seller quote to confirm.");
  }
  const to = await recipient(deal.email ?? deal.contact, deal.person_id);
  const fields = await dealFields(dealId);
  const draft = await makeDraft(deps, to.email, "seller_reconfirm", {
    key: buildProductKey({ fields, title: deal.title }), fields, recipientFirstName: to.firstName, side: "supply", privateValues: [],
  });
  await asStageActor(actor.userId, async (tx) => {
    await tx.query(`update crm_bulk_listings set context = context || jsonb_build_object('match_reconfirm', $2::jsonb) where id = $1`,
      [dealId, JSON.stringify({ at: (deps.now ?? new Date()).toISOString(), draft_id: draft.draftId, by: actor.email })]);
    await activity(tx, dealId, actor, "Seller quote re-confirm: draft ready to send", { match_reconfirm: { draft_id: draft.draftId } });
  });
  return { ...draft, reused: false };
}

/** The seller confirmed their price and until when it holds: buyers may now be asked on this supply deal. */
export async function recordSellerQuote(dealId: string, validUntil: string, actor: MatchActor, deps: MatchDeps = {}): Promise<SellerQuote> {
  if (!DATE.test(validUntil) || validUntil < londonToday(deps.now)) {
    throw new MatchError(400, "The quote's last day must be a date from today on.");
  }
  const quote = await sellerQuote(dealId, deps.now);
  if (!quote.value?.trim()) {
    throw new MatchError(409, "Add the seller's price to the listing first.");
  }
  await asStageActor(actor.userId, async (tx) => {
    await tx.query(`update crm_bulk_listing_fields set status = 'confirmed', updated_at = now() where bulk_listing_id = $1 and field_key = 'seller_price' and status <> 'confirmed'`, [dealId]);
    await tx.query(
      `update crm_bulk_listings set spec = spec || jsonb_build_object('seller_quote_valid_until', $2::text, 'seller_quote_confirmed_at', now()::text),
         context = context - 'match_reconfirm', updated_at = now()
       where id = $1 and kind = 'supply'`, [dealId, validUntil]);
    await activity(tx, dealId, actor, `Seller quote confirmed until ${validUntil}`, { seller_quote: { valid_until: validUntil, price: quote.value } });
  });
  return sellerQuote(dealId, deps.now);
}

/**
 * Standing requests: new supply listings and stock lines added since the last run or check that the scorer fits become
 * "new supply may fit" markers (proposed, out of the five, with a note). Nothing more happens until a person acts.
 */
export async function markNewSupply(dealId: string, actor: MatchActor, deps: MatchDeps = {}): Promise<number> {
  const deal = await readDeal(dealId);
  const run = deal?.context.match_run as { at?: string; checked_at?: string } | undefined;
  if (!deal || deal.kind !== "demand" || deal.spec.intent !== "standing" || deal.status === "closed" || !run?.at) {
    return 0;
  }
  const since = run.checked_at ?? run.at;
  const [news] = await queryPg<{ any: boolean }>(
    `select exists (select 1 from crm_bulk_listings where kind = 'supply' and status <> 'closed' and created_at > $1::timestamptz)
         or exists (select 1 from crm_stock_opportunities where created_at > $1::timestamptz) as any`, [since]);
  if (!news?.any) {
    return 0;
  }
  const checkedAt = (deps.now ?? new Date()).toISOString();
  const scored = await (deps.scorer ?? scoreDeal)(deal);
  const fresh = (scored?.rows ?? []).map((row, index) => ({ row, index, ref: candidateRef(row.key, deal) }))
    .filter((item): item is { row: MatchRow; index: number; ref: CandidateRef } => !!item.ref && item.ref.kind !== "company");
  const ids = fresh.map((item) => item.ref.id);
  const created = new Set((await queryPg<{ kind: string; id: string }>(
    `select 'listing' as kind, id from crm_bulk_listings where id = any($1::text[]) and created_at > $2::timestamptz
     union all select 'stock', id from crm_stock_opportunities where id = any($1::text[]) and created_at > $2::timestamptz
     union all select 'marketplace', marketplace_listing_id from crm_stock_opportunities where marketplace_listing_id = any($1::text[]) and created_at > $2::timestamptz`,
    [ids, since])).map((row) => `${row.kind}:${row.id}`));
  const existing = new Set((await readRows(dealId)).map((row) => `${row.candidate_kind}:${row.candidate_id}`));
  const marks = fresh.filter((item) => created.has(`${item.ref.kind}:${item.ref.id}`) && !existing.has(`${item.ref.kind}:${item.ref.id}`));
  if (marks.length) {
    await asStageActor(actor.userId, async (tx) => {
      for (const item of marks) {
        await upsert(tx, deal, { ref: item.ref, row: item.row, scorerRank: item.index + 1, held: null, qty: item.row.units ?? null }, {
          rank: null, reason: ruleReason(item.row, forbiddenNames(deal, [item.row])), note: "New supply may fit",
          scoredBy: { scorer: SCORER_VERSION, at: checkedAt, model: null, fallback: "new supply marker" },
        });
      }
    });
  }
  await queryPg(`update crm_bulk_listings set context = jsonb_set(context, '{match_run,checked_at}', to_jsonb($2::text)) where id = $1`, [dealId, checkedAt]);
  return marks.length;
}
