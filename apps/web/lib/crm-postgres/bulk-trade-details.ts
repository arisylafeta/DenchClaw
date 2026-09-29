import { randomUUID } from "node:crypto";
import { queryPg, withPgTransaction, type PgTransaction } from "../postgres";
import { todayInLondon, type BulkTrade } from "../bulk-trades";
import {
  templateField,
  type BidInput,
  type Buyer,
  type BuyerInput,
  type Contact,
  type ContactInput,
  type FieldInput,
  type FileMetaInput,
  type FileType,
  type CompanyMatch,
  type PersonMatch,
  type TradeDetail,
  type TradeField,
  type TradeFile,
} from "../bulk-trade-details";
import { getBulkTrade } from "./bulk-trades";
import { newLinkToken } from "../tracked-links";

const BID_COLUMNS = `bid.id::text as id, bid.buyer_id, bid.amount::text as amount, bid.unit, bid.currency,
  bid.firmness, bid.delivery_terms, bid.payment_terms,
  to_char(bid.expires_on, 'YYYY-MM-DD') as expires_on, bid.created_at`;

// The latest accepted campaign send to the buyer's CRM person for this trade's listing, matched on
// the send's listing or any of its CTA links. Read-only; the campaign CLI owns these rows.
const TRACKING = `
    (select row_to_json(latest) from (
       select campaign.campaign_name as campaign, send.accepted_at as sent_at, send.delivered_at, send.bounced_at,
         send.provider_opened_at as opened_at,
         coalesce(send.provider_link_clicked_at,
           (select min(link.first_clicked_at) from crm_campaign_send_links link where link.send_id = send.id)) as clicked_at
       from crm_campaign_sends send
       join campaigns campaign on campaign.id = send.campaign_id
       join crm_bulk_trade_lots lot on lot.id = buyer.lot_id
       where send.person_id = buyer.person_id and send.state = 'accepted' and lot.listing_id is not null
         and (send.listing_id = lot.listing_id or exists (
           select 1 from crm_campaign_send_links link where link.send_id = send.id and link.listing_id = lot.listing_id))
       order by send.accepted_at desc limit 1
     ) latest) as email_tracking`;

const BUYER_SELECT = `
  select buyer.id, buyer.name, buyer.person_id, person.email as person_email,
    buyer.contact, buyer.wants, buyer.status,
    to_char(buyer.last_touch_on, 'YYYY-MM-DD') as last_touch_on, buyer.last_touch_via,
    to_char(buyer.chase_on, 'YYYY-MM-DD') as chase_on,
    (select row_to_json(latest) from (
       select ${BID_COLUMNS} from crm_bulk_trade_bids bid
       where bid.buyer_id = buyer.id order by bid.created_at desc, bid.id desc limit 1
     ) latest) as latest_bid,
    (select max(link.last_clicked_at) from crm_bulk_trade_links link where link.buyer_id = buyer.id) as link_clicked_at,
    ${TRACKING}
  from crm_bulk_trade_buyers buyer
  left join crm_people person on person.id = buyer.person_id`;

const CONTACT_SELECT = `select id, name, company, email, phone from crm_bulk_trade_contacts`;

const FIELD_SELECT = `
  select field_key, value, status, visibility, source_label, source_url,
    to_char(source_date, 'YYYY-MM-DD') as source_date, alternatives
  from crm_bulk_trade_fields`;

const FILE_SELECT = `
  select id, file_name, file_type, byte_size::integer as byte_size, source_label,
    to_char(source_date, 'YYYY-MM-DD') as source_date, visibility, created_at
  from crm_bulk_trade_files`;

export async function getTradeDetail(lotId: string): Promise<TradeDetail | null> {
  const trade = await getBulkTrade(lotId);
  if (!trade) return null;
  const [buyers, contacts, fields, files] = await Promise.all([
    queryPg<Buyer>(`${BUYER_SELECT} where buyer.lot_id = $1 order by buyer.created_at, buyer.id`, [lotId]),
    queryPg<Contact>(`${CONTACT_SELECT} where lot_id = $1 order by sort_order, created_at`, [lotId]),
    queryPg<TradeField>(`${FIELD_SELECT} where lot_id = $1`, [lotId]),
    queryPg<TradeFile>(`${FILE_SELECT} where lot_id = $1 order by created_at`, [lotId]),
  ]);
  return { trade, buyers, contacts, fields, files };
}

