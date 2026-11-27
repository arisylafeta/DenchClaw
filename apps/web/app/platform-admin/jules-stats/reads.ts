import "server-only";

import { unstable_noStore as noStore } from "next/cache";
import { ALLOWED_EMAILS, currentUser } from "@/lib/auth";
import { queryPg } from "@/lib/postgres";
import { getSupabaseAdminClient } from "@/lib/platform-admin/supabase";
import {
  buildJulesStats,
  leadEmails,
  type JulesStats,
  type MailActivity,
  type RawEvent,
  type RawLead,
  type RawMessage,
  type RawSession,
  type RawTurnError,
} from "./metrics";

/** Funnel, health and follow-up windows cover two weeks. */
const WINDOW_DAYS = 14;
/**
 * Contacts are older than the funnel: "waiting on us" looks at every recent sales lead,
 * the way scripts/jules_waiting_on_us.py does, not only last fortnight's chats.
 */
const CONTACT_DAYS = 120;
const PAGE_SIZE = 1000;
const MAX_PAGES = 20;

type QueryResult = { data: unknown[] | null; error: { message?: string } | null };

/**
 * Minimal structural view of the Supabase select builder. The copied generated types
 * lag the platform schema (jules_sessions and intake_leads are missing), so the client
 * is narrowed here rather than casting every call site.
 */
interface SelectBuilder extends PromiseLike<QueryResult> {
  select(columns: string): SelectBuilder;
  gte(column: string, value: string): SelectBuilder;
  eq(column: string, value: string): SelectBuilder;
  in(column: string, values: readonly string[]): SelectBuilder;
  or(filter: string): SelectBuilder;
  order(column: string, options: { ascending: boolean }): SelectBuilder;
  range(from: number, to: number): SelectBuilder;
}

type UntypedClient = { from(table: string): { select(columns: string): SelectBuilder } };

type MailRow = {
  email: string | null;
  last_inbound_at: string | null;
  last_subject: string | null;
  last_thread: string | null;
  last_outbound_at: string | null;
  first_outbound_at: string | null;
  hand_answered_at: string | null;
  thread_owner: string | null;
};

/**
 * Everything the "waiting on us" rule needs per lead address, in the same shape
 * `scripts/jules_waiting_on_us.py` reads: the newest inbound mail with its subject and
 * thread, our newest and first mail, any founder mailbox reply, and who owns the thread.
 * The rules themselves live in `metrics.countWaitingOnUs`, so both sides of the count
 * (whether a person is waiting, and why not) are testable.
 */
export const WAITING_SQL = `
with wanted as (select distinct lower(email) as email from unnest($1::text[]) as addresses(email)),
received as (
  select lower(m.from_email) as email,
    max(coalesce(m.sent_at, m.created_at)) as last_inbound_at,
    (array_agg(coalesce(m.subject, '') order by coalesce(m.sent_at, m.created_at) desc))[1] as last_subject,
    (array_agg(coalesce(m.thread_id, '') order by coalesce(m.sent_at, m.created_at) desc))[1] as last_thread
  from mail_message m
  where m.direction = 'inbound' and lower(m.from_email) = any($1::text[])
  group by 1
),
sent as (
  select lower(recipient.email) as email,
    max(coalesce(m.sent_at, m.created_at)) as last_outbound_at
  from mail_message m
  cross join lateral unnest(array[m.recipient_email] || m.to_emails) as recipient(email)
  where m.direction = 'outbound' and m.state in ('accepted', 'sending', 'approved')
    and lower(recipient.email) = any($1::text[])
  group by 1
),
first_out as (
  -- First contact counts every outbound row, as scripts/jules_waiting_on_us.py does: a draft or
  -- a failed send still means we had started with the person before their old mail arrived.
  select lower(recipient.email) as email, min(coalesce(m.sent_at, m.created_at)) as first_outbound_at
  from mail_message m
  cross join lateral unnest(array[m.recipient_email] || m.to_emails) as recipient(email)
  where m.direction = 'outbound' and lower(recipient.email) = any($1::text[])
  group by 1
),
hand as (
  select lower(recipient.email) as email, max(coalesce(m.sent_at, m.created_at)) as hand_answered_at
  from mail_message m
  cross join lateral unnest(array[m.recipient_email] || m.to_emails) as recipient(email)
  where m.direction = 'outbound' and m.state in ('accepted', 'sending', 'approved')
    and lower(coalesce(m.from_email, '')) in ('alex@rebattery.io', 'ari@rebattery.io')
    and lower(recipient.email) = any($1::text[])
  group by 1
)
select w.email, r.last_inbound_at, r.last_subject, r.last_thread,
  s.last_outbound_at, f.first_outbound_at, h.hand_answered_at,
  nullif(o.profile, '') as thread_owner
from wanted w
left join received r on r.email = w.email
left join sent s on s.email = w.email
left join first_out f on f.email = w.email
left join hand h on h.email = w.email
left join mail_thread_owner o on o.thread_id = nullif(r.last_thread, '')
`;

