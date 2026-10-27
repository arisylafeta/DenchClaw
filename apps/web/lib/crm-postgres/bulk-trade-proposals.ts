import { randomUUID } from "node:crypto";
import { queryPg, withPgTransaction, type PgTransaction } from "../postgres";
import type { AppliedChange, CheckStatus, FileType, HistoryStatus, Proposal } from "../bulk-trade-details";
import { startHistoryPass } from "../history-pass";
import { FILE_TYPES } from "../bulk-trade-details";
import { fetchGmailAttachment } from "../gmail-drafts";
import { addOffer, type OfferStage } from "./bulk-offers";
import { addDocument } from "./bulk-documents";
import { acceptDemand, reverseDemand } from "./demand-proposal";

const PROPOSAL_SELECT = `
  select id::text as id, lot_id, kind, target, proposed, summary, quote, source_kind, source_url, source_label,
    source_at, created_at
  from crm_bulk_trade_proposals`;

/** Open proposals for one trade, including threads flagged because they touch it and others. */
export async function tradeProposals(lotId: string): Promise<Proposal[]> {
  return queryPg<Proposal>(
    `${PROPOSAL_SELECT}
     where status = 'new' and (lot_id = $1 or (kind = 'needs_triage' and proposed->'lot_ids' ? $1))
     order by created_at, id`,
    [lotId],
  );
}

/** What the inbox check applied to one trade, newest first. */
export async function appliedChanges(lotId: string): Promise<AppliedChange[]> {
  return queryPg<AppliedChange>(
    `select id::text as id, lot_id, kind, target, proposed, summary, quote, source_kind, source_url, source_label,
       source_at, created_at, run_id::text as run_id, applied_at, coalesce((undo->>'conflict')::boolean, false) as conflict
     from crm_bulk_trade_proposals where lot_id = $1 and status = 'applied'
     order by applied_at desc, id desc limit 100`,
    [lotId],
  );
}

/** Open "possible new trade" proposals, newest first. */
export async function possibleTrades(): Promise<Proposal[]> {
  return queryPg<Proposal>(`${PROPOSAL_SELECT} where status = 'new' and kind = 'possible_trade' order by created_at desc limit 20`);
}

export async function checkStatus(): Promise<CheckStatus> {
  const [row] = await queryPg<{ last_run_at: string; status: "running" | "ok" | "failed"; error: string | null }>(
    `select coalesce(finished_at, started_at) as last_run_at, status, error
     from crm_bulk_trade_check_runs where kind = 'check' order by started_at desc limit 1`,
  );
  return row ?? null;
}

export async function historyStatus(lotId: string): Promise<HistoryStatus> {
  const [row] = await queryPg<NonNullable<HistoryStatus>>(
    `select status, started_at, finished_at, emails_read, notes_read, proposals_made
     from crm_bulk_trade_check_runs where kind = 'history' and lot_id = $1 order by started_at desc limit 1`,
    [lotId],
  );
  return row ?? null;
}

/**
 * Starts a history pass unless one for this trade started in the last 30 minutes and is still
 * running. Returns false when one is already underway.
 */
export async function requestHistoryPass(lotId: string): Promise<boolean> {
  const [running] = await queryPg(
    `select 1 from crm_bulk_trade_check_runs
     where kind = 'history' and lot_id = $1 and status = 'running' and started_at > now() - interval '30 minutes'`,
    [lotId],
  );
  if (running) return false;
  return startHistoryPass(lotId);
}

export type Decision = { ok: true; lot_id: string | null } | { ok: false; status: number; error: string };

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
const date = (value: unknown) => (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null);


/**
 * Accepts or ignores a proposal. Accepting applies it through the same functions the app uses for
 * a manual edit, so it is validated and logged like one. The proposal is claimed first, so two
 * clicks never apply it twice; if applying fails, it goes back to "new".
 */