async function logEvent(
  client: PgTransaction,
  lotId: string,
  kind: string,
  changes: Record<string, unknown>,
  userId: string,
  buyerId: string | null = null,
) {
  await client.query(
    `insert into crm_bulk_trade_events (lot_id, kind, changes, actor_user_id, buyer_id)
     values ($1, $2, $3, $4, $5)`,
    [lotId, kind, JSON.stringify(changes), userId, buyerId],
  );
}

/** Before/after pairs for keys whose value differs. */
function diff(before: Record<string, unknown>, patch: Record<string, unknown>) {
  const changes: Record<string, [unknown, unknown]> = {};
  for (const [key, value] of Object.entries(patch)) {
    const old = before[key] ?? null;
    if (old !== value) changes[key] = [old, value];
  }
  return changes;
}

// Column names below come only from validated input keys.
function insertSql(table: string, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  return {
    sql: `insert into ${table} (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")})`,
    values: keys.map((key) => fields[key]),
  };
}

/**
 * Writes only the keys whose value differs from `before`. Returns the before/after pairs for the
 * event log, or null when nothing changed.
 */
async function updateChanged(
  client: PgTransaction,
  table: string,
  where: { sql: string; values: unknown[] },
  before: object,
  patch: Record<string, unknown>,
  touch = false,
) {
  const changes = diff(before as Record<string, unknown>, patch);
  const keys = Object.keys(changes);
  if (!keys.length) return null;
  const offset = where.values.length;
  await client.query(
    `update ${table} set ${keys.map((key, i) => `${key} = $${offset + i + 1}`).join(", ")}${touch ? ", updated_at = now()" : ""}
     where ${where.sql}`,
    [...where.values, ...keys.map((key) => patch[key])],
  );
  return changes;
}

