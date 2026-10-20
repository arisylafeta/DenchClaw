import { randomUUID } from "node:crypto";
import { queryPg, withPgTransaction } from "../postgres";

/** Current two-operator deployment. Replace here with the later role flag. */
export function canReadWhatsapp(user: unknown): boolean {
  return Boolean(user);
}
export function whatsappPagination(limit = 50, offset = 0) {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    !Number.isInteger(offset) ||
    offset < 0
  ) {
    throw new Error("invalid_pagination");
  }
  return { limit, offset };
}
export type WhatsappThread = {
  id: string;
  kind: "direct" | "group";
  subject: string | null;
  last_captured_at: string;
  message_count: string;
  shared_context: boolean;
  metadata: Record<string, unknown>;
};
export type WhatsappMessage = {
  id: string;
  direction: string | null;
  body: string | null;
  sender_name: string | null;
  sender_person_name: string | null;
  attachment: Record<string, unknown> | null;
  occurred_at: string | null;
  captured_at: string;
  timestamp_source: string;
  reply_to_provider_id: string | null;
  reply_to_message_id: string | null;
  reply_body: string | null;
  edit_version: number;
  deleted_at: string | null;
  metadata: Record<string, unknown>;
};
export async function whatsappThreads(
  context: { personId?: string; companyId?: string; tradeId?: string },
  limit = 50,
  offset = 0,
) {
  whatsappPagination(limit, offset);
  const threads = await queryPg<WhatsappThread>(
    `select t.*, (t.kind='group') as shared_context,
    (select count(*) from whatsapp_message m where m.thread_id=t.id) as message_count
    from whatsapp_thread t where
    ($3::text is not null and exists(select 1 from crm_bulk_trade_evidence_links e
      left join whatsapp_message m on e.evidence_kind='whatsapp_live_message' and m.id=e.evidence_id
      where e.lot_id=$3 and ((e.evidence_kind='whatsapp_live_thread' and e.evidence_id=t.id) or m.thread_id=t.id)))
    or (($1::text is not null or $2::text is not null) and exists (
      select 1 from whatsapp_identity_link l left join crm_people p on p.id=l.person_id
      where l.account_id=t.account_id and l.valid_to is null
      and (($1::text is not null and l.person_id=$1) or ($2::text is not null and (l.company_id=$2 or p.company_id=$2)))
      and (l.identity_id=t.identity_id or exists(select 1 from whatsapp_thread_member tm where tm.thread_id=t.id and tm.identity_id=l.identity_id))))
    order by t.last_captured_at desc,t.id limit $4 offset $5`,
    [context.personId ?? null, context.companyId ?? null, context.tradeId ?? null, limit, offset],
  );
  return { threads, limit, offset };
}
export type WhatsappInboxRow = {
  id: string; kind: "direct" | "group"; name: string | null; last_captured_at: string; message_count: number;
  last_body: string | null; last_direction: string | null; last_at: string | null;
};
/** Every captured chat, newest first, with a display name and the latest visible message for a list row. */
export async function whatsappInbox(limit = 50, offset = 0) {
  whatsappPagination(limit, offset);
  const threads = await queryPg<WhatsappInboxRow>(
    `select t.id,t.kind,t.last_captured_at,
      coalesce(nullif(t.subject,''),nullif(i.display_name,''),i.e164,
        (select p.full_name from whatsapp_identity_link l join crm_people p on p.id=l.person_id where l.account_id=t.account_id and l.identity_id=t.identity_id and l.valid_to is null order by l.valid_from desc limit 1),
        (select string_agg(distinct coalesce(nullif(mi.display_name,''),mi.e164),', ') from whatsapp_thread_member tm
          join whatsapp_identity mi on mi.account_id=tm.account_id and mi.id=tm.identity_id where tm.thread_id=t.id and not mi.shared)) as name,
      (select count(*)::int from whatsapp_message m where m.thread_id=t.id) as message_count,
      lm.body as last_body,lm.direction as last_direction,coalesce(lm.occurred_at,lm.captured_at) as last_at
    from whatsapp_thread t
    left join whatsapp_identity i on i.account_id=t.account_id and i.id=t.identity_id
    left join lateral (select ${visibleBody("m")} as body,m.direction,m.occurred_at,m.captured_at from whatsapp_message m where m.thread_id=t.id
      order by coalesce(m.occurred_at,m.captured_at) desc,m.id desc limit 1) lm on true
    order by t.last_captured_at desc,t.id limit $1 offset $2`,
    [limit, offset],
  );
  return { threads, limit, offset };
}
export type WhatsappConversationData = {
  thread: WhatsappThread;
  messages: WhatsappMessage[];
  capture_status: Record<string, unknown> | null;
  history_complete: boolean;
  limit: number;
  offset: number;
};
const visibleBody = (alias: string) =>
  `case when ${alias}.deleted_at is not null or (${alias}.metadata->'flags'->>'viewOnce')::boolean is true or nullif(${alias}.metadata->'flags'->>'expiresAt','')::timestamptz <= now() then null else ${alias}.body end`;
