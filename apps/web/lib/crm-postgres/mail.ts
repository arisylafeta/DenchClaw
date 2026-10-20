import { queryPg } from '../postgres';
import type { MailDraft, MailDraftListRow, MailApproval, MailFilters, MailMessageRow, MailMessageListRow, MailPage, MailThread, MailFollowup, MailCampaignSummary, MailParticipant } from '../mail-types';
import { listCampaigns, getCampaignDetail } from './campaigns';

// Match the complete domain, not lookalikes such as rebattery.io.evil.com.
function selfAddressSql(column: string) {
  return `(coalesce(lower(${column}) like '%@rebattery.io',false) or exists (select 1 from mail_identity identity where lower(identity.address) = lower(${column})))`;
}

export function internalMessageSql(alias: string) {
  const recipients = `(coalesce(${alias}.to_emails,'{}') || coalesce(${alias}.cc_emails,'{}') || coalesce(${alias}.bcc_emails,'{}') || array[${alias}.recipient_email])`;
  return `(lower(coalesce(${alias}.from_email,'')) like '%@rebattery.io' and exists (select 1 from unnest(${recipients}) r where coalesce(r,'') <> '') and not exists (select 1 from unnest(${recipients}) r where coalesce(r,'') <> '' and lower(r) not like '%@rebattery.io'))`;
}

function counterpartySql() {
  return `(select jsonb_build_object('email',recipient.email,'name',case when ${selfAddressSql('recipient.email')} then null else (select p.full_name from crm_people p where lower(p.email)=lower(recipient.email) order by p.id limit 1) end)
    from unnest(case when ${selfAddressSql('m.from_email')} then coalesce(m.to_emails,'{}') || array[m.recipient_email] || coalesce(m.cc_emails,'{}') else array[m.from_email] end) with ordinality as recipient(email,position)
    where recipient.email is not null and recipient.email <> ''
    order by ${selfAddressSql('recipient.email')},recipient.position limit 1) as counterparty`;
}

const LIST_COLUMNS = `m.id,m.thread_id,m.campaign_id,m.identity_key,m.direction,m.transport,m.purpose,m.state,
  m.subject,m.from_email,m.from_person_id,m.to_emails,m.cc_emails,m.recipient_email,m.person_id,
  m.body_preview,m.sent_at,m.created_at,m.accepted_at,m.delivered_at,m.bounced_at,m.opened_at,m.clicked_at,m.replied_at,
  m.crm_visible,m.has_attachments,m.gmail_message_id`;

// Filter value for mail with no identity_key (shown as "Other" in the account rail).
export const NO_IDENTITY = 'none';

function mailWhere(filters: MailFilters = {}) {
  const values: unknown[] = [];
  const where: string[] = [];
  const bind = (value: unknown) => { values.push(value); return `$${values.length}`; };
  for (const [key, column] of Object.entries({ identity: 'identity_key', campaign: 'campaign_id', thread: 'thread_id', direction: 'direction', transport: 'transport', purpose: 'purpose', state: 'state', mailboxOwnerId: 'mailbox_owner_id' })) {
    const value = filters[key as keyof MailFilters];
    if (key === 'identity' && value === NO_IDENTITY) where.push('m.identity_key is null');
    else if (value) where.push(`m.${column} = ${bind(value)}`);
  }
  if (filters.crmOnly && filters.view !== 'campaigns') where.push(filters.view === 'sent' ? '(m.crm_visible or m.campaign_id is not null)' : 'm.crm_visible');
  // Hide rebattery.io to rebattery.io mail by default. A message is internal when the sender and every recipient are on the exact domain; mixed messages stay visible.
  if (!filters.showInternal && filters.view !== 'campaigns') where.push(`not (${internalMessageSql('m')})`);
  if (filters.view === 'sent') where.push("m.direction = 'outbound'");
  if (filters.view === 'campaigns') where.push('m.campaign_id is not null');
  if (filters.view === 'followups') where.push("exists (select 1 from mail_followup f where (f.message_id = m.id or f.thread_id = m.thread_id) and f.state in ('pending','drafted','paused'))");
  if (filters.q) where.push(`to_tsvector('english',coalesce(m.subject,'') || ' ' || coalesce(m.body_text,m.body_preview,'')) @@ websearch_to_tsquery('english',${bind(filters.q)})`);
  if (filters.from) where.push(`m.from_email = ${bind(filters.from)}`);
  if (filters.to) { const p = bind(filters.to); where.push(`(${p} = any(m.to_emails) or ${p} = any(m.cc_emails) or ${p} = any(m.bcc_emails) or m.recipient_email = ${p})`); }
  if (filters.person) { const p = bind(filters.person); where.push(`(m.person_id = ${p} or m.from_person_id = ${p} or lower(m.from_email) = lower(${p}) or ${p} = any(m.to_emails) or lower(m.recipient_email) = lower(${p}) or exists (select 1 from mail_message_recipient r where r.message_id = m.id and r.person_id = ${p}))`); }
  if (filters.event) where.push(`(exists (select 1 from mail_event e where e.message_id = m.id and e.type = ${bind(filters.event)}) ${['opened','clicked','replied','bounced'].includes(filters.event) ? `or m.${filters.event}_at is not null` : ''})`);
  if (filters.since) where.push(`m.sent_at >= ${bind(filters.since)}::timestamptz`);
  if (filters.until) where.push(`m.sent_at <= ${bind(filters.until)}::timestamptz`);
  return { values, where, bind };
}