export async function decideProposal(
  id: string,
  action: "accept" | "ignore",
  user: { id: string; email: string },
): Promise<Decision> {
  // Demand claims, source validation, business writes and undo snapshots are one transaction.
  if (action === "accept") {
    try {
      const demand = await withPgTransaction(async (client) => {
        const { rows } = await client.query(`select *,to_char(source_at,'YYYY-MM-DD') as source_date
          from crm_bulk_trade_proposals where id=$1 and status='new' and kind='possible_demand' for update`, [id]);
        if (!rows[0]) return null;
        await acceptDemand(client, rows[0], user.id);
        await client.query("update crm_bulk_trade_proposals set decided_at=now(),decided_by=$2 where id=$1", [id,user.id]);
        return { lot_id: rows[0].lot_id as string | null };
      });
      if (demand) return { ok:true, lot_id:demand.lot_id };
    } catch (err) {
      return { ok:false, status:422, error:err instanceof Error ? err.message : "Could not apply demand." };
    }
  }
  const claimed = await withPgTransaction(async (client) => {
    const { rows } = await client.query(
      `update crm_bulk_trade_proposals set status = $2, decided_at = now(), decided_by = $3
       where id = $1 and status = 'new'
       returning id::text as id, lot_id, kind, target, proposed, summary, quote, source_kind, source_url,
         source_label, source_thread, to_char(source_at, 'YYYY-MM-DD') as source_date`,
      [id, action === "accept" ? "accepted" : "ignored", user.id],
    );
    const proposal = rows[0] as (Proposal & { source_date: string | null }) | undefined;
    if (proposal?.lot_id) {
      await logListingActivity(client, proposal.lot_id, action === "accept" ? "Proposal accepted" : "Proposal ignored",
        { proposal_id: proposal.id, kind: proposal.kind, summary: proposal.summary }, user.id);
    }
    return proposal ?? null;
  });
  if (!claimed) return { ok: false, status: 404, error: "Already handled or not found." };
  if (action === "ignore") return { ok: true, lot_id: claimed.lot_id };

  try {
    const lotId = await apply(claimed, user);
    return { ok: true, lot_id: lotId };
  } catch (err) {
    await queryPg(
      "update crm_bulk_trade_proposals set status = 'new', decided_at = null, decided_by = null where id = $1",
      [id],
    );
    return { ok: false, status: 422, error: err instanceof Error ? err.message : "Could not apply this proposal." };
  }
}

