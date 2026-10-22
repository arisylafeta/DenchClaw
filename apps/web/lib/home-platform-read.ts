import "server-only";

// Home: reads the platform rows lib/home-platform.ts counts. Read only, fresh on each load, with the
// same admin client as Marketplace Pulse. Any failed read fails the whole set, so a missing staff check
// can never quietly let test accounts into the numbers.
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdminClient } from "./platform-admin/supabase";
import { REPLY_SINCE } from "./home-metrics";
import type { PlatformRows } from "./home-platform";

type Result = PromiseLike<{ data: unknown; error: { message: string } | null }>;

async function read<T>(query: Result, what: string): Promise<T[]> {
  const { data, error } = await query;
  if (error) {throw new Error(`${what}: ${error.message}`);}
  return (data ?? []) as T[];
}

/** Every row of a query, a thousand at a time, in id order so pages neither repeat nor skip rows. */
async function readAll<T>(build: (from: number, to: number) => Result, what: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const page = await read<T>(build(from, from + 999), what);
    out.push(...page);
    if (page.length < 1000) {return out;}
  }
}

/** Rows whose `column` is one of `values`, a hundred values per request. */
async function readIn<T>(db: SupabaseClient, table: string, select: string, column: string, values: string[]): Promise<T[]> {
  const unique = [...new Set(values)];
  const out: T[] = [];
  for (let i = 0; i < unique.length; i += 100) {
    out.push(...await readAll<T>((from, to) => db.from(table).select(select).in(column, unique.slice(i, i + 100)).order("id").range(from, to), table));
  }
  return out;
}

export async function platformRows(): Promise<PlatformRows> {
  const db = getSupabaseAdminClient() as unknown as SupabaseClient;
  const [deals, payments, offers, conversations] = await Promise.all([
    readAll<PlatformRows["deals"][number]>((from, to) =>
      db.from("deals").select("id,created_at,supplier_account_id,counterparty_account_id").order("id").range(from, to), "deals"),
    readAll<PlatformRows["payments"][number]>((from, to) =>
      db.from("deal_payment_intents").select("id,deal_id,status,payment_purpose,amount,currency,platform_fee_amount,captured_at,created_at")
        .eq("status", "captured").order("id").range(from, to), "deal_payment_intents"),
    readAll<PlatformRows["offers"][number]>((from, to) =>
      db.from("purchase_offers").select("id,buyer_account_id,created_at").order("id").range(from, to), "purchase_offers"),
    readAll<PlatformRows["conversations"][number]>((from, to) =>
      db.from("conversations").select("id,created_at,counterparty_account_id").in("conversation_type", ["purchase", "buy_now"])
        .order("id").range(from, to), "conversations"),
  ]);

  const replyIds = conversations.filter((c) => c.created_at >= REPLY_SINCE).map((c) => c.id);
  const rawMessages = await readIn<{ conversation_id: string; created_at: string; is_system_seeded: boolean | null; sender_membership_id: string | null }>(
    db, "conversation_messages", "id,conversation_id,created_at,is_system_seeded,sender_membership_id", "conversation_id", replyIds);

  // Buyers are checked against staff and test emails, so their members are read.
  const buyerIds = [...deals.map((d) => d.counterparty_account_id), ...offers.map((o) => o.buyer_account_id), ...conversations.map((c) => c.counterparty_account_id)]
    .filter((id): id is string => !!id);
  const senderIds = rawMessages.map((m) => m.sender_membership_id).filter((id): id is string => !!id);
  const sellerIds = deals.map((d) => d.supplier_account_id).filter((id): id is string => !!id);
  const [members, senders, accounts] = await Promise.all([
    readIn<{ account_id: string; user_id: string }>(db, "account_memberships", "id,account_id,user_id", "account_id", buyerIds),
    readIn<{ id: string; account_id: string }>(db, "account_memberships", "id,account_id", "id", senderIds),
    readIn<{ id: string; name: string }>(db, "accounts", "id,name", "id", sellerIds),
  ]);
  const users = await readIn<{ id: string; email: string | null }>(db, "users", "id,email", "id", members.map((m) => m.user_id));

  const emailOf = new Map(users.filter((u) => u.email).map((u) => [u.id, u.email!.toLowerCase()]));
  const accountEmails = new Map<string, string[]>();
  for (const m of members) {
    const email = emailOf.get(m.user_id);
    if (email) {accountEmails.set(m.account_id, [...(accountEmails.get(m.account_id) ?? []), email]);}
  }
  const senderAccount = new Map(senders.map((s) => [s.id, s.account_id]));

  return {
    deals,
    payments,
    offers,
    conversations,
    messages: rawMessages.map((m) => ({
      conversation_id: m.conversation_id,
      created_at: m.created_at,
      is_system_seeded: m.is_system_seeded,
      sender_account_id: m.sender_membership_id ? senderAccount.get(m.sender_membership_id) ?? null : null,
    })),
    accountEmails,
    accountNames: new Map(accounts.map((a) => [a.id, a.name])),
  };
}