export async function searchMail(filters: MailFilters = {}): Promise<MailPage<MailMessageListRow>> {
  const { values, where, bind } = mailWhere(filters);
  let cursorWhere = '';
  const conversations = filters.view === 'conversations';
  if (filters.cursor) {
    let cursor: unknown;
    try { cursor = JSON.parse(Buffer.from(filters.cursor, 'base64url').toString()); } catch { throw new Error('invalid_cursor'); }
    if (!Array.isArray(cursor) || cursor.length !== 2 || typeof cursor[0] !== 'string' || !Number.isFinite(Date.parse(cursor[0])) || typeof cursor[1] !== 'string') throw new Error('invalid_cursor');
    cursorWhere = `(coalesce(m.sent_at,m.created_at),m.${conversations ? 'thread_id' : 'id'}) < (${bind(cursor[0])}::timestamptz,${bind(cursor[1])})`;
  }
  const limit = Math.max(1, Math.min(200, filters.limit || 50));
  const presentation = `${LIST_COLUMNS}, ${selfAddressSql('m.from_email')} as is_self, ${counterpartySql()}, coalesce(m.sent_at,m.created_at)::text as cursor_timestamp`;
  let sql: string;
  if (conversations) {
    const scope = [filters.mailboxOwnerId ? `m.mailbox_owner_id = ${bind(filters.mailboxOwnerId)}` : '', filters.crmOnly ? 'm.crm_visible' : ''].filter(Boolean);
    sql = `with scoped as materialized (select m.* from mail_message m ${scope.length ? `where ${scope.join(' and ')}` : ''}),
      matching as (select distinct m.thread_id from scoped m ${where.length ? `where ${where.join(' and ')}` : ''}),
      ranked as (select m.*,count(*) over (partition by m.thread_id)::int as message_count,
        row_number() over (partition by m.thread_id order by coalesce(m.sent_at,m.created_at) desc,m.id desc) as latest_rank
        from scoped m join matching on matching.thread_id=m.thread_id
        where exists (select 1 from scoped incoming where incoming.thread_id=m.thread_id and incoming.direction='inbound'))
      select ${presentation},m.message_count,
        coalesce((select jsonb_agg(jsonb_build_object('id',coalesce(p.id,addresses.email),'email',addresses.email,'name',p.full_name,'avatar_url',null,'is_self',${selfAddressSql('addresses.email')}))
          from (select distinct lower(address.email) as email from scoped member
            cross join lateral unnest(array[member.from_email,member.recipient_email] || member.to_emails || member.cc_emails) address(email)
            where member.thread_id=m.thread_id and address.email is not null and address.email <> '') addresses
          left join lateral (select id,full_name from crm_people where lower(email)=addresses.email order by id limit 1) p on true),'[]') as participants
      from ranked m where m.latest_rank=1 ${cursorWhere ? `and ${cursorWhere}` : ''}
      order by coalesce(m.sent_at,m.created_at) desc,m.thread_id desc limit ${bind(limit + 1)}`;
  } else {
    if (cursorWhere) where.push(cursorWhere);
    sql = `select ${presentation},coalesce((select jsonb_agg(e order by e.occurred_at,e.id) from mail_event e where e.message_id=m.id),'[]') as events
      from mail_message m ${where.length ? `where ${where.join(' and ')}` : ''}
      order by coalesce(m.sent_at,m.created_at) desc,m.id desc limit ${bind(limit + 1)}`;
  }
  const rows = await queryPg<MailMessageListRow & {cursor_timestamp:string}>(sql,values);
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify([last.cursor_timestamp, conversations ? last.thread_id : last.id])).toString('base64url') : null };
}

