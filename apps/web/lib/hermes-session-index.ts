import { queryPg } from "./postgres";
import { accessFor, externalSources, ConversationAccessError, type ConversationActor } from "./conversation-access";
import type { ConversationAccess } from "./conversation-access";

/**
 * Postgres index of Hermes session metadata. The chat list reads it instead of walking every upstream session
 * (a profile can hold thousands, and a user who sees few of them walked all of them). New sessions are picked up
 * from the newest upstream page on every list; a full walk fills and prunes the index in the background.
 */
export type IndexedSession = { id: string; source?: string; title?: string; last_active?: number; started_at?: number; hidden?: boolean; is_internal_child?: boolean };
type Page = { data: IndexedSession[] };
/** Fetches one upstream page of a profile's sessions (injected: hermes-native owns the upstream connection). */
export type PageFetcher = (profile: string, offset: number, limit: number) => Promise<Page>;

const PAGE = 200;
const RECENT_TTL_MS = 3_000;
const FULL_TTL_MS = 10 * 60_000;
const recent = new Map<string, { at: number; pending: Promise<void> }>();
const full = new Map<string, { at: number; pending: Promise<void> | null }>();

async function upsert(profile: string, rows: IndexedSession[]) {
  if (!rows.length) { return; }
  await queryPg(`insert into hermes_security.session_index(profile,stored_id,source,title,last_active,started_at,hidden,is_internal_child,synced_at)
    select $1, r.id, r.source, r.title, coalesce(r.last_active,0), coalesce(r.started_at,0), coalesce(r.hidden,false), coalesce(r.is_internal_child,false), now()
    from jsonb_to_recordset($2::jsonb) as r(id text, source text, title text, last_active double precision, started_at double precision, hidden boolean, is_internal_child boolean)
    where r.id is not null and r.id <> ''
    on conflict (profile, stored_id) do update set source=excluded.source, title=excluded.title, last_active=excluded.last_active,
      started_at=excluded.started_at, hidden=excluded.hidden, is_internal_child=excluded.is_internal_child, synced_at=now()`,
  [profile, JSON.stringify(rows)]);
}

/** Newest upstream page: keeps new and renamed chats visible immediately. Shared by concurrent lists. */
function refreshRecent(profile: string, fetchPage: PageFetcher): Promise<void> {
  const cached = recent.get(profile);
  if (cached && Date.now() - cached.at < RECENT_TTL_MS) { return cached.pending; }
  const pending = (async () => { await upsert(profile, (await fetchPage(profile, 0, PAGE)).data); })();
  recent.set(profile, { at: Date.now(), pending });
  pending.catch(() => recent.delete(profile));
  return pending;
}

/** Walks every upstream page, upserts it, then drops index rows the profile no longer has. */
function fullSync(profile: string, fetchPage: PageFetcher): Promise<void> {
  const state = full.get(profile) ?? { at: 0, pending: null };
  if (state.pending) { return state.pending; }
  const started = new Date();
  const pending = (async () => {
    for (let offset = 0; offset < 100_000; offset += PAGE) {
      const page = await fetchPage(profile, offset, PAGE);
      await upsert(profile, page.data);
      if (page.data.length < PAGE) { break; }
    }
    await queryPg("delete from hermes_security.session_index where profile=$1 and synced_at < $2", [profile, started.toISOString()]);
    state.at = Date.now();
  })().finally(() => { state.pending = null; });
  state.pending = pending;
  full.set(profile, state);
  return pending;
}

async function indexed(profile: string) {
  const rows = await queryPg<{ n: string }>("select count(*)::text as n from hermes_security.session_index where profile=$1", [profile]);
  return Number(rows[0]?.n ?? 0) > 0;
}

/** Makes the index current enough to list: newest page inline, full walk inline only when the profile was never indexed. */
export async function syncProfileIndex(profile: string, fetchPage: PageFetcher) {
  if (!await indexed(profile)) { await fullSync(profile, fetchPage); return; }
  await refreshRecent(profile, fetchPage);
  const state = full.get(profile);
  if (!state || Date.now() - state.at > FULL_TTL_MS) { void fullSync(profile, fetchPage).catch(() => undefined); }
}

type IndexRow = { stored_id: string; source: string | null; title: string | null; last_active: number; started_at: number;
  owner_id: string | null; creator_id: string | null; origin: string; visibility: "private" | "team"; version: string | number; deleted_at: string | null };

/** Newest sessions of one profile the actor may see (own, team-shared, external), plus pinned ones. */
export async function listIndexedSessions(actor: ConversationActor, profile: string, limit: number, pinned: string[], search = ""): Promise<Array<{ session: IndexedSession; access: ConversationAccess }>> {
  try { return await listIndexed(actor, profile, limit, pinned, search); }
  catch (error) { if (error instanceof ConversationAccessError) { throw error; } throw new ConversationAccessError(503, "conversation_access_unavailable"); }
}
async function listIndexed(actor: ConversationActor, profile: string, limit: number, pinned: string[], search: string): Promise<Array<{ session: IndexedSession; access: ConversationAccess }>> {
  // External sources are team-visible by definition; register any the index has seen that the ACL has not.
  await queryPg(`insert into hermes_security.conversation_access(kind,profile,stored_id,origin,visibility)
    select 'solo', i.profile, i.stored_id, i.source, 'team' from hermes_security.session_index i
    where i.profile=$1 and i.source = any($2::text[]) and not i.hidden and not i.is_internal_child
      and not exists (select 1 from hermes_security.conversation_access a where a.kind='solo' and a.profile=i.profile and a.stored_id=i.stored_id)
    on conflict do nothing`, [profile, [...externalSources]]);
  const rows = await queryPg<IndexRow>(`select * from (
      select i.stored_id, i.source, i.title, i.last_active, i.started_at, a.owner_id, a.creator_id, a.origin, a.visibility, a.version, a.deleted_at,
        row_number() over (order by greatest(i.last_active, i.started_at) desc) as rank
      from hermes_security.session_index i
      join hermes_security.conversation_access a on a.kind='solo' and a.profile=i.profile and a.stored_id=i.stored_id
      where i.profile=$1 and not i.hidden and not i.is_internal_child and coalesce(i.source,'') <> 'bot_room'
        and a.deleted_at is null and (a.owner_id=$2 or a.visibility='team')
        and ($5::text = '' or i.title ilike '%' || $5 || '%' escape '\')
    ) t where rank <= $3 or stored_id = any($4::text[]) order by rank`, [profile, actor.id, limit, pinned, search.replace(/[\\%_]/g, "\\$&")]);
  return rows.map(row => ({
    session: { id: row.stored_id, source: row.source ?? undefined, title: row.title ?? undefined, last_active: row.last_active || undefined, started_at: row.started_at || undefined },
    access: accessFor({ owner_id: row.owner_id, creator_id: row.creator_id, origin: row.origin, visibility: row.visibility, version: Number(row.version), deleted_at: row.deleted_at }, actor),
  }));
}
