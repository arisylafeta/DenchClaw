import { randomUUID } from "node:crypto";
import { queryPg, withPgTransaction } from "../postgres";
import { todayInLondon, type BulkTrade, type TradeOwner, type TradePatch } from "../bulk-trades";

const TRADE_COLUMNS = `
  lot.id, lot.title, lot.trade_stage, lot.trade_kind, lot.fact_line, lot.next_step,
  to_char(lot.next_step_due, 'YYYY-MM-DD') as next_step_due, lot.waiting_on,
  to_char(lot.waiting_since, 'YYYY-MM-DD') as waiting_since, lot.owner_user_id,
  owner.display_name as owner_name, lot.value,
  to_char(lot.last_touched, 'YYYY-MM-DD') as last_touched,
  to_char(lot.clear_by, 'YYYY-MM-DD') as clear_by,
  to_char(lot.ship_by, 'YYYY-MM-DD') as ship_by,
  lot.transport_class, lot.tfs_needed, lot.updated_at`;

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