export async function mailIdentityCounts(filters: MailFilters = {}): Promise<{ identity_key: string | null; count: number }[]> {
  const { values, where } = mailWhere({ ...filters, identity: undefined, cursor: undefined });
  return queryPg<{ identity_key: string | null; count: number }>(`select m.identity_key,count(*)::int as count from mail_message m ${where.length ? `where ${where.join(' and ')}` : ''} group by m.identity_key order by count desc`, values);
}

export async function readMailThread(id: string, mailboxOwnerId?: string, crmOnly = false) {
  const values = mailboxOwnerId ? [id, mailboxOwnerId] : [id];
  const [thread] = await queryPg<Omit<MailThread, 'messages'>>(`select * from mail_thread where id = $1 ${mailboxOwnerId ? 'and mailbox_owner_id = $2::uuid' : ''}`, values);
  if (!thread) return null;
  const messages = await queryPg<MailMessageRow>(`select m.*, ${selfAddressSql('m.from_email')} as is_self, ${counterpartySql()}, coalesce(nullif(m.body_text,''),m.body_html) as body, m.body_preview as preview,
    coalesce((select jsonb_agg(e order by e.occurred_at,e.id) from mail_event e where e.message_id = m.id),'[]') as events,
    coalesce((select array_agg(r.person_id) from mail_message_recipient r where r.message_id = m.id and r.recipient_type = 'to'),'{}') as to_person_ids,
    coalesce((select array_agg(r.person_id) from mail_message_recipient r where r.message_id = m.id and r.recipient_type = 'cc'),'{}') as cc_person_ids
    from mail_message m where m.thread_id = $1 ${mailboxOwnerId ? 'and m.mailbox_owner_id = $2::uuid' : ''} ${crmOnly ? 'and m.crm_visible' : ''} order by m.sent_at asc nulls last,m.id`, values);
  if (!messages.length) return null;
  const people = await queryPg<MailParticipant>(`select id,full_name as name,email,null as avatar_url,${selfAddressSql('crm_people.email')} as is_self from crm_people where id in (select from_person_id from mail_message where thread_id = $1 union select r.person_id from mail_message_recipient r join mail_message m on m.id = r.message_id where m.thread_id = $1)`, [id]);
  return { ...thread, thread_id: id, messages, people };
}

export async function listMailFollowups(mailboxOwnerId?: string, dueOnly = false, filters: MailFilters = {}): Promise<MailFollowup[]> {
  const { identity, crmOnly, ...messageFilters } = filters;
  const { values, where, bind } = mailWhere(messageFilters);
  const conditions: string[] = [];
  const owner = mailboxOwnerId ? bind(mailboxOwnerId) : null;
  if (owner) conditions.push(`coalesce(anchor.mailbox_owner_id,t.mailbox_owner_id) = ${owner}::uuid`);
  if (crmOnly) conditions.push('coalesce(anchor.crm_visible,t.crm_visible,false)');
  if (identity) {
    const key = bind(identity);
    conditions.push(`(coalesce(f.identity_key,anchor.identity_key) = ${key} or (f.identity_key is null and f.message_id is null and exists (select 1 from mail_message identity_message where identity_message.thread_id = f.thread_id and identity_message.identity_key = ${key} ${owner ? `and identity_message.mailbox_owner_id = ${owner}::uuid` : ''})))`);
  }
  if (where.length) conditions.push(`exists (select 1 from mail_message m where (m.id = f.message_id or (f.message_id is null and m.thread_id = f.thread_id)) ${owner ? `and m.mailbox_owner_id = ${owner}::uuid` : ''} and ${where.join(' and ')})`);
  if (dueOnly) conditions.push("f.state = 'pending' and f.due_at <= now()");
  return queryPg<MailFollowup>(`select f.* from mail_followup f left join mail_message anchor on anchor.id = f.message_id left join mail_thread t on t.id = coalesce(f.thread_id,anchor.thread_id) ${conditions.length ? `where ${conditions.join(' and ')}` : ''} order by f.due_at,f.id`, values);
}

