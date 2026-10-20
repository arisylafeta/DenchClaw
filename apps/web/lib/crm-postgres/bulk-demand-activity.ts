import { queryPg } from "../postgres";

export const ACTIVITY_KINDS = ["note", "research", "outreach", "call", "quote", "supply", "status", "document", "mail", "whatsapp"] as const;
export const ACTIVITY_REF_KINDS = ["lot", "supply", "stock", "email", "person", "company", "url"] as const;
export type DemandActivity = {
  id: string;
  demand_id: string;
  kind: typeof ACTIVITY_KINDS[number];
  title: string;
  body: string | null;
  ref_kind: typeof ACTIVITY_REF_KINDS[number] | null;
  ref_id: string | null;
  data: Record<string, unknown>;
  actor_user_id: string | null;
  occurred_at: string;
  created_at: string;
};
export type DemandActivityInput = {
  demandId: string;
  kind: DemandActivity["kind"];
  title: string;
  body?: string | null;
  refKind?: DemandActivity["ref_kind"];
  refId?: string | null;
  data?: Record<string, unknown>;
  occurredAt?: string;
  actorUserId?: string | null;
};
const SELECT = `select id::text, bulk_listing_id as demand_id, kind, title, body, ref_kind, ref_id, data, actor_user_id,
  occurred_at::text, created_at::text from crm_bulk_listing_activity`;

export async function listDemandActivity(demandId: string): Promise<DemandActivity[]> {
  return queryPg<DemandActivity>(`${SELECT} where bulk_listing_id = $1 order by occurred_at desc, crm_bulk_listing_activity.id desc`, [demandId]);
}

export async function addDemandActivity(input: DemandActivityInput): Promise<DemandActivity> {
  const [row] = await queryPg<DemandActivity>(
    `insert into crm_bulk_listing_activity (bulk_listing_id, kind, title, body, ref_kind, ref_id, data, occurred_at, actor_user_id)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, coalesce($8::timestamptz, now()), $9)
     returning id::text, bulk_listing_id as demand_id, kind, title, body, ref_kind, ref_id, data, actor_user_id, occurred_at::text, created_at::text`,
    [input.demandId, input.kind, input.title.trim(), input.body ?? null, input.refKind ?? null, input.refId ?? null,
      JSON.stringify(input.data ?? {}), input.occurredAt ?? null, input.actorUserId ?? null],
  );
  return row;
}

export async function deleteDemandActivity(demandId: string, id: string): Promise<boolean> {
  return (await queryPg("delete from crm_bulk_listing_activity where bulk_listing_id = $1 and id = $2 returning id", [demandId, id])).length > 0;
}
