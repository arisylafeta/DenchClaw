import "server-only";

// Buyers to follow up: everyone outside ReBattery who showed buying intent on the platform in the
// last 30 days without a paid deal, newest first, with the CRM person and when we last spoke.
// Read only, fresh on each load.
import type { SupabaseClient } from "@supabase/supabase-js";
import exclusions from "./marketplace-pulse-exclusions.json";
import { getSupabaseAdminClient } from "./platform-admin/supabase";
import { getSiteEnv } from "./platform-admin/env";
import { queryPg } from "./postgres";
import type { FollowUp, FollowUpSignal } from "./marketplace-pulse";

const DAYS = 30;
const STAFF = new RegExp(exclusions.staff_email_pattern, "i");
const TEST_IDS = new Set(Object.keys(exclusions.test_account_ids));
const TEST_EMAILS = new Set(exclusions.test_emails.map((e) => e.toLowerCase()));
const staffEmail = (email: string) => STAFF.test(email) || TEST_EMAILS.has(email.toLowerCase());
const CHAT_TYPES = new Set(["purchase", "buy_now"]);
const PAID_STEPS = new Set(["payment_confirmed", "collection_scheduled", "delivered", "completed"]);
const STEP_TEXT: Record<string, string> = {
  accepted: "accepted, not paid",
  terms_agreed: "terms agreed, not paid",
  payment_pending: "payment pending",
};

type Deal = { id: string; status: string; workflow_step: string; created_at: string; listing_id: string | null; counterparty_account_id: string | null; agreed_amount: number | null; agreed_currency: string | null };
type Offer = { created_at: string; status: string; buyer_account_id: string; listing_id: string; amount: number | null; currency: string | null; quantity_requested: number | null };
type Chat = { created_at: string; conversation_type: string; listing_id: string | null; counterparty_account_id: string | null };
type Bid = { created_at: string; email: string | null; listing_id: string | null; submission_kind: string; price_per_kwh: number | null; amount_per_unit: number | null; currency: string | null };
type Signal = FollowUpSignal & { buyer: { account_id?: string; email?: string }; listing_id: string | null };

const money = (amount: number | null, currency: string | null) =>
  amount === null ? "" : ` ${(currency ?? "").toUpperCase()} ${Number(amount).toLocaleString("en-GB")}`;

async function rows<T>(db: SupabaseClient, table: string, select: string, since: string): Promise<T[]> {
  const { data, error } = await db.from(table).select(select).gte("created_at", since).order("created_at", { ascending: false }).limit(1000);
  if (error) throw new Error(`${table}: ${error.message}`);
  return (data ?? []) as T[];
}