export async function mailCampaignCounts(id?: string, filters: MailFilters = {}): Promise<MailCampaignSummary[]> {
  const { values, where, bind } = mailWhere({...filters,view:undefined,crmOnly:false});
  const campaignWhere = id ? `c.id = ${bind(id)}` : "true";
  return queryPg<MailCampaignSummary>(`select c.id,c.campaign_name,c.identity_key,c.purpose,c.mail_state,count(m.id)::int as total,
    count(m.id) filter (where m.accepted_at is not null or m.sent_at is not null or m.state = 'accepted')::int as sent,
    count(m.delivered_at)::int as delivered,count(m.bounced_at)::int as bounced,count(m.opened_at)::int as opened,
    count(m.id) filter (where m.clicked_at is not null or exists (select 1 from mail_message_link l where l.message_id = m.id and l.first_clicked_at is not null))::int as clicked,
    count(m.id) filter (where exists (select 1 from mail_event e where e.message_id = m.id and e.type = 'unsubscribed'))::int as unsubscribed,
    count(m.id) filter (where m.replied_at is not null or exists (select 1 from mail_event e where e.message_id = m.id and e.type = 'replied')
      or exists (select 1 from mail_message reply where reply.direction = 'inbound' and reply.sent_at > m.accepted_at
        and lower(coalesce(reply.from_email,'')) not like '%@rebattery.io'
        and (lower(reply.from_email) = m.recipient_email or reply.from_person_id = m.person_id
          or exists (select 1 from crm_people fp where fp.id = reply.from_person_id
            and fp.company_id = coalesce(m.company_id,(select sp.company_id from crm_people sp where sp.id=m.person_id))))))::int as replied
    from campaigns c left join mail_message m on m.campaign_id = c.id and m.direction = 'outbound' where ${campaignWhere} ${where.length ? `and ${where.join(' and ')}` : ''} group by c.id order by c.id`, values);
}
export async function listMailCampaigns(filters: MailFilters = {}) {
  const [legacy, counts] = await Promise.all([listCampaigns(), mailCampaignCounts(undefined,filters)]);
  return legacy.filter(c => counts.some(n => n.id === c.id)).map(c => ({ ...c, ...counts.find(n => n.id === c.id) }));
}
export async function readMailCampaign(id: string, filters: MailFilters = {}) {
  const { values, where, bind } = mailWhere({...filters,view:'campaigns',crmOnly:false,campaign:id,direction:'outbound'});
  const predicate = where.join(' and ');
  const recipients = await queryPg<MailMessageListRow>(`select ${LIST_COLUMNS}, ${selfAddressSql('m.from_email')} as is_self from mail_message m where ${predicate} order by m.recipient_email,m.id`,values);
  const legacy = await getCampaignDetail(id,recipients.map(row => row.id));
  if (!legacy) return null;
  const [summary] = await mailCampaignCounts(id,filters);
  const counts = summary ?? {id,campaign_name:legacy.campaign.name,identity_key:null,purpose:null,mail_state:'legacy',total:0,sent:0,delivered:0,bounced:0,opened:0,clicked:0,unsubscribed:0,replied:0};
  const links = await queryPg(`select l.* from mail_message_link l join mail_message m on m.id = l.message_id where ${predicate} order by l.id`,values);
  const [evidence] = await queryPg<{scanner_evidence:boolean;proxy_evidence:boolean}>(`select coalesce(bool_or(e.detail->>'scanner' = 'true' or e.detail->>'scanner_evidence' = 'true' or (e.type = 'clicked' and m.delivered_at is not null and e.occurred_at between m.delivered_at and m.delivered_at + interval '10 seconds')),false) as scanner_evidence, coalesce(bool_or(e.detail->>'proxy' = 'true' or e.detail->>'proxy_evidence' = 'true' or e.detail::text ilike '%GoogleImageProxy%'),false) as proxy_evidence from mail_event e join mail_message m on m.id=e.message_id where ${predicate}`,values);
  return {...legacy,...counts,counts,delivery_rows:recipients,links,...evidence};
}

