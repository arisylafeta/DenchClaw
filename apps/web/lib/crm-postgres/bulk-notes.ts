import "server-only";
import { queryPg } from "../postgres";
import { DEAL_OWNERS, type DealOwner } from "../bulk-owner";
import { mentionsIn, type Mention } from "../bulk-today";
import { asStageActor } from "./bulk-stage-events";

/**
 * Team notes on a deal (slice 3, B5): crm_bulk_listing_activity rows of kind 'note' with the people mentioned in
 * data.mentions and their ticks in data.ticked. A mention shows on that person's Today until they tick it. Nothing is
 * sent: no email, no WhatsApp.
 */

/** Which of the three a signed-in user is: by the first word of their display name, else their address before the @. */
export function ownerFor(user: { email: string; display_name?: string | null }): DealOwner | null {
  const words = [(user.display_name ?? "").trim().split(/\s+/)[0], user.email.split("@")[0].split(/[._+-]/)[0]];
  return DEAL_OWNERS.find((owner) => words.some((word) => word?.toLowerCase() === owner.toLowerCase())) ?? null;
}

export async function ownerOfUser(userId: string): Promise<DealOwner | null> {
  const [user] = await queryPg<{ email: string; display_name: string | null }>("select email, display_name from crm_users where id = $1::uuid", [userId]);
  return user ? ownerFor(user) : null;
}

const MENTION_COLUMNS = `a.id::text, a.bulk_listing_id as listing_id,
  coalesce(nullif(l.context->>'listing_title', ''), nullif(l.spec->>'listing_title', ''), l.summary) as listing_title,
  coalesce(a.body, a.title) as text, a.data->>'by' as by, a.occurred_at::text as at,
  coalesce(a.data->'mentions', '[]'::jsonb) as mentions, coalesce(a.data->'ticked', '{}'::jsonb) as ticked`;

/** Adds a team note; every @Alex, @Sean or @Ari in it is a mention. */
export async function addTeamNote(listingId: string, text: string, actor: { userId: string; email: string }): Promise<Mention> {
  const body = text.trim().slice(0, 4000);
  const title = body.split("\n")[0].slice(0, 120) || "Note";
  const mentions = mentionsIn(body);
  const [row] = await queryPg<{ id: string }>(
    `insert into crm_bulk_listing_activity (bulk_listing_id, kind, title, body, actor_user_id, data)
     values ($1, 'note', $2, $3, $4::uuid, $5::jsonb) returning id::text`,
    [listingId, title, body, actor.userId, JSON.stringify({ team_note: true, by: actor.email, mentions, ticked: {} })]);
  const [mention] = await queryPg<Mention>(`select ${MENTION_COLUMNS} from crm_bulk_listing_activity a join crm_bulk_listings l on l.id = a.bulk_listing_id where a.id = $1::bigint`, [row.id]);
  return mention;
}

/** One deal's team notes, newest first. */
export async function listTeamNotes(listingId: string): Promise<Mention[]> {
  return queryPg<Mention>(
    `select ${MENTION_COLUMNS} from crm_bulk_listing_activity a join crm_bulk_listings l on l.id = a.bulk_listing_id
     where a.bulk_listing_id = $1 and a.kind = 'note' and a.data->>'team_note' = 'true' order by a.occurred_at desc, a.id desc limit 100`, [listingId]);
}

/** Mentions of one person they have not ticked yet, newest first. */
export async function openMentionsFor(person: DealOwner): Promise<Mention[]> {
  return queryPg<Mention>(
    `select ${MENTION_COLUMNS} from crm_bulk_listing_activity a join crm_bulk_listings l on l.id = a.bulk_listing_id
     where a.kind = 'note' and a.data ? 'mentions' and a.data->'mentions' ? $1 and not coalesce(a.data->'ticked', '{}'::jsonb) ? $1
     order by a.occurred_at desc, a.id desc limit 100`, [person]);
}

/** The person ticks a mention of them: it leaves their Today. Only the person mentioned can tick it. */
export async function tickMention(activityId: string, person: DealOwner): Promise<boolean> {
  if (!/^\d+$/.test(activityId)) return false;
  const rows = await queryPg<{ id: string }>(
    `update crm_bulk_listing_activity set data = jsonb_set(jsonb_set(data, '{ticked}', coalesce(data->'ticked', '{}'::jsonb)), array['ticked', $2::text], to_jsonb(now()::text))
     where id = $1::bigint and kind = 'note' and data->'mentions' ? $2 returning id::text`, [activityId, person]);
  return rows.length > 0;
}

/** Closing reasons Today's "Remove" offers for a deal stuck in New. */
export const STUCK_REASONS = ["not_a_fit", "no_longer_needed", "duplicate", "other"] as const;
export type StuckReason = (typeof STUCK_REASONS)[number];

/** "Stuck in New", remove: closes the listing with the reason chosen and the person's words in its Story. It can be reopened. */
export async function removeStuckListing(listingId: string, reason: StuckReason, why: string, actor: { userId: string; email: string }): Promise<boolean> {
  return asStageActor(actor.userId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "update crm_bulk_listings set status = 'closed', closed_reason = $2, updated_at = now() where id = $1 and status <> 'closed' returning id", [listingId, reason]);
    if (!rows.length) return false;
    await tx.query(
      `insert into crm_bulk_listing_activity (bulk_listing_id, kind, title, body, actor_user_id, data) values ($1, 'status', 'Removed from New', $2, $3::uuid, $4::jsonb)`,
      [listingId, `${why.trim().slice(0, 1000)}\n\nClosed by ${actor.email} from Today's "Stuck in New".`, actor.userId, JSON.stringify({ closed_reason: reason, from: "stuck_in_new" })]);
    return true;
  });
}