async function apply(p: Proposal & { source_date: string | null }, user: { id: string; email: string }): Promise<string | null> {
  const proposed = p.proposed;
  const lotId = p.lot_id;
  switch (p.kind) {
    // Bulk Trades lots are frozen (migration 077): every change below lands on the Trades Preview listing,
    // which has the same id as the lot, and is logged in its Story.
    case "field": {
      const key = text(p.target);
      if (!key) throw new Error("The proposed fact has no field.");
      await setListingField(lotId!, key, {
        value: text(proposed.value), status: proposed.status === "confirmed" ? "confirmed" : "unverified",
        source_label: p.source_label, source_url: p.source_url, source_date: p.source_date,
      }, user.id);
      return lotId;
    }
    case "buyer_update": {
      const status = text(proposed.status);
      const stage = status ? buyerStage(status) : null;
      const updated = await queryPg(
        `update crm_bulk_offers set
           stage = coalesce($3, stage),
           declined_reason = case when $3 = 'declined' then $4 else declined_reason end,
           last_touch_on = coalesce($5::date, last_touch_on), last_touch_via = coalesce($6, last_touch_via),
           data = case when $7::date is null then data else data || jsonb_build_object('next_due', $7::text) end,
           updated_at = now()
         where id = $2 and bulk_listing_id = $1
         returning name`,
        [lotId, p.target, stage, status?.startsWith("Declined: ") ? status.slice(10) : null,
          date(proposed.last_touch_on), text(proposed.last_touch_via), date(proposed.chase_on)]);
      if (!updated.length) throw new Error("That buyer is no longer on this trade.");
      await queryPg(
        `insert into crm_bulk_listing_activity (bulk_listing_id, offer_id, kind, title, data, actor_user_id) values ($1, $2, 'status', $3, $4::jsonb, $5)`,
        [lotId, p.target, `${(updated[0] as { name: string | null }).name ?? "Buyer"} · ${p.summary}`.slice(0, 300),
          JSON.stringify({ proposal_id: p.id, kind: p.kind, proposed }), user.id]);
      return lotId;
    }
    case "next_step": {
      const rows = await queryPg(
        `update crm_bulk_listings set next_action = $2, next_due = $3::date,
           waiting_on = $4, waiting_since = case when $4 = 'them' then coalesce(waiting_since, now()) else null end,
           updated_at = now()
         where id = $1 returning id`,
        [lotId, text(proposed.next_step), date(proposed.next_step_due), proposed.waiting_on === "them" ? "them" : "us"]);
      if (!rows.length) throw new Error("This trade is no longer in Trades Preview.");
      return lotId;
    }
    case "new_buyer": {
      const name = text(proposed.name);
      if (!name) throw new Error("The proposed buyer has no name.");
      await addOffer(lotId!, { name, contact: text(proposed.contact), wants: text(proposed.wants) });
      return lotId;
    }
    case "file": {
      const fileName = text(proposed.file_name);
      const messageId = text(proposed.gmail_message_id);
      if (!fileName || !messageId) throw new Error("The attachment reference is incomplete.");
      const content = await fetchGmailAttachment(user.email, messageId, fileName, text(proposed.attachment_id));
      const fileType = (FILE_TYPES as readonly string[]).includes(String(proposed.file_type)) ? String(proposed.file_type) : "Other";
      const doc = await addDocument(lotId!, { title: fileName, doc_type: fileType, visibility: "never",
        source_label: p.source_label, source_date: p.source_date }, { name: fileName, type: null, content }, user.id);
      if (!doc) throw new Error("This trade is no longer in Trades Preview.");
      return lotId;
    }
    case "possible_trade": {
      // Becomes an open supply listing in Trades Preview; the sender is its contact.
      const title = text(proposed.title);
      if (!title) throw new Error("The proposed trade has no title.");
      const sender = text(proposed.email) ?? p.source_label.match(/[^\s·]+@[^\s·]+/)?.[0] ?? null;
      const external = sender && !sender.endsWith("@rebattery.io") ? sender.toLowerCase() : null;
      return createSupplyListing(p, title, external, user.id);
    }
    case "link_contact": {
      const email = text(proposed.email)?.toLowerCase();
      if (!email) throw new Error("The proposed contact has no email.");
      await queryPg(
        `insert into crm_bulk_offers (id, bulk_listing_id, role, person_id, company_id, name, contact)
         select $1, $2, 'contact', p.id, p.company_id, $3, $4
         from (select 1) one left join lateral (select id, company_id from crm_people where lower(email) = $4 order by id limit 1) p on true
         where not exists (select 1 from crm_bulk_offers o where o.bulk_listing_id = $2 and o.role = 'contact' and lower(o.contact) = $4)`,
        [`btc_${randomUUID()}`, lotId, text(proposed.name) ?? email, email]);
      await requestHistoryPass(lotId!); // read this person's past emails for the trade
      return lotId;
    }
    case "trade_kind": {
      const kind = String(proposed.trade_kind);
      if (!["packs", "cells", "systems", "recycling"].includes(kind)) throw new Error("Unknown trade kind.");
      await queryPg(
        `update crm_bulk_listings set
           spec = case when $2 = 'recycling' then spec else spec || jsonb_build_object('trade_kind', $2) end,
           context = case when $2 = 'recycling' then context || '{"recycling": true}'::jsonb else context end,
           updated_at = now()
         where id = $1`, [lotId, kind]);
      return lotId;
    }
    case "needs_triage":
      return lotId; // Acknowledged; Alex handles the thread by hand.
    case "possible_demand":
      throw new Error("Demand must be accepted in its source-validation transaction.");
    case "bid":
      throw new Error("Bids from email are added automatically.");
    case "possible_supply":
      throw new Error("Supply batches from email are added automatically.");
    case "link_auction": {
      const linked = await queryPg(
        `update crm_bulk_listings set auction_id = $2, auction_slug = $3, auction_closes_at = $4, auction_status = 'published',
           marketplace_listing_id = coalesce(marketplace_listing_id, $5), updated_at = now()
         where id = $1 and auction_id is null
           and not exists (select 1 from crm_bulk_listings other where other.auction_id = $2)
         returning id`,
        [lotId, text(proposed.auction_id), text(proposed.slug), text(proposed.closes_at), text(proposed.listing_id)],
      );
      if (!linked.length) throw new Error("That auction or this trade is already linked.");
      return lotId;
    }
  }
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

class Changed extends Error {}

type Undo = {
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | string | null;
  value?: string;
  id?: string;
  conflict?: boolean;
  demand_id?: string;
};

type AppliedRow = Proposal & { undo: Undo | null };

const same = (a: unknown, b: unknown) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

/**
 * Reverses one change the inbox check applied, as the signed-in user. It refuses when the thing
 * has been changed since, so an undo never throws away later work.
 */
export async function undoChange(id: string, userId: string): Promise<Decision> {
  try {
    const lotId = await withPgTransaction(async (client) => {
      const { rows } = await client.query(
        `select id::text as id, lot_id, kind, target, proposed, summary, undo from crm_bulk_trade_proposals
         where id = $1 and status = 'applied' for update`,
        [id],
      );
      const change = rows[0] as AppliedRow | undefined;
      if (!change?.undo || (!change.lot_id && change.kind !== "possible_demand")) return undefined;
      if (change.kind === "possible_demand") {
        try { await reverseDemand(client, change.undo); }
        catch (err) { throw new Changed(err instanceof Error ? err.message : "Demand undo refused."); }
      } else {
        await reverse(client, change.lot_id!, change, change.undo);
      }
      await client.query(
        "update crm_bulk_trade_proposals set status = 'undone', decided_at = now(), decided_by = $2 where id = $1",
        [id, userId],
      );
      if (change.lot_id) await logListingActivity(client, change.lot_id, "Inbox change undone",
        { proposal_id: change.id, kind: change.kind, summary: change.summary }, userId);
      return change.lot_id;
    });
    return lotId !== undefined ? { ok: true, lot_id: lotId } : { ok: false, status: 404, error: "Already undone or not found." };
  } catch (err) {
    if (err instanceof Changed) return { ok: false, status: 409, error: err.message };
    throw err;
  }
}

/** Undoes every change from one run on one trade. Returns how many were undone and what was refused. */
export async function undoRun(lotId: string, runId: string, userId: string) {
  const rows = await queryPg<{ id: string; summary: string }>(
    `select id::text as id, summary from crm_bulk_trade_proposals
     where lot_id = $1 and run_id = $2 and status = 'applied' order by id desc`,
    [lotId, runId],
  );
  let undone = 0;
  const refused: { summary: string; error: string }[] = [];
  for (const row of rows) {
    const result = await undoChange(row.id, userId);
    if (result.ok) undone += 1;
    else refused.push({ summary: row.summary, error: result.error });
  }
  return { undone, refused };
}

async function reverse(client: PgTransaction, lotId: string, change: AppliedRow, undo: Undo) {
  const one = async (sql: string, values: unknown[]) => (await client.query(sql, values)).rows[0] as Record<string, unknown> | undefined;
  switch (change.kind) {
    case "field": {
      const key = change.target!;
      const value = change.proposed.value;
      const current = await one(
        "select value, status, alternatives from crm_bulk_trade_fields where lot_id = $1 and field_key = $2 for update",
        [lotId, key],
      );
      if (!current) throw new Changed("That detail has been removed since.");
      if (undo.conflict) {
        const alternatives = (current.alternatives as { value: unknown }[]).filter((claim) => !same(claim.value, value));
        const status = alternatives.length || current.status !== "conflict" ? current.status : (undo.before?.status ?? "unverified");
        await client.query(
          "update crm_bulk_trade_fields set alternatives = $3, status = $4, updated_at = now() where lot_id = $1 and field_key = $2",
          [lotId, key, JSON.stringify(alternatives), status],
        );
        break;
      }
      if (!same(current.value, value)) throw new Changed("That detail has been changed since; edit it by hand.");
      if (!undo.before) {
        await client.query("delete from crm_bulk_trade_fields where lot_id = $1 and field_key = $2", [lotId, key]);
      } else {
        const b = undo.before;
        await client.query(
          `update crm_bulk_trade_fields set value = $3, status = $4, source_label = $5, source_url = $6, source_date = $7,
             updated_at = now() where lot_id = $1 and field_key = $2`,
          [lotId, key, b.value, b.status, b.source_label, b.source_url, b.source_date],
        );
      }
      break;
    }
    case "next_step": {
      const after = undo.after as Record<string, unknown>;
      const current = await one("select next_step from crm_bulk_trade_lots where id = $1 for update", [lotId]);
      if (!same(current?.next_step, after.next_step)) throw new Changed("The next step has been changed since.");
      const b = undo.before!;
      await client.query(
        `update crm_bulk_trade_lots set next_step = $2, next_step_due = $3, waiting_on = $4, waiting_since = $5,
           next_step_contact_id = $6, next_step_buyer_id = $7, updated_at = now() where id = $1`,
        [lotId, b.next_step, b.next_step_due, b.waiting_on, b.waiting_since, b.next_step_contact_id, b.next_step_buyer_id],
      );
      break;
    }
    case "trade_kind": {
      const current = await one("select trade_kind from crm_bulk_trade_lots where id = $1 for update", [lotId]);
      if (current?.trade_kind !== undo.after) throw new Changed("The trade kind has been changed since.");
      await client.query("update crm_bulk_trade_lots set trade_kind = null, updated_at = now() where id = $1", [lotId]);
      break;
    }
    case "link_contact":
      await client.query("delete from crm_bulk_trade_contacts where id = $1 and lot_id = $2", [undo.id, lotId]);
      break;
    case "new_buyer": {
      const used = await one(
        `select exists (select 1 from crm_bulk_trade_bids where buyer_id = $1)
           or exists (select 1 from crm_bulk_trade_links where buyer_id = $1) as used`,
        [undo.id],
      );
      if (used?.used) throw new Changed("That buyer has bids or emails now; remove them by hand.");
      await client.query("update crm_bulk_trade_lots set next_step_buyer_id = null where id = $1 and next_step_buyer_id = $2", [lotId, undo.id]);
      await client.query("delete from crm_bulk_trade_buyers where id = $1 and lot_id = $2", [undo.id, lotId]);
      break;
    }
    case "buyer_update": {
      const after = undo.after as Record<string, unknown>;
      const keys = Object.keys(after).filter((key) => ["last_touch_on", "last_touch_via", "chase_on"].includes(key));
      const current = await one(
        `select to_char(last_touch_on, 'YYYY-MM-DD') as last_touch_on, last_touch_via, to_char(chase_on, 'YYYY-MM-DD') as chase_on
         from crm_bulk_trade_buyers where id = $1 and lot_id = $2 for update`,
        [change.target, lotId],
      );
      if (!current || keys.some((key) => current[key] !== after[key])) throw new Changed("That buyer has been updated since.");
      await client.query(
        `update crm_bulk_trade_buyers set ${keys.map((key, i) => `${key} = $${i + 3}`).join(", ")}, updated_at = now()
         where id = $1 and lot_id = $2`,
        [change.target, lotId, ...keys.map((key) => undo.before?.[key] ?? null)],
      );
      break;
    }
    case "bid":
      await client.query("delete from crm_bulk_trade_bids where id = $1 and lot_id = $2", [undo.id, lotId]);
      break;
    case "file":
      await client.query("delete from crm_bulk_trade_files where id = $1 and lot_id = $2", [undo.id, lotId]);
      break;
    default:
      throw new Changed("This change cannot be undone.");
  }
}

// ---------------------------------------------------------------------------
// Trades Preview writes (bulk listing tables)
// ---------------------------------------------------------------------------

/** A hidden status row on the listing's History; skipped when the id is not a listing. */
async function logListingActivity(client: PgTransaction, listingId: string, title: string, data: Record<string, unknown>, userId: string) {
  await client.query(
    `insert into crm_bulk_listing_activity (bulk_listing_id, kind, title, body, data, actor_user_id)
     select id, 'status', $2, $3, $4, $5 from crm_bulk_listings where id = $1`,
    [listingId, `${title}: ${String(data.summary ?? data.kind ?? "").slice(0, 200)}`.slice(0, 300), null, JSON.stringify(data), userId],
  );
}

/** Stock rows of the same seller (company or person) whose model or part number the new supply's title names.
 *  The same stock must not be a supply listing and a stock row at once (count the deal or its items, never both). */
export async function duplicateStockFor(
  client: Pick<PgTransaction, "query">, companyId: string | null, personId: string | null, title: string,
): Promise<{ id: string; title: string }[]> {
  if (!companyId && !personId) return [];
  const { rows } = await client.query(
    `select s.id, s.title from crm_stock_opportunities s
     where (($1::text is not null and s.company_id = $1) or ($2::text is not null and s.person_id = $2))
       and length(regexp_replace(lower(coalesce(nullif(s.details->'marketplace'->>'model', ''), nullif(s.details->>'part_number', ''), '')), '[^a-z0-9]', '', 'g')) >= 5
       and regexp_replace(lower($3), '[^a-z0-9]', '', 'g')
           like '%' || regexp_replace(lower(coalesce(nullif(s.details->'marketplace'->>'model', ''), s.details->>'part_number')), '[^a-z0-9]', '', 'g') || '%'
     limit 5`,
    [companyId, personId, title],
  );
  return rows as { id: string; title: string }[];
}

/** An accepted "possible trade" as an open supply listing, its sender as the contact offer, and a Story entry. */
async function createSupplyListing(p: Proposal & { source_date: string | null }, title: string, email: string | null, userId: string): Promise<string> {
  return withPgTransaction(async (client) => {
    const id = `bt_${randomUUID()}`;
    const kind = String(p.proposed.trade_kind);
    const spec = ["packs", "cells", "systems"].includes(kind) ? { trade_kind: kind } : {};
    const { rows: [person] } = email
      ? await client.query(`select id, company_id, coalesce(nullif(full_name, ''), email) as name from crm_people
          where lower(email) = $1 order by id limit 1`, [email])
      : { rows: [] as { id: string; company_id: string | null; name: string }[] };
    const dupes = await duplicateStockFor(client, person?.company_id ?? null, person?.id ?? null, title);
    await client.query(
      `insert into crm_bulk_listings (id, kind, party, company_id, person_id, email, summary, status, source_kind, source_id, source_thread,
         source_label, source_url, source_quote, observed_on, spec, context, next_action)
       values ($1, 'supply', $2, $3, $4, $5, $6, 'open', 'email', $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [id, person?.name ?? email ?? "Unknown seller", person?.company_id ?? null, person?.id ?? null, email, title, `proposal:${p.id}`,
        (p as Proposal & { source_thread?: string | null }).source_thread ?? null, p.source_label, p.source_url, p.quote || null,
        p.source_date, JSON.stringify(spec),
        JSON.stringify({ listing_title: title, proposal_id: p.id, ...(dupes.length ? { possible_duplicate_of_stock: dupes.map((d) => d.id) } : {}) }),
        dupes.length ? `Possible duplicate of stock row ${dupes[0].id} (${dupes[0].title}): link it or close this as duplicate` : "Qualify this lead"],
    );
    if (email) {
      await client.query(
        `insert into crm_bulk_offers (id, bulk_listing_id, role, person_id, company_id, name, contact, data)
         values ($1, $2, 'contact', $3, $4, $5, $6, '{"source": "inbox proposal"}')`,
        [`btc_${randomUUID()}`, id, person?.id ?? null, person?.company_id ?? null, person?.name ?? email, email],
      );
    }
    await client.query(
      `insert into crm_bulk_listing_activity (bulk_listing_id, kind, title, body, ref_kind, ref_id, data, actor_user_id, occurred_at)
       values ($1, 'mail', $2, $3, 'email', $4, $5, $6, coalesce($7::timestamptz, now()))`,
      [id, `Lead from inbox: ${title}`.slice(0, 300), p.summary, p.source_url, JSON.stringify({ proposal_id: p.id, source: p.source_label }),
        userId, p.source_date],
    );
    return id;
  });
}


const BUYER_STAGE: Record<string, OfferStage> = {
  "To contact": "candidate", "Teaser sent": "offered", "No reply": "offered", "NDA, specs sent": "offered",
  "Bid in": "offered", "LOI or deposit": "contract_out", "Won": "signed",
};

/** The Trades Preview offer stage for an old Bulk Trades buyer status ("Declined: price" is declined). */
export function buyerStage(status: string): OfferStage | null {
  return BUYER_STAGE[status] ?? (status.startsWith("Declined") ? "declined" : null);
}

/** Writes one fact on a listing; a different earlier value is kept in alternatives. */
async function setListingField(listingId: string, key: string,
  input: { value: string | null; status: "confirmed" | "unverified"; source_label: string | null; source_url: string | null; source_date: string | null },
  userId: string): Promise<void> {
  await withPgTransaction(async (client) => {
    const { rows } = await client.query("select id from crm_bulk_listings where id = $1 for update", [listingId]);
    if (!rows.length) throw new Error("This trade is no longer in Trades Preview.");
    const before = (await client.query("select value from crm_bulk_listing_fields where bulk_listing_id = $1 and field_key = $2", [listingId, key])).rows[0] as { value: string | null } | undefined;
    await client.query(
      `insert into crm_bulk_listing_fields (bulk_listing_id, field_key, value, status, visibility, source_label, source_url, source_date)
       values ($1, $2, $3, $4, 'never', $5, $6, $7::date)
       on conflict (bulk_listing_id, field_key) do update set
         alternatives = case when crm_bulk_listing_fields.value is distinct from excluded.value and crm_bulk_listing_fields.value is not null
           then coalesce(crm_bulk_listing_fields.alternatives, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
             'value', crm_bulk_listing_fields.value, 'status', crm_bulk_listing_fields.status, 'source_label', crm_bulk_listing_fields.source_label,
             'source_url', crm_bulk_listing_fields.source_url, 'source_date', crm_bulk_listing_fields.source_date))
           else crm_bulk_listing_fields.alternatives end,
         value = excluded.value, status = excluded.status, source_label = excluded.source_label,
         source_url = excluded.source_url, source_date = excluded.source_date, updated_at = now()`,
      [listingId, key, input.value, input.status, input.source_label, input.source_url, input.source_date]);
    await client.query(
      `insert into crm_bulk_listing_activity (bulk_listing_id, kind, title, data, actor_user_id) values ($1, 'status', $2, $3::jsonb, $4)`,
      [listingId, `Fact updated: ${key}`, JSON.stringify({ field: key, from: before?.value ?? null, to: input.value }), userId]);
  });
}