// Drafts are written by the rebattery-mail CLI without a mailbox owner, so they
// are shared by the signed-in team. Another user's owned messages stay hidden.
const DRAFT_STATES = "('draft','frozen')";

export async function readMailDraft(id: string, userId: string): Promise<MailDraft | null> {
  const [row] = await queryPg<Omit<MailDraft, 'links' | 'warnings' | 'approval'> & { personalization: { oneoff?: { warnings?: unknown[] } } | null }>(
    `select m.id,m.state,m.identity_key,m.transport,m.purpose,m.from_email,coalesce(m.to_emails,'{}') as to_emails,coalesce(m.cc_emails,'{}') as cc_emails,
       coalesce(m.bcc_emails,'{}') as bcc_emails,m.subject,m.body_text,m.body_html,m.thread_id,m.campaign_id,m.created_at,m.updated_at,m.personalization
     from mail_message m where m.id = $1 and m.direction = 'outbound' and (m.mailbox_owner_id is null or m.mailbox_owner_id = $2::uuid)`, [id, userId]);
  if (!row) return null;
  const links = await queryPg<{ cta_key: string; destination_url: string }>('select cta_key,destination_url from mail_message_link where message_id = $1 order by cta_key', [id]);
  const [approval] = await queryPg<MailApproval>(
    `select id,sha256,scope,approved_by,approved_at,expires_at,revoked_at,recipient_count from mail_approval
     where subject_type = 'message' and subject_id = $1 order by approved_at desc limit 1`, [id]);
  const { personalization, ...message } = row;
  const warnings = (personalization?.oneoff?.warnings ?? []).filter((w): w is string => typeof w === 'string');
  return { ...message, links, warnings, approval: approval ?? null };
}

export type MailDraftFilters = Pick<MailFilters, 'q' | 'identity' | 'to' | 'from' | 'purpose' | 'transport' | 'state' | 'since' | 'until'>;

export async function listMailDrafts(userId: string, limit = 50, filters: MailDraftFilters = {}): Promise<MailDraftListRow[]> {
  const values: unknown[] = [userId];
  const bind = (value: unknown) => { values.push(value); return `$${values.length}`; };
  const where = [`m.direction = 'outbound'`, `m.state in ${DRAFT_STATES}`, `(m.mailbox_owner_id is null or m.mailbox_owner_id = $1::uuid)`];
  for (const [key, column] of Object.entries({ identity: 'identity_key', purpose: 'purpose', transport: 'transport', from: 'from_email' })) {
    const value = filters[key as keyof MailDraftFilters];
    if (key === 'identity' && value === NO_IDENTITY) where.push('m.identity_key is null');
    else if (value) where.push(`m.${column} = ${bind(value)}`);
  }
  if (filters.state === 'draft' || filters.state === 'frozen') where.push(`m.state = ${bind(filters.state)}`);
  if (filters.to) { const p = bind(filters.to); where.push(`(${p} = any(m.to_emails) or ${p} = any(m.cc_emails) or ${p} = any(m.bcc_emails) or m.recipient_email = ${p})`); }
  if (filters.q) where.push(`to_tsvector('english',coalesce(m.subject,'') || ' ' || coalesce(m.body_text,m.body_preview,'')) @@ websearch_to_tsquery('english',${bind(filters.q)})`);
  if (filters.since) where.push(`m.created_at >= ${bind(filters.since)}::timestamptz`);
  if (filters.until) where.push(`m.created_at <= ${bind(filters.until)}::timestamptz`);
  const bound = bind(Math.max(1, Math.min(200, limit)));
  return queryPg<MailDraftListRow>(
    `select m.id,m.state,m.identity_key,m.from_email,coalesce(m.to_emails,'{}') as to_emails,m.subject,m.created_at,m.body_preview
     from mail_message m where ${where.join(' and ')} order by m.created_at desc, m.id limit ${bound}`, values);
}
