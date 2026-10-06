import { randomUUID } from "node:crypto";
import { queryPg, withPgTransaction } from "../postgres";
import { LIVE_STAGES, todayInLondon, type BulkTrade, type TradeOwner, type TradePatch } from "../bulk-trades";

const TRADE_COLUMNS = `
  lot.id, lot.title, lot.trade_stage, lot.trade_kind, lot.fact_line, lot.next_step,
  to_char(lot.next_step_due, 'YYYY-MM-DD') as next_step_due, lot.waiting_on,
  to_char(lot.waiting_since, 'YYYY-MM-DD') as waiting_since, lot.owner_user_id,
  owner.display_name as owner_name, lot.value,
  -- Last touch: the latest of a date set by hand, any logged change (edits, emails the inbox check applied,
  -- auction activity) and any buyer's last touch.
  to_char(greatest(lot.last_touched,
    (select max(event.occurred_at)::date from crm_bulk_trade_events event where event.lot_id = lot.id),
    (select max(buyer.last_touch_on) from crm_bulk_trade_buyers buyer where buyer.lot_id = lot.id)), 'YYYY-MM-DD') as last_touched,
  (select count(*)::int from crm_bulk_trade_buyers buyer where buyer.lot_id = lot.id) as buyer_count,
  (select count(*)::int from crm_bulk_trade_bids bid where bid.lot_id = lot.id) as bid_count,
  to_char(lot.clear_by, 'YYYY-MM-DD') as clear_by,
  to_char(lot.ship_by, 'YYYY-MM-DD') as ship_by,
  lot.transport_class, lot.tfs_needed, lot.listing_id, lot.auction_slug, lot.auction_status, lot.auction_closes_at,
  to_char(lot.hold_until, 'YYYY-MM-DD') as hold_until, lot.hold_reason, lot.hold_from_stage,
  lot.next_step_contact_id, lot.next_step_buyer_id, lot.updated_at,
  (select count(*)::int from crm_bulk_trade_proposals proposal
    where proposal.status = 'new' and (proposal.lot_id = lot.id
      or (proposal.kind = 'needs_triage' and proposal.proposed->'lot_ids' ? lot.id))) as new_count`;

const TRADE_FROM = `crm_bulk_trade_lots lot left join crm_users owner on owner.id = lot.owner_user_id`;

export async function listBulkTrades(): Promise<{ trades: BulkTrade[]; owners: TradeOwner[] }> {
  const [trades, owners] = await Promise.all([
    queryPg<BulkTrade>(`select ${TRADE_COLUMNS} from ${TRADE_FROM} order by lot.title`),
    queryPg<TradeOwner>(
      "select id, display_name as name from crm_users where is_active order by display_name",
    ),
  ]);
  return { trades, owners };
}

export async function getBulkTrade(id: string): Promise<BulkTrade | null> {
  const [trade] = await queryPg<BulkTrade>(`select ${TRADE_COLUMNS} from ${TRADE_FROM} where lot.id = $1`, [id]);
  return trade ?? null;
}

// Column names come only from validated TradePatch keys.
function assignments(patch: Record<string, unknown>, firstParam: number) {
  const keys = Object.keys(patch);
  return {
    sql: keys.map((key, index) => `${key} = $${firstParam + index}`).join(", "),
    values: keys.map((key) => patch[key]),
  };
}

export async function createBulkTrade(
  patch: TradePatch & { title: string },
  userId: string,
): Promise<BulkTrade> {
  const id = `bt_${randomUUID()}`;
  const fields: Record<string, unknown> = { ...patch };
  if (fields.waiting_on === "them") fields.waiting_since = todayInLondon();
  const keys = Object.keys(fields);

  return withPgTransaction(async (client) => {
    // summary, observed_outcome and confidence are required by the older evidence model.
    await client.query(
      `insert into crm_bulk_trade_lots
         (id, lot_kind, summary, observed_outcome, confidence, ${keys.join(", ")})
       values ($1, 'supply', '', '', 'confirmed', ${keys.map((_, i) => `$${i + 2}`).join(", ")})`,
      [id, ...keys.map((key) => fields[key])],
    );
    await client.query(
      `insert into crm_bulk_trade_events (lot_id, kind, changes, actor_user_id)
       values ($1, 'trade_created', $2, $3)`,
      [id, JSON.stringify(fields), userId],
    );
    const { rows } = await client.query(`select ${TRADE_COLUMNS} from ${TRADE_FROM} where lot.id = $1`, [id]);
    return rows[0] as BulkTrade;
  });
}

export async function updateBulkTrade(
  id: string,
  patch: TradePatch,
  userId: string,
): Promise<BulkTrade | null> {
  return withPgTransaction(async (client) => {
    const current = await client.query(
      `select ${TRADE_COLUMNS} from ${TRADE_FROM} where lot.id = $1 for update of lot`,
      [id],
    );
    const before = current.rows[0] as BulkTrade | undefined;
    if (!before) return null;
    // The next step's person must belong to this trade.
    for (const [key, table] of [["next_step_contact_id", "crm_bulk_trade_contacts"], ["next_step_buyer_id", "crm_bulk_trade_buyers"]] as const) {
      const value = patch[key];
      if (!value) continue;
      const { rows } = await client.query(`select 1 from ${table} where id = $1 and lot_id = $2`, [value, id]);
      if (!rows.length) throw Object.assign(new Error("That person is not on this trade."), { code: "23503" });
    }
    // Going on hold remembers the stage to resume to; leaving the hold clears it.
    if (patch.trade_stage === "On hold" && before.trade_stage !== "On hold") {
      patch = { ...patch, hold_from_stage: (LIVE_STAGES as readonly string[]).includes(before.trade_stage) ? before.trade_stage : null } as TradePatch;
    } else if (patch.trade_stage && patch.trade_stage !== "On hold" && before.trade_stage === "On hold") {
      patch = { ...patch, hold_until: null, hold_reason: null, hold_from_stage: null } as TradePatch;
    }
    // Picking one side clears the other, so a step is never for two people.
    if (patch.next_step_contact_id) patch = { ...patch, next_step_buyer_id: null };
    if (patch.next_step_buyer_id) patch = { ...patch, next_step_contact_id: null };

    const changes: Record<string, [unknown, unknown]> = {};
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      const old = before[key as keyof BulkTrade] ?? null;
      if (old !== value) {
        changes[key] = [old, value];
        fields[key] = value;
      }
    }
    if ("waiting_on" in fields) {
      fields.waiting_since = fields.waiting_on === "them" ? todayInLondon() : null;
      changes.waiting_since = [before.waiting_since, fields.waiting_since];
    }
    if (!Object.keys(fields).length) return before;

    const set = assignments(fields, 2);
    await client.query(
      `update crm_bulk_trade_lots set ${set.sql}, updated_at = now() where id = $1`,
      [id, ...set.values],
    );
    await client.query(
      `insert into crm_bulk_trade_events (lot_id, kind, changes, actor_user_id)
       values ($1, 'trade_updated', $2, $3)`,
      [id, JSON.stringify(changes), userId],
    );
    const { rows } = await client.query(`select ${TRADE_COLUMNS} from ${TRADE_FROM} where lot.id = $1`, [id]);
    return rows[0] as BulkTrade;
  });
}