export async function followUps(now = new Date()): Promise<FollowUp[]> {
  // Untyped: auction_submissions is newer than the generated platform types.
  const db = getSupabaseAdminClient() as unknown as SupabaseClient;
  const since = new Date(now.getTime() - DAYS * 86_400_000).toISOString();
  const [deals, offers, chats, bids] = await Promise.all([
    rows<Deal>(db, "deals", "id,status,workflow_step,created_at,listing_id,counterparty_account_id,agreed_amount,agreed_currency", since),
    rows<Offer>(db, "purchase_offers", "created_at,status,buyer_account_id,listing_id,amount,currency,quantity_requested", since),
    rows<Chat>(db, "conversations", "created_at,conversation_type,listing_id,counterparty_account_id", since)
      .then((all) => all.filter((chat) => chat.counterparty_account_id && CHAT_TYPES.has(chat.conversation_type))),
    rows<Bid>(db, "auction_submissions", "created_at,email,listing_id,submission_kind,price_per_kwh,amount_per_unit,currency", since),
  ]);
  const { data: payments, error: paymentError } = deals.length
    ? await db.from("deal_payment_intents").select("deal_id").eq("status", "captured").in("deal_id", deals.map((d) => d.id))
    : { data: [], error: null };
  if (paymentError) throw new Error(`deal_payment_intents: ${paymentError.message}`);
  const paidDeals = new Set((payments ?? []).map((p: { deal_id: string }) => p.deal_id));

  const accountIds = [...new Set([...deals.map((d) => d.counterparty_account_id), ...offers.map((o) => o.buyer_account_id), ...chats.map((c) => c.counterparty_account_id)]
    .filter((id): id is string => !!id))];
  const [accounts, memberships] = accountIds.length
    ? await Promise.all([
      db.from("accounts").select("id,name").in("id", accountIds),
      db.from("account_memberships").select("account_id,user_id").in("account_id", accountIds),
    ])
    : [{ data: [] }, { data: [] }];
  const userIds = [...new Set((memberships.data ?? []).map((m: { user_id: string }) => m.user_id))];
  const users = userIds.length ? (await db.from("users").select("id,email").in("id", userIds)).data ?? [] : [];
  const emailOf = new Map((users as { id: string; email: string }[]).map((u) => [u.id, u.email.toLowerCase()]));
  const accountEmails = new Map<string, string[]>();
  for (const m of (memberships.data ?? []) as { account_id: string; user_id: string }[]) {
    const email = emailOf.get(m.user_id);
    if (email) accountEmails.set(m.account_id, [...(accountEmails.get(m.account_id) ?? []), email]);
  }
  const accountName = new Map(((accounts.data ?? []) as { id: string; name: string }[]).map((a) => [a.id, a.name]));
  const staffAccount = (id: string) => TEST_IDS.has(id) || (accountEmails.get(id) ?? []).some(staffEmail);

  // A buyer who paid for a listing needs no chasing about it.
  const paidPairs = new Set(deals.filter((d) => paidDeals.has(d.id) || PAID_STEPS.has(d.workflow_step) || d.status === "completed")
    .map((d) => `${d.counterparty_account_id}|${d.listing_id}`));

  const signals: Signal[] = [];
  for (const d of deals) {
    if (!d.counterparty_account_id || paidPairs.has(`${d.counterparty_account_id}|${d.listing_id}`)) continue;
    const step = STEP_TEXT[d.workflow_step] ?? d.workflow_step.replaceAll("_", " ");
    const text = d.status === "cancelled" ? `Deal cancelled at ${step}` : `Deal ${step}`;
    signals.push({ kind: "deal", text: text + money(d.agreed_amount, d.agreed_currency), at: d.created_at, listing_id: d.listing_id, listing_title: null, listing_url: null, buyer: { account_id: d.counterparty_account_id } });
  }
  for (const o of offers) {
    if (paidPairs.has(`${o.buyer_account_id}|${o.listing_id}`)) continue;
    const qty = o.quantity_requested && o.quantity_requested > 1 ? ` × ${o.quantity_requested}` : "";
    signals.push({ kind: "offer", text: `Offer ${o.status}${money(o.amount, o.currency)}${qty}`, at: o.created_at, listing_id: o.listing_id, listing_title: null, listing_url: null, buyer: { account_id: o.buyer_account_id } });
  }
  for (const c of chats) {
    if (paidPairs.has(`${c.counterparty_account_id}|${c.listing_id}`)) continue;
    signals.push({ kind: "chat", text: "Messaged about a listing", at: c.created_at, listing_id: c.listing_id, listing_title: null, listing_url: null, buyer: { account_id: c.counterparty_account_id! } });
  }
  for (const b of bids) {
    if (!b.email) continue;
    const price = b.price_per_kwh !== null ? ` ${(b.currency ?? "").toUpperCase()} ${b.price_per_kwh}/kWh` : money(b.amount_per_unit, b.currency);
    signals.push({ kind: "auction", text: `Auction ${b.submission_kind === "buy_now" ? "buy-now" : b.submission_kind}${price}`, at: b.created_at, listing_id: b.listing_id, listing_title: null, listing_url: null, buyer: { email: b.email.toLowerCase() } });
  }
  const real = signals.filter((s) => s.buyer.account_id ? !staffAccount(s.buyer.account_id) : !staffEmail(s.buyer.email!));

  const listingIds = [...new Set(real.map((s) => s.listing_id).filter((id): id is string => !!id))];
  const listings = listingIds.length ? (await db.from("listings").select("id,title,seo_slug").in("id", listingIds)).data ?? [] : [];
  const site = getSiteEnv().siteUrl.replace(/\/$/, "");
  const listingById = new Map((listings as { id: string; title: string; seo_slug: string | null }[]).map((l) => [l.id, l]));
  for (const s of real) {
    const listing = s.listing_id ? listingById.get(s.listing_id) : undefined;
    if (listing) {
      s.listing_title = listing.title;
      s.listing_url = `${site}/marketplace/${listing.seo_slug || listing.id}`;
    }
  }

  // One row per buyer: the newest signal, and how many more.
  const byBuyer = new Map<string, Signal[]>();
  for (const s of real) {
    const key = s.buyer.account_id ?? s.buyer.email!;
    byBuyer.set(key, [...(byBuyer.get(key) ?? []), s]);
  }
  const buyerEmails = [...byBuyer.keys()].flatMap((key) => accountEmails.get(key) ?? [key]).filter((e) => e.includes("@"));
  const people = buyerEmails.length
    ? await queryPg<{ id: string; email: string; name: string; last_contact: string | null }>(
      `select id, lower(email) as email,
              coalesce(nullif(full_name, ''), nullif(concat_ws(' ', first_name, last_name), ''), email) as name,
              to_char(last_interaction_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as last_contact
         from crm_people where lower(email) = any($1)`,
      [buyerEmails],
    )
    : [];
  const personByEmail = new Map(people.map((p) => [p.email, p]));

  const result: FollowUp[] = [...byBuyer.entries()].map(([key, list]) => {
    list.sort((a, b) => b.at.localeCompare(a.at));
    const emails = accountEmails.get(key) ?? (key.includes("@") ? [key] : []);
    const person = emails.map((e) => personByEmail.get(e)).find(Boolean) ?? null;
    const { buyer: _buyer, listing_id: _listing, ...latest } = list[0];
    return {
      key,
      name: accountName.get(key) ?? person?.name ?? key,
      email: emails[0] ?? null,
      person_id: person?.id ?? null,
      last_contact: person?.last_contact ?? null,
      contacted_since: !!person?.last_contact && Date.parse(person.last_contact) > Date.parse(latest.at),
      latest,
      more: list.length - 1,
    };
  });
  // Not yet answered first, then newest.
  return result.sort((a, b) => Number(a.contacted_since) - Number(b.contacted_since) || b.latest.at.localeCompare(a.latest.at));
}