export async function whatsappConversation(id: string, limit = 50, offset = 0) {
  whatsappPagination(limit, offset);
  const [thread] = await queryPg<WhatsappThread>(`select * from whatsapp_thread where id=$1`, [id]);
  if (!thread) {
    return null;
  }
  const messages = await queryPg<WhatsappMessage>(
    `select m.*, ${visibleBody("m")} as body,
    i.display_name as sender_name,
    case when not i.shared and (select count(*) from whatsapp_identity_link l where l.identity_id=i.id and l.valid_to is null)=1
      then (select p.full_name from whatsapp_identity_link l join crm_people p on p.id=l.person_id where l.identity_id=i.id and l.valid_to is null limit 1) end as sender_person_name,
    ${visibleBody("r")} as reply_body
    from whatsapp_message m left join whatsapp_identity i on i.id=m.sender_identity_id
    left join whatsapp_message r on r.thread_id=m.thread_id and r.provider_message_id=m.reply_to_provider_id
    where m.thread_id=$1 order by m.occurred_at,m.id limit $2 offset $3`,
    [id, limit, offset],
  );
  const [account] = await queryPg<{ capture_status: Record<string, unknown> | null }>(
    `select a.metadata->'capture_status' as capture_status from whatsapp_account a join whatsapp_thread t on t.account_id=a.id where t.id=$1`,
    [id],
  );
  return {
    thread,
    messages,
    capture_status: account?.capture_status ?? null,
    history_complete: false,
    limit,
    offset,
  };
}
export type WhatsappIdentityReview = {
  id: string;
  display_name: string | null;
  e164: string | null;
  canonical_jid: string;
  shared: boolean;
  threads: Array<{ id: string; subject: string | null; kind: string }>;
  links: Array<{
    id: string;
    person_id: string | null;
    company_id: string | null;
    name: string | null;
    confidence: string;
  }>;
  candidates: Array<{ id: string; name: string | null }>;
};
export async function whatsappIdentities(limit = 50, offset = 0) {
  whatsappPagination(limit, offset);
  const identities = await queryPg<WhatsappIdentityReview>(
    `select i.id,i.display_name,i.e164,i.canonical_jid,i.shared,
    coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'subject',t.subject,'kind',t.kind)) from whatsapp_thread t where t.identity_id=i.id or exists(select 1 from whatsapp_thread_member tm where tm.thread_id=t.id and tm.identity_id=i.id)),'[]') as threads,
    coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'person_id',l.person_id,'company_id',l.company_id,'name',coalesce(p.full_name,c.name),'confidence',l.confidence)) from whatsapp_identity_link l left join crm_people p on p.id=l.person_id left join crm_companies c on c.id=l.company_id where l.identity_id=i.id and l.valid_to is null),'[]') as links,
    coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.full_name)) from crm_people p where i.e164 is not null and p.phone=i.e164),'[]') as candidates
    from whatsapp_identity i order by exists(select 1 from whatsapp_identity_link l where l.identity_id=i.id and l.valid_to is null),i.created_at,i.id limit $1 offset $2`,
    [limit, offset],
  );
  return { identities, limit, offset };
}
/** Manual decisions mirror rebattery_whatsapp.identity.link/unlink. No CRM phone edits. */
export async function decideWhatsappIdentity(
  identityId: string,
  input: { personId?: string; companyId?: string; unlinkId?: string; shared?: boolean },
  actor: string,
) {
  return withPgTransaction(async (client) => {
    const identity = (
      await client.query(`select * from whatsapp_identity where id=$1 for update`, [identityId])
    ).rows[0];
    if (!identity) {
      throw new Error("unknown_identity");
    }
    if (input.unlinkId) {
      const result = await client.query(
        `update whatsapp_identity_link set valid_to=now(),evidence=evidence || $3::jsonb where id=$1 and identity_id=$2 and valid_to is null returning id`,
        [input.unlinkId, identityId, JSON.stringify({ revoked_by: actor })],
      );
      if (!result.rows[0]) {
        throw new Error("active_link_not_found");
      }
      return result.rows[0];
    }
    const person = input.personId || null,
      company = input.companyId || null;
    if (!person && !company) {
      throw new Error("target_required");
    }
    const active = (
      await client.query(
        `select * from whatsapp_identity_link where identity_id=$1 and valid_to is null`,
        [identityId],
      )
    ).rows;
    const same = active.find((l) => l.person_id === person && l.company_id === company);
    if (same) {
      return { id: same.id };
    }
    if (active.length && !input.shared && !identity.shared) {
      throw new Error("identity_already_linked");
    }
    if (input.shared || (company && !person)) {
      await client.query(`update whatsapp_identity set shared=true where id=$1`, [identityId]);
    }
    const id = randomUUID().replaceAll("-", "");
    await client.query(
      `insert into whatsapp_identity_link(id,account_id,identity_id,person_id,company_id,method,confidence,evidence,actor) values($1,$2,$3,$4,$5,'manual','confirmed',$6::jsonb,$7)`,
      [
        id,
        identity.account_id,
        identityId,
        person,
        company,
        JSON.stringify({
          validated_e164: identity.e164,
          exact_single_match: false,
          confirmed: true,
          shared: Boolean(input.shared),
        }),
        actor,
      ],
    );
    return { id };
  });
}
