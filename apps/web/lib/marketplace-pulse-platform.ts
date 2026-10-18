import "server-only";

// Buyers to follow up: everyone outside ReBattery who showed buying intent on the platform in the
// last 30 days without a paid deal, newest first, with the CRM person and when we last spoke.
// Read only, fresh on each load. Exclusions match scripts/rebattery/marketplace_pulse_collect.py.
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdminClient } from "./platform-admin/supabase";
import { getSiteEnv } from "./platform-admin/env";
import { queryPg } from "./postgres";
import { assembleFollowUps, type FollowUpRows, type Listing, type Person, type Specs } from "./marketplace-pulse-follow-ups";
import type { FollowUp, WaitingItem } from "./marketplace-pulse";

const DAYS = 30;
const LISTING_SELECT = "id,title,seo_slug,supplier_account_id,created_at,listing_specs(chemistry,format,manufacturer,pack_kwh)";
const CACHE_MS = 5 * 60_000;

type ListingRow = Omit<Listing, "specs"> & { listing_specs: Specs | Specs[] };
const toListing = ({ listing_specs: specs, ...rest }: ListingRow): Listing => ({ ...rest, specs: Array.isArray(specs) ? specs[0] ?? null : specs });

let liveCache: { at: number; listings: Promise<Listing[]> } | null = null;

/** Published listings with their specs, cached for five minutes; used for "similar listings". */
function liveListings(db: SupabaseClient): Promise<Listing[]> {
  if (!liveCache || Date.now() - liveCache.at > CACHE_MS) {
    const listings = (async () => {
      const out: Listing[] = [];
      for (let from = 0; ; from += 1000) {
        const page = await read<ListingRow>(db.from("listings").select(LISTING_SELECT).eq("listing_status", "published").order("id").range(from, from + 999), "listings");
        out.push(...page.map(toListing));
        if (page.length < 1000) return out;
      }
    })();
    liveCache = { at: Date.now(), listings };
    listings.catch(() => { if (liveCache?.listings === listings) liveCache = null; });
  }
  return liveCache.listings;
}

async function read<T>(query: PromiseLike<{ data: unknown; error: { message: string } | null }>, what: string): Promise<T[]> {
  const { data, error } = await query;
  // A failed read must not quietly drop the staff check, so it fails the whole list.
  if (error) throw new Error(`${what}: ${error.message}`);
  return (data ?? []) as T[];
}

const recent = (db: SupabaseClient, table: string, select: string, since: string) =>
  db.from(table).select(select).gte("created_at", since).order("created_at", { ascending: false }).limit(1000);

export async function followUps(now = new Date()): Promise<{ followUps: FollowUp[]; waiting: WaitingItem[] }> {
  // Untyped: auction_submissions is newer than the generated platform types.
  const db = getSupabaseAdminClient() as unknown as SupabaseClient;
  const since = new Date(now.getTime() - DAYS * 86_400_000).toISOString();
  const [deals, offers, chats, bids] = await Promise.all([
    read<FollowUpRows["deals"][number]>(recent(db, "deals", "id,status,workflow_step,created_at,listing_id,supplier_account_id,counterparty_account_id,agreed_amount,agreed_currency", since), "deals"),
    read<FollowUpRows["offers"][number]>(recent(db, "purchase_offers", "created_at,status,buyer_account_id,listing_id,amount,currency,quantity_requested,expires_at", since), "purchase_offers"),
    read<FollowUpRows["chats"][number]>(recent(db, "conversations", "created_at,listing_id,supplier_account_id,counterparty_account_id", since)
      .in("conversation_type", ["purchase", "buy_now"]), "conversations"),
    read<FollowUpRows["bids"][number]>(recent(db, "auction_submissions", "created_at,email,listing_id,submission_kind,price_per_kwh,amount_per_unit,currency", since), "auction_submissions"),
  ]);
  const payments = deals.length
    ? await read<FollowUpRows["payments"][number]>(
      db.from("deal_payment_intents").select("deal_id").eq("status", "captured").eq("payment_purpose", "initial").in("deal_id", deals.map((d) => d.id)),
      "deal_payment_intents")
    : [];

  const listingIds = [...new Set([...deals, ...offers, ...chats, ...bids].map((row) => row.listing_id).filter((id): id is string => !!id))];
  const [listings, live] = await Promise.all([
    listingIds.length ? read<ListingRow>(db.from("listings").select(LISTING_SELECT).in("id", listingIds), "listings").then((rows) => rows.map(toListing)) : [],
    liveListings(db),
  ]);
  const sellerIds = [...new Set(listings.map((l) => l.supplier_account_id))];
  const accountIds = [...new Set([...deals.map((d) => d.counterparty_account_id), ...offers.map((o) => o.buyer_account_id), ...chats.map((c) => c.counterparty_account_id)]
    .filter((id): id is string => !!id))];
  const [accounts, memberships] = accountIds.length
    ? await Promise.all([
      read<{ id: string; name: string }>(db.from("accounts").select("id,name").in("id", [...new Set([...accountIds, ...sellerIds])]), "accounts"),
      read<{ account_id: string; user_id: string }>(db.from("account_memberships").select("account_id,user_id").in("account_id", accountIds), "account_memberships"),
    ])
    : [[], []];
  const userIds = [...new Set(memberships.map((m) => m.user_id))];
  const users = userIds.length ? await read<{ id: string; email: string }>(db.from("users").select("id,email").in("id", userIds), "users") : [];
  const emailOf = new Map(users.map((u) => [u.id, u.email.toLowerCase()]));
  const accountEmails = new Map<string, string[]>();
  for (const m of memberships) {
    const email = emailOf.get(m.user_id);
    if (email) accountEmails.set(m.account_id, [...(accountEmails.get(m.account_id) ?? []), email]);
  }

  const emails = [...new Set([...accountEmails.values()].flat().concat(bids.map((b) => b.email?.toLowerCase() ?? "")).filter((e) => e.includes("@")))];
  const people = emails.length
    ? await queryPg<Person>(
      `select id, lower(email) as email,
              coalesce(nullif(full_name, ''), nullif(concat_ws(' ', first_name, last_name), ''), email) as name,
              nullif(first_name, '') as first_name,
              to_char(last_interaction_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as last_contact,
              not coalesce(email_opted_out, false)
                and exists (select 1 from crm_subscriptions s where s.person_id = p.id and s.list = 'Supply update' and s.status = 'Subscribed') as subscribed,
              coalesce(email_opted_out, false)
                or exists (select 1 from crm_subscriptions s where s.person_id = p.id and s.list = 'Supply update' and s.status = 'Opted out') as opted_out
         from crm_people p where lower(email) = any($1)`,
      [emails],
    )
    : [];

  return assembleFollowUps(
    { deals, payments, offers, chats, bids, listings, live, accountNames: new Map(accounts.map((a) => [a.id, a.name])), accountEmails, people },
    getSiteEnv().siteUrl,
    now,
  );
}
