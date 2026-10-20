import { randomUUID } from 'node:crypto';
import type { PgTransaction } from '../postgres';
import { cleanSpec, demandFee, parseDemandInput } from '../bulk-demand';
import { loadRegistry } from './bulk-registry';

const text = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : null;
const KEYS = ['kind','basis','buyer','company_id','person_id','contact','email','wants','quantity','location',
  'needed_by','volume','volume_unit','max_price','price_currency','price_unit','spec','observed_on','confirmed_on',
  'status','product_family','fee_eur','price_basis','reputation','qualify_question','source_kind','source_id',
  'source_label','source_url','source_quote','source_thread'] as const;

/** Must run in the proposal claim transaction. Snapshot raw rows, not decorated reader results. */
export async function acceptDemand(client: PgTransaction, p: Record<string, any>, userId: string) {
  const proposed = p.proposed;
  if (p.source_kind === 'whatsapp') {
    // Identity linking takes this same row lock. Validate using a fresh statement after it settles.
    await client.query(`select i.id from whatsapp_identity i join whatsapp_message m on m.sender_identity_id=i.id
      where m.id=$1 for update of i`, [p.source_id]);
    const { rows } = await client.query(`select m.id from whatsapp_message m
      join whatsapp_identity i on i.id=m.sender_identity_id
      join whatsapp_identity_link l on l.identity_id=i.id and l.valid_to is null
      where m.id=$1 and m.deleted_at is null and m.body is not null and whatsapp_source_version(m)=$2
      and coalesce(m.metadata->>'content_redacted','false')<>'true'
      and coalesce((m.metadata->'flags'->>'viewOnce')::boolean,false)=false
      and (nullif(m.metadata->'flags'->>'expiresAt','')::timestamptz is null
        or (m.metadata->'flags'->>'expiresAt')::timestamptz > now())
      and l.person_id is not distinct from $3 and l.company_id is not distinct from $4
      and (l.person_id is null or not i.shared)
      and (select count(*) from whatsapp_identity_link active where active.identity_id=i.id and active.valid_to is null)=1
      for update of m,i,l`, [p.source_id, proposed.source_version, text(proposed.person_id), text(proposed.company_id)]);
    if (!rows.length) throw new Error('WhatsApp source or identity changed; review the current message.');
  }
  let personId = text(proposed.person_id), companyId = text(proposed.company_id);
  const email = text(proposed.email);
  if (!personId && !companyId && email && p.source_kind !== 'whatsapp') {
    const { rows } = await client.query('select id,company_id from crm_people where lower(email)=lower($1) limit 1', [email]);
    personId = rows[0]?.id ?? null; companyId = rows[0]?.company_id ?? null;
  }
  // Serialise identity/family upserts, including two different cards accepted concurrently.
  await client.query('select pg_advisory_xact_lock(hashtext($1))', [JSON.stringify([companyId,personId,email,proposed.product_family])]);
  const { rows } = await client.query(`select d.*,to_jsonb(d) as snapshot from crm_bulk_demand d where status in ('open','qualifying')
    and lower(product_family)=lower($1) and (($2::text is not null and company_id=$2)
      or ($3::text is not null and person_id=$3) or ($4::text is not null and lower(email)=lower($4)))
    order by observed_on desc nulls last limit 1 for update`, [text(proposed.product_family), companyId, personId, email]);
  let before = rows[0] ?? null;
  const target = before?.id ?? text(proposed.existing_demand_id) ?? text(proposed.demand_id);
  if (target && !before) {
    const result = await client.query('select d.*,to_jsonb(d) as snapshot from crm_bulk_demand d where id=$1 for update', [target]);
    before = result.rows[0];
    if (!before || before.status === 'closed') throw new Error('That demand no longer accepts updates.');
    if ((companyId && before.company_id !== companyId) || (personId && before.person_id !== personId))
      throw new Error('Demand identity does not match the source.');
  }
  const patch: Record<string, unknown> = {};
  for (const key of ['wants','quantity','location','kind','needed_by','volume','volume_unit','max_price','price_currency',
    'price_unit','product_family','fee_eur','price_basis','reputation']) {
    if (proposed[key] !== undefined && proposed[key] !== null && proposed[key] !== '') patch[key] = proposed[key];
  }
  const registry = await loadRegistry();
  const spec = cleanSpec(proposed.spec, registry);
  if (Object.keys(spec).length) patch.spec = { ...(before?.spec ?? {}), ...spec };
  if (before) { delete patch.kind; if (before.kind === 'standing') delete patch.needed_by; }
  else Object.assign(patch, { buyer: text(proposed.buyer), contact: text(proposed.contact), email,
    person_id: personId, company_id: companyId });
  const combined = { ...before, ...patch };
  patch.status = combined.product_family && (combined.quantity || combined.volume) && combined.max_price ? 'open' : 'qualifying';
  patch.qualify_question = patch.status === 'qualifying' ? 'What quantity and unit price?' : null;
  if (p.source_date) { patch.observed_on = p.source_date; patch.confirmed_on = p.source_date; }
  const parsed = parseDemandInput(patch, !before, registry);
  if ('error' in parsed) throw new Error(parsed.error);
  const sourceKind: Record<string,string> = { gmail:'email', granola:'call', whatsapp:'whatsapp', auction:'auction' };
  if (!sourceKind[p.source_kind]) throw new Error('Unsupported demand source.');
  const data: Record<string,unknown> = { ...parsed.value, fee_eur: demandFee({ ...before, ...parsed.value }),
    source_kind:sourceKind[p.source_kind], source_id:p.source_id, source_label:p.source_label,
    source_url:p.source_url, source_quote:p.quote, source_thread:p.source_thread };
  const id = before?.id ?? `btd_${randomUUID()}`;
  const keys = KEYS.filter(k => k in data);
  const values = keys.map(k => k === 'spec' ? JSON.stringify(data[k]) : data[k]);
  if (before) await client.query(`update crm_bulk_demand set ${keys.map((k,i)=>`${k}=$${i+2}`).join(',')},updated_at=now() where id=$1`, [id,...values]);
  else await client.query(`insert into crm_bulk_demand(id,${keys.join(',')},created_by) values($1,${keys.map((_,i)=>`$${i+2}`).join(',')},$${keys.length+2})`, [id,...values,userId]);
  const after = (await client.query('select to_jsonb(d) as snapshot from crm_bulk_demand d where id=$1', [id])).rows[0].snapshot;
  // JSON normalisation is handled by PostgreSQL to preserve dates and numeric representations.
  const beforeSnapshot = before?.snapshot ?? null;
  await client.query(`update crm_bulk_trade_proposals set status='applied',applied_at=now(),undo=$2 where id=$1`,
    [p.id,JSON.stringify({ demand_id:id,before:beforeSnapshot,after })]);
}