export type QueryRows = (sql: string, params: readonly unknown[]) => Promise<Record<string, unknown>[]>;

export async function readMailActivity(
  emails: string[],
  run: QueryRows = queryPg as QueryRows,
): Promise<MailActivity[]> {
  if (emails.length === 0) {
    return [];
  }
  const rows = (await run(WAITING_SQL, [emails])) as MailRow[];
  return rows
    .filter((row): row is MailRow & { email: string } => typeof row.email === "string" && row.email.length > 0)
    .map((row) => ({
      email: row.email.toLowerCase(),
      lastInboundAt: row.last_inbound_at ? new Date(row.last_inbound_at).toISOString() : null,
      lastSubject: row.last_subject ?? null,
      lastOutboundAt: row.last_outbound_at ? new Date(row.last_outbound_at).toISOString() : null,
      firstOutboundAt: row.first_outbound_at ? new Date(row.first_outbound_at).toISOString() : null,
      handAnsweredAt: row.hand_answered_at ? new Date(row.hand_answered_at).toISOString() : null,
      threadOwner: row.thread_owner ?? null,
    }));
}

/** Every page of a Supabase select, following the Range until the table is exhausted. */
async function fetchAll<T>(
  table: string,
  columns: string,
  filters: (builder: SelectBuilder) => SelectBuilder,
): Promise<T[]> {
  const client = getSupabaseAdminClient() as unknown as UntypedClient;
  const rows: T[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const builder = filters(
      client.from(table).select(columns).range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1),
    );
    const { data, error } = await builder;
    if (error) {
      throw new Error("Unable to read Jules activity");
    }
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) {
      return rows;
    }
  }
  throw new Error("Jules activity is larger than this page can read");
}

export async function loadJulesStats(): Promise<JulesStats> {
  noStore();
  const user = await currentUser();
  if (!user || !ALLOWED_EMAILS.has(user.email.toLowerCase())) {
    throw new Error("Unauthorized");
  }

  const now = new Date();
  const since = new Date(now.getTime() - WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
  const contactsSince = new Date(now.getTime() - CONTACT_DAYS * 24 * 3600 * 1000).toISOString();

  const [sessions, leads, events, messages, turnErrors] = await Promise.all([
    fetchAll<RawSession>(
      "jules_sessions",
      "id, source_surface, created_at, contact_email, account_id, created_by_user_id, owner_auth_user_id",
      (builder) =>
        // Every chat, not just the window: first contact and the person's first chat must match
        // scripts/jules_waiting_on_us.py, which reads all of them. buildWindow filters by date.
        builder
          .order("created_at", { ascending: true })
          .order("id", { ascending: true }),
    ),
    fetchAll<RawLead>(
      "intake_leads",
      "conversation_id, channel_mode, stage, contact_email, ready_to_publish, listing_status, first_seen_at, discarded_at",
      (builder) =>
        builder
          .or(`first_seen_at.gte.${contactsSince},discarded_at.gte.${contactsSince}`)
          .order("id", { ascending: true }),
    ),
    fetchAll<RawEvent>(
      "intake_lead_events",
      "conversation_id, kind, at",
      (builder) =>
        builder
          // Funnel emails and replies, the platform's own first-contact emails, and the
          // app-written `price_shown` rows. One read covers the funnel and "waiting on us".
          .in("kind", ["team_email_sent", "follow_up_sent", "seller_email_reply", "received_email_sent", "finish_email_sent", "price_shown"])
          // No date bound: the first-contact kinds must come from the chat's whole history, as in
          // scripts/jules_waiting_on_us.py. Funnel and price counts filter by window themselves.
          .order("at", { ascending: true })
          .order("id", { ascending: true }),
    ),
    fetchAll<RawMessage>(
      "jules_messages",
      "session_id, role, created_at, body",
      (builder) =>
        builder
          .gte("created_at", since)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true }),
    ),
    fetchAll<RawTurnError>(
      "jules_events",
      "session_id, emitted_at",
      (builder) =>
        builder
          .eq("event_type", "turn.failed")
          .gte("emitted_at", since)
          .order("id", { ascending: true }),
    ),
  ]);

  const addresses = leadEmails({ sessions, leads, events, messages, turnErrors, mail: [] });
  const mail = await readMailActivity(addresses);

  return buildJulesStats({ now, sessions, leads, events, messages, turnErrors, mail });
}
