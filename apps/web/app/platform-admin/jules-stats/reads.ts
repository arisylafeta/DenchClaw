import "server-only";

import { unstable_noStore as noStore } from "next/cache";
import { ALLOWED_EMAILS, currentUser } from "@/lib/auth";
import { queryPg } from "@/lib/postgres";
import { getSupabaseAdminClient } from "@/lib/platform-admin/supabase";
import {
  buildJulesStats,
  leadEmails,
  type JulesStats,
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

type MailRow = { email: string | null; last_inbound_at: string | null; last_outbound_at: string | null };

/**
 * Last inbound and last outbound mail per address. Same rule as
 * scripts/jules_waiting_on_us.py, in one query for every lead address.
 */
export const WAITING_SQL = `
with wanted as (select distinct lower(email) as email from unnest($1::text[]) as email)
select w.email,
  (select max(coalesce(m.sent_at, m.created_at)) from mail_message m
    where m.direction = 'inbound' and lower(m.from_email) = w.email) as last_inbound_at,
  (select max(coalesce(m.sent_at, m.created_at)) from mail_message m
    where m.direction = 'outbound' and m.state in ('accepted', 'sending', 'approved')
      and (lower(m.recipient_email) = w.email
        or exists (select 1 from unnest(m.to_emails) as to_addr where lower(to_addr) = w.email))) as last_outbound_at
from wanted w
`;

export type QueryRows = (sql: string, params: readonly unknown[]) => Promise<Record<string, unknown>[]>;

export async function readMailActivity(
  emails: string[],
  run: QueryRows = queryPg as QueryRows,
): Promise<{ email: string; lastInboundAt: string | null; lastOutboundAt: string | null }[]> {
  if (emails.length === 0) {
    return [];
  }
  const rows = (await run(WAITING_SQL, [emails])) as MailRow[];
  return rows
    .filter((row): row is MailRow & { email: string } => typeof row.email === "string" && row.email.length > 0)
    .map((row) => ({
      email: row.email.toLowerCase(),
      lastInboundAt: row.last_inbound_at ? new Date(row.last_inbound_at).toISOString() : null,
      lastOutboundAt: row.last_outbound_at ? new Date(row.last_outbound_at).toISOString() : null,
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
      break;
    }
  }
  return rows;
}

export async function loadJulesStats(): Promise<JulesStats> {
  noStore();
  const user = await currentUser();
  if (!user || !ALLOWED_EMAILS.has(user.email)) {
    throw new Error("Unauthorized");
  }

  const now = new Date();
  const since = new Date(now.getTime() - WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
  const contactsSince = new Date(now.getTime() - CONTACT_DAYS * 24 * 3600 * 1000).toISOString();

  const [sessions, leads, events, messages, turnErrors] = await Promise.all([
    fetchAll<RawSession>(
      "jules_sessions",
      "id, source_surface, created_at, contact_email, account_id, created_by_user_id, owner_auth_user_id",
      (builder) => builder.gte("created_at", contactsSince).order("created_at", { ascending: true }),
    ),
    fetchAll<RawLead>(
      "intake_leads",
      "conversation_id, channel_mode, stage, contact_email, ready_to_publish, listing_status, first_seen_at, discarded_at",
      (builder) => builder.or(`first_seen_at.gte.${contactsSince},discarded_at.gte.${contactsSince}`),
    ),
    fetchAll<RawEvent>(
      "intake_lead_events",
      "conversation_id, kind, at",
      (builder) =>
        builder
          .in("kind", ["team_email_sent", "follow_up_sent", "seller_email_reply"])
          .gte("at", since)
          .order("at", { ascending: true }),
    ),
    fetchAll<RawMessage>(
      "jules_messages",
      "session_id, role, created_at, body",
      (builder) => builder.gte("created_at", since).order("created_at", { ascending: true }),
    ),
    fetchAll<RawTurnError>(
      "jules_events",
      "session_id, emitted_at",
      (builder) => builder.eq("event_type", "turn.failed").gte("emitted_at", since),
    ),
  ]);

  const addresses = leadEmails({ sessions, leads, events, messages, turnErrors, mail: [] });
  const mail = await readMailActivity(addresses);

  return buildJulesStats({ now, sessions, leads, events, messages, turnErrors, mail });
}