export async function reverseDemand(client: PgTransaction, undo: Record<string,any>) {
  const { rows } = await client.query('select to_jsonb(d) as snapshot from crm_bulk_demand d where id=$1 for update', [undo.demand_id]);
  // Compare in PostgreSQL, not JS object order or lossy numeric conversions.
  const equal = (await client.query('select $1::jsonb=$2::jsonb as same', [JSON.stringify(rows[0]?.snapshot),JSON.stringify(undo.after)])).rows[0].same;
  if (!equal) throw new Error('That demand has changed since; edit it by hand.');
  if (!undo.before) {
    const used = (await client.query(`select exists(select 1 from crm_bulk_trade_buyers where demand_id=$1) as used`, [undo.demand_id])).rows[0].used;
    if (used) throw new Error('That demand is linked to a buyer; edit it by hand.');
    await client.query('delete from crm_bulk_demand where id=$1', [undo.demand_id]);
  } else {
    // Only schema-owned column names from the stored row type, never proposal/model keys.
    const columns = (await client.query(`select attname from pg_attribute where attrelid='crm_bulk_demand'::regclass and attnum>0 and not attisdropped and attgenerated='' and attname<>'id'`)).rows.map(r=>r.attname as string);
    await client.query(`update crm_bulk_demand d set ${columns.map(k=>`"${k}"=b."${k}"`).join(',')} from jsonb_populate_record(null::crm_bulk_demand,$2::jsonb) b where d.id=$1`, [undo.demand_id,JSON.stringify(undo.before)]);
  }
}