async function tradeExists(client: PgTransaction, lotId: string) {
  const { rows } = await client.query("select 1 from crm_bulk_trade_lots where id = $1", [lotId]);
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Buyers and bids
// ---------------------------------------------------------------------------

export async function addBuyer(lotId: string, input: BuyerInput & { name: string }, userId: string): Promise<Buyer | null> {
  return withPgTransaction(async (client) => {
    if (!(await tradeExists(client, lotId))) return null;
    const id = `btb_${randomUUID()}`;
    const insert = insertSql("crm_bulk_trade_buyers", { id, lot_id: lotId, ...input });
    await client.query(insert.sql, insert.values);
    await logEvent(client, lotId, "buyer_added", input, userId, id);
    const { rows } = await client.query(`${BUYER_SELECT} where buyer.id = $1`, [id]);
    return rows[0] as Buyer;
  });
}

/** A status change also records today as the last touch unless the edit sets one. */
export async function updateBuyer(lotId: string, buyerId: string, input: BuyerInput, userId: string): Promise<Buyer | null> {
  return withPgTransaction(async (client) => {
    const current = await client.query(
      `${BUYER_SELECT} where buyer.id = $1 and buyer.lot_id = $2 for update of buyer`,
      [buyerId, lotId],
    );
    const before = current.rows[0] as Buyer | undefined;
    if (!before) return null;

    const patch: Record<string, unknown> = { ...input };
    if (patch.status && patch.status !== before.status && !("last_touch_on" in patch)) {
      patch.last_touch_on = todayInLondon();
    }
    const changes = await updateChanged(client, "crm_bulk_trade_buyers", { sql: "id = $1", values: [buyerId] }, before, patch, true);
    if (!changes) return before;
    await logEvent(client, lotId, "buyer_updated", changes, userId, buyerId);
    const { rows } = await client.query(`${BUYER_SELECT} where buyer.id = $1`, [buyerId]);
    return rows[0] as Buyer;
  });
}

/** Records a bid and moves a buyer who had not bid yet to "Bid in". */
export async function addBid(lotId: string, buyerId: string, input: BidInput, userId: string): Promise<Buyer | null> {
  return withPgTransaction(async (client) => {
    const current = await client.query(
      `select status, to_char(last_touch_on, 'YYYY-MM-DD') as last_touch_on
       from crm_bulk_trade_buyers where id = $1 and lot_id = $2 for update`,
      [buyerId, lotId],
    );
    const before = current.rows[0] as { status: string; last_touch_on: string | null } | undefined;
    if (!before) return null;

    const insert = insertSql("crm_bulk_trade_bids", { lot_id: lotId, buyer_id: buyerId, actor_user_id: userId, ...input });
    await client.query(insert.sql, insert.values);
    await logEvent(client, lotId, "bid_added", input, userId, buyerId);

    const early = ["To contact", "Teaser sent", "No reply", "NDA, specs sent"];
    if (early.includes(before.status)) {
      const today = todayInLondon();
      await client.query(
        "update crm_bulk_trade_buyers set status = 'Bid in', last_touch_on = $2, updated_at = now() where id = $1",
        [buyerId, today],
      );
      await logEvent(client, lotId, "buyer_updated", {
        status: [before.status, "Bid in"],
        ...(before.last_touch_on !== today ? { last_touch_on: [before.last_touch_on, today] } : {}),
      }, userId, buyerId);
    }
    const { rows } = await client.query(`${BUYER_SELECT} where buyer.id = $1`, [buyerId]);
    return rows[0] as Buyer;
  });
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export async function addContact(lotId: string, input: ContactInput & { name: string }, userId: string): Promise<Contact | null> {
  return withPgTransaction(async (client) => {
    if (!(await tradeExists(client, lotId))) return null;
    const id = `btc_${randomUUID()}`;
    const { rows: [{ next }] } = await client.query(
      "select coalesce(max(sort_order), -1) + 1 as next from crm_bulk_trade_contacts where lot_id = $1",
      [lotId],
    );
    const insert = insertSql("crm_bulk_trade_contacts", { id, lot_id: lotId, sort_order: next, ...input });
    await client.query(insert.sql, insert.values);
    await logEvent(client, lotId, "contact_added", { id, ...input }, userId);
    const { rows } = await client.query(`${CONTACT_SELECT} where id = $1`, [id]);
    return rows[0] as Contact;
  });
}

export async function updateContact(lotId: string, contactId: string, input: ContactInput, userId: string): Promise<Contact | null> {
  return withPgTransaction(async (client) => {
    const current = await client.query(`${CONTACT_SELECT} where id = $1 and lot_id = $2 for update`, [contactId, lotId]);
    const before = current.rows[0] as Contact | undefined;
    if (!before) return null;
    const changes = await updateChanged(client, "crm_bulk_trade_contacts", { sql: "id = $1", values: [contactId] }, before, input);
    if (!changes) return before;
    await logEvent(client, lotId, "contact_updated", { id: contactId, ...changes }, userId);
    const { rows } = await client.query(`${CONTACT_SELECT} where id = $1`, [contactId]);
    return rows[0] as Contact;
  });
}

export async function removeContact(lotId: string, contactId: string, userId: string): Promise<boolean> {
  return withPgTransaction(async (client) => {
    const { rows } = await client.query(
      `delete from crm_bulk_trade_contacts where id = $1 and lot_id = $2 returning id, name, company, email, phone`,
      [contactId, lotId],
    );
    if (!rows.length) return false;
    await logEvent(client, lotId, "contact_removed", rows[0], userId);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Field data
// ---------------------------------------------------------------------------

/** Locks the trade row, so concurrent first writes to the same field queue instead of colliding. */
async function tradeKind(client: PgTransaction, lotId: string) {
  const { rows } = await client.query("select trade_kind from crm_bulk_trade_lots where id = $1 for update", [lotId]);
  return rows[0] as { trade_kind: BulkTrade["trade_kind"] } | undefined;
}

/**
 * Sets a template field. A new row takes the template's "buyers see at" unless the input sets it.
 * Returns "unknown_field" when the key is not in the trade kind's template.
 */
export async function setField(
  lotId: string,
  key: string,
  input: FieldInput,
  userId: string,
): Promise<TradeField | null | "unknown_field"> {
  return withPgTransaction(async (client) => {
    const lot = await tradeKind(client, lotId);
    if (!lot) return null;
    const template = templateField(lot.trade_kind ?? "packs", key);
    if (!template) return "unknown_field";

    const current = await client.query(`${FIELD_SELECT} where lot_id = $1 and field_key = $2 for update`, [lotId, key]);
    const before = current.rows[0] as TradeField | undefined;
    const patch: Record<string, unknown> = { ...input };

    if (!before) {
      const row = { visibility: template.visibility, ...patch };
      const insert = insertSql("crm_bulk_trade_fields", { lot_id: lotId, field_key: key, ...row });
      await client.query(insert.sql, insert.values);
      await logEvent(client, lotId, "field_updated", { field: key, ...diff({}, row) }, userId);
    } else {
      const where = { sql: "lot_id = $1 and field_key = $2", values: [lotId, key] };
      const changes = await updateChanged(client, "crm_bulk_trade_fields", where, before, patch, true);
      if (!changes) return before;
      await logEvent(client, lotId, "field_updated", { field: key, ...changes }, userId);
    }
    const { rows } = await client.query(`${FIELD_SELECT} where lot_id = $1 and field_key = $2`, [lotId, key]);
    return rows[0] as TradeField;
  });
}

/**
 * Settles a conflict. choice -1 keeps the current value; otherwise the chosen alternative replaces
 * it. Either way the field becomes confirmed and the other claims are dropped (they stay in the log).
 */
export async function resolveConflict(lotId: string, key: string, choice: number, userId: string): Promise<TradeField | null> {
  return withPgTransaction(async (client) => {
    const current = await client.query(`${FIELD_SELECT} where lot_id = $1 and field_key = $2 for update`, [lotId, key]);
    const before = current.rows[0] as TradeField | undefined;
    if (!before || (choice !== -1 && !before.alternatives[choice])) return null;

    const picked = choice === -1 ? before : before.alternatives[choice];
    await client.query(
      `update crm_bulk_trade_fields set value = $3, source_label = $4, source_url = $5, source_date = $6,
         status = 'confirmed', alternatives = '[]'::jsonb, updated_at = now()
       where lot_id = $1 and field_key = $2`,
      [lotId, key, picked.value, picked.source_label, picked.source_url, picked.source_date],
    );
    await logEvent(client, lotId, "field_updated", {
      field: key,
      resolved: { kept: picked, dropped: [before, ...before.alternatives].filter((claim) => claim !== picked) },
    }, userId);
    const { rows } = await client.query(`${FIELD_SELECT} where lot_id = $1 and field_key = $2`, [lotId, key]);
    return rows[0] as TradeField;
  });
}

// ---------------------------------------------------------------------------
// Files (bytes stored in the row; see app/api/bulk-trades/[id]/files)
// ---------------------------------------------------------------------------

export type NewFile = {
  file_name: string;
  file_type: FileType;
  content_type: string | null;
  content: Buffer;
};

export async function recordFile(lotId: string, file: NewFile, meta: FileMetaInput, userId: string): Promise<TradeFile | null> {
  return withPgTransaction(async (client) => {
    if (!(await tradeExists(client, lotId))) return null;
    const id = `btf_${randomUUID()}`;
    const insert = insertSql("crm_bulk_trade_files", {
      id, lot_id: lotId, uploaded_by: userId, ...file, byte_size: file.content.length, ...meta,
    });
    await client.query(insert.sql, insert.values);
    await logEvent(client, lotId, "file_added", {
      id, file_name: file.file_name, byte_size: file.content.length, file_type: meta.file_type ?? file.file_type,
      visibility: meta.visibility ?? "never", source_label: meta.source_label ?? null, source_date: meta.source_date ?? null,
    }, userId);
    const { rows } = await client.query(`${FILE_SELECT} where id = $1`, [id]);
    return rows[0] as TradeFile;
  });
}

export async function updateFile(lotId: string, fileId: string, meta: FileMetaInput, userId: string): Promise<TradeFile | null> {
  return withPgTransaction(async (client) => {
    const current = await client.query(`${FILE_SELECT} where id = $1 and lot_id = $2 for update`, [fileId, lotId]);
    const before = current.rows[0] as TradeFile | undefined;
    if (!before) return null;
    const changes = await updateChanged(client, "crm_bulk_trade_files", { sql: "id = $1", values: [fileId] }, before, meta);
    if (!changes) return before;
    await logEvent(client, lotId, "file_updated", { id: fileId, ...changes }, userId);
    const { rows } = await client.query(`${FILE_SELECT} where id = $1`, [fileId]);
    return rows[0] as TradeFile;
  });
}

export async function getFileForDownload(lotId: string, fileId: string) {
  const [row] = await queryPg<{ file_name: string; content: Buffer }>(
    "select file_name, content from crm_bulk_trade_files where id = $1 and lot_id = $2",
    [fileId, lotId],
  );
  return row ?? null;
}

export async function logEmailDraft(
  lotId: string,
  draft: { to: string[]; subject: string; draft_id: string | null; buyer_id?: string | null; tracked_links?: number },
  userId: string,
): Promise<void> {
  await queryPg(
    `insert into crm_bulk_trade_events (lot_id, kind, changes, actor_user_id, buyer_id) values ($1, 'email_drafted', $2, $3, $4)`,
    [lotId, JSON.stringify(draft), userId, draft.buyer_id ?? null],
  );
}

export async function buyerOnTrade(lotId: string, buyerId: string): Promise<boolean> {
  const rows = await queryPg("select 1 from crm_bulk_trade_buyers where id = $1 and lot_id = $2", [buyerId, lotId]);
  return rows.length > 0;
}

/** Up to 6 CRM companies whose name matches, with how many people each has. */
export async function searchCompanies(query: string): Promise<CompanyMatch[]> {
  const pattern = `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  return queryPg<CompanyMatch>(
    `select c.id, c.name, (select count(*)::int from crm_people p where p.company_id = c.id) as people
     from crm_companies c where c.name ilike $1
     order by (lower(c.name) = lower($2)) desc, people desc, c.name
     limit 6`,
    [pattern, query],
  );
}

/** Up to 8 CRM people whose name, email or company matches. */
export async function searchPeople(query: string): Promise<PersonMatch[]> {
  const pattern = `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  return queryPg<PersonMatch>(
    `select p.id, coalesce(nullif(p.full_name, ''), concat_ws(' ', p.first_name, p.last_name), p.email) as name,
       c.name as company, p.email, coalesce(p.email_opted_out, false) as opted_out
     from crm_people p left join crm_companies c on c.id = p.company_id
     where p.full_name ilike $1 or p.email ilike $1 or c.name ilike $1
       or concat_ws(' ', p.first_name, p.last_name) ilike $1
     order by p.last_interaction_at desc nulls last, p.id
     limit 8`,
    [pattern],
  );
}

// ---------------------------------------------------------------------------
// Tracked links
// ---------------------------------------------------------------------------

/** Creates one tracked link per URL for this recipient. Returns URL → token. */
export async function createTrackedLinks(
  lotId: string,
  buyerId: string | null,
  recipient: string | null,
  urls: string[],
  userId: string,
): Promise<Map<string, string>> {
  const tokens = new Map<string, string>();
  if (!urls.length) return tokens;
  await withPgTransaction(async (client) => {
    for (const url of urls) {
      const token = newLinkToken();
      await client.query(
        `insert into crm_bulk_trade_links (token, lot_id, buyer_id, recipient, destination_url, created_by)
         values ($1, $2, $3, $4, $5, $6)`,
        [token, lotId, buyerId, recipient, url, userId],
      );
      tokens.set(url, token);
    }
  });
  return tokens;
}

/**
 * Looks up a tracked link and, for a person's click, counts it and logs it on the trade.
 * Returns the destination, or null for an unknown token.
 */
export async function followTrackedLink(token: string, counted: boolean): Promise<string | null> {
  return withPgTransaction(async (client) => {
    const { rows } = await client.query(
      `select lot_id, buyer_id, recipient, destination_url from crm_bulk_trade_links where token = $1 for update`,
      [token],
    );
    const link = rows[0] as { lot_id: string; buyer_id: string | null; recipient: string | null; destination_url: string } | undefined;
    if (!link) return null;
    if (counted) {
      await client.query(
        `update crm_bulk_trade_links set click_count = click_count + 1,
           first_clicked_at = coalesce(first_clicked_at, now()), last_clicked_at = now()
         where token = $1`,
        [token],
      );
      await client.query(
        `insert into crm_bulk_trade_events (lot_id, kind, changes, buyer_id)
         values ($1, 'link_clicked', $2, $3)`,
        [link.lot_id, JSON.stringify({ url: link.destination_url, recipient: link.recipient }), link.buyer_id],
      );
    }
    return link.destination_url;
  });
}
