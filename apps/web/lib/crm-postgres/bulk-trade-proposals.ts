import { queryPg, withPgTransaction, type PgTransaction } from "../postgres";
import type { AppliedChange, CheckStatus, FileType, HistoryStatus, Proposal } from "../bulk-trade-details";
import { startHistoryPass } from "../history-pass";
import { FILE_TYPES } from "../bulk-trade-details";
import { fetchGmailAttachment } from "../gmail-drafts";
import { createBulkTrade, updateBulkTrade } from "./bulk-trades";
import { addBuyer, addContact, recordFile, setField, updateBuyer } from "./bulk-trade-details";
import { addDemand, crmIdsForEmail, updateDemand } from "./bulk-demand";

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
  const claimed = await withPgTransaction(async (client) => {
    const { rows } = await client.query(
      `update crm_bulk_trade_proposals set status = $2, decided_at = now(), decided_by = $3
       where id = $1 and status = 'new'
       returning id::text as id, lot_id, kind, target, proposed, summary, quote, source_kind, source_url,
         source_label, to_char(source_at, 'YYYY-MM-DD') as source_date`,
      [id, action === "accept" ? "accepted" : "ignored", user.id],
    );
    const proposal = rows[0] as (Proposal & { source_date: string | null }) | undefined;
    if (proposal?.lot_id) {
      await client.query(
        `insert into crm_bulk_trade_events (lot_id, kind, changes, actor_user_id) values ($1, $2, $3, $4)`,
        [proposal.lot_id, action === "accept" ? "proposal_accepted" : "proposal_ignored",
          JSON.stringify({ proposal_id: proposal.id, kind: proposal.kind, summary: proposal.summary }), user.id],
      );
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
    case "field": {
      const status = proposed.status === "confirmed" ? "confirmed" : "unverified";
      const result = await setField(lotId!, p.target!, {
        value: text(proposed.value) ?? undefined, status,
        source_label: p.source_label, source_url: p.source_url, source_date: p.source_date,
      }, user.id);
      if (!result || result === "unknown_field") throw new Error("That field no longer applies to this trade.");
      return lotId;
    }
    case "buyer_update": {
      const input: Record<string, string> = {};
      if (text(proposed.status)) input.status = proposed.status as string;
      if (date(proposed.last_touch_on)) input.last_touch_on = proposed.last_touch_on as string;
      if (text(proposed.last_touch_via)) input.last_touch_via = proposed.last_touch_via as string;
      if (date(proposed.chase_on)) input.chase_on = proposed.chase_on as string;
      if (!(await updateBuyer(lotId!, p.target!, input, user.id))) throw new Error("That buyer is no longer on this trade.");
      return lotId;
    }
    case "next_step": {
      await updateBulkTrade(lotId!, {
        next_step: text(proposed.next_step),
        next_step_due: date(proposed.next_step_due),
        waiting_on: proposed.waiting_on === "them" ? "them" : "us",
      }, user.id);
      return lotId;
    }
    case "new_buyer": {
      const name = text(proposed.name);
      if (!name) throw new Error("The proposed buyer has no name.");
      await addBuyer(lotId!, { name, contact: text(proposed.contact), wants: text(proposed.wants) }, user.id);
      return lotId;
    }
    case "file": {
      const fileName = text(proposed.file_name);
      const messageId = text(proposed.gmail_message_id);
      if (!fileName || !messageId) throw new Error("The attachment reference is incomplete.");
      const content = await fetchGmailAttachment(user.email, messageId, fileName, text(proposed.attachment_id));
      const fileType = (FILE_TYPES as readonly string[]).includes(String(proposed.file_type)) ? proposed.file_type as FileType : "Other";
      await recordFile(lotId!, { file_name: fileName, file_type: fileType, content_type: null, content },
        { file_type: fileType, visibility: "never", source_label: p.source_label, source_date: p.source_date }, user.id);
      return lotId;
    }
    case "possible_trade": {
      const title = text(proposed.title);
      if (!title) throw new Error("The proposed trade has no title.");
      const trade = await createBulkTrade({
        title,
        trade_kind: ["packs", "cells", "systems", "recycling"].includes(String(proposed.trade_kind))
          ? proposed.trade_kind as "packs" : null,
        next_step: "Qualify this lead",
      }, user.id);
      // The sender becomes a contact, then a history pass reads everything they sent about it.
      const sender = text(proposed.email) ?? p.source_label.match(/[^\s·]+@[^\s·]+/)?.[0] ?? null;
      if (sender && !sender.endsWith("@rebattery.io")) {
        await addContact(trade.id, { name: sender, email: sender }, user.id);
        await requestHistoryPass(trade.id);
      }
      return trade.id;
    }
    case "link_contact": {
      const email = text(proposed.email);
      if (!email) throw new Error("The proposed contact has no email.");
      await addContact(lotId!, { name: text(proposed.name) ?? email, email }, user.id);
      await requestHistoryPass(lotId!); // read this person's past emails for the trade
      return lotId;
    }
    case "trade_kind": {
      const kind = String(proposed.trade_kind);
      if (!["packs", "cells", "systems", "recycling"].includes(kind)) throw new Error("Unknown trade kind.");
      await updateBulkTrade(lotId!, { trade_kind: kind as "packs" }, user.id);
      return lotId;
    }
    case "needs_triage":
      return lotId; // Acknowledged; Alex handles the thread by hand.
    case "bid":
      throw new Error("Bids from email are added automatically.");
    case "possible_demand": {
      const wants = text(proposed.wants);
      const source = { source_label: p.source_label, source_url: p.source_url, source_quote: p.quote };
      // Only what the email states; an update never blanks a value it does not mention.
      const details = Object.fromEntries(Object.entries({
        wants, quantity: text(proposed.quantity), location: text(proposed.location), confirmed_on: p.source_date,
      }).filter(([, value]) => value)) as { wants?: string; quantity?: string; location?: string; confirmed_on?: string };
      const demandId = text(proposed.demand_id);
      if (demandId) {
        if (!(await updateDemand(demandId, details, source))) throw new Error("That demand row no longer exists.");
        return null;
      }
      const buyer = text(proposed.buyer);
      if (!buyer || !wants) throw new Error("The demand has no buyer or no want.");
      const email = text(proposed.email);
      await addDemand({ ...details, wants, buyer, contact: text(proposed.contact), email, ...(await crmIdsForEmail(email)) }, user.id, source);
      return null;
    }
    case "link_auction": {
      // The auction sync fills in its people on its next run.
      const linked = await queryPg(
        `update crm_bulk_trade_lots set auction_id = $2, auction_slug = $3, auction_closes_at = $4, auction_status = 'published',
           listing_id = coalesce(listing_id, $5), updated_at = now()
         where id = $1 and auction_id is null
           and not exists (select 1 from crm_bulk_trade_lots other where other.auction_id = $2)
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
      if (!change?.lot_id || !change.undo) return null;
      await reverse(client, change.lot_id, change, change.undo);
      await client.query(
        "update crm_bulk_trade_proposals set status = 'undone', decided_at = now(), decided_by = $2 where id = $1",
        [id, userId],
      );
      await client.query(
        "insert into crm_bulk_trade_events (lot_id, kind, changes, actor_user_id) values ($1, 'auto_undone', $2, $3)",
        [change.lot_id, JSON.stringify({ proposal_id: change.id, kind: change.kind, summary: change.summary, undo: change.undo }), userId],
      );
      return change.lot_id;
    });
    return lotId ? { ok: true, lot_id: lotId } : { ok: false, status: 404, error: "Already undone or not found." };
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
