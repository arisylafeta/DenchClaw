// Turns platform rows into the follow-up list: one row per buyer, staff and test accounts left out,
// listings the buyer has paid for skipped, those not contacted since their latest signal first.
import exclusions from "./marketplace-pulse-exclusions.json";
import type { FollowUp, FollowUpSignal } from "./marketplace-pulse";

const STAFF = new RegExp(exclusions.staff_email_pattern, "i");
const TEST_IDS = new Set(Object.keys(exclusions.test_account_ids));
const TEST_EMAILS = new Set(exclusions.test_emails.map((e) => e.toLowerCase()));
const PAID_STEPS = new Set(["payment_confirmed", "collection_scheduled", "delivered", "completed"]);
const STEP_TEXT: Record<string, string> = {
  accepted: "accepted, not paid",
  terms_agreed: "terms agreed, not paid",
  payment_pending: "payment pending",
};

export type Person = { id: string; email: string; name: string; last_contact: string | null };

export type FollowUpRows = {
  deals: { id: string; status: string; workflow_step: string; created_at: string; listing_id: string | null; supplier_account_id: string; counterparty_account_id: string | null; agreed_amount: number | null; agreed_currency: string | null }[];
  payments: { deal_id: string }[];
  offers: { created_at: string; status: string; buyer_account_id: string; listing_id: string; amount: number | null; currency: string | null; quantity_requested: number | null }[];
  chats: { created_at: string; listing_id: string | null; supplier_account_id: string; counterparty_account_id: string | null }[];
  bids: { created_at: string; email: string | null; listing_id: string | null; submission_kind: string; price_per_kwh: number | null; amount_per_unit: number | null; currency: string | null }[];
  listings: { id: string; title: string; seo_slug: string | null; supplier_account_id: string }[];
  accountNames: Map<string, string>;
  /** Lower-cased member emails per buyer account. */
  accountEmails: Map<string, string[]>;
  people: Person[];
};

type Signal = FollowUpSignal & { buyer: string; listing_id: string | null };

const staffEmail = (email: string) => STAFF.test(email) || TEST_EMAILS.has(email.toLowerCase());
const money = (amount: number | null, currency: string | null) =>
  amount === null ? "" : ` ${(currency ?? "").toUpperCase()} ${Number(amount).toLocaleString("en-GB")}`;

export function assembleFollowUps(rows: FollowUpRows, siteUrl: string): FollowUp[] {
  const staffAccount = (id: string) => TEST_IDS.has(id) || (rows.accountEmails.get(id) ?? []).some(staffEmail);
  const listingById = new Map(rows.listings.map((l) => [l.id, l]));
  const testListing = (id: string | null) => !!id && TEST_IDS.has(listingById.get(id)?.supplier_account_id ?? "");
  // An auction bidder who also has an account is that account.
  const accountByEmail = new Map<string, string>();
  for (const [account, emails] of rows.accountEmails) for (const email of emails) accountByEmail.set(email, account);

  const paidDeals = new Set(rows.payments.map((p) => p.deal_id));
  const paidPairs = new Set(rows.deals.filter((d) => paidDeals.has(d.id) || PAID_STEPS.has(d.workflow_step) || d.status === "completed")
    .map((d) => `${d.counterparty_account_id}|${d.listing_id}`));

  const signals: Signal[] = [];
  const add = (buyer: string | null, listingId: string | null, signal: FollowUpSignal) => {
    if (!buyer || paidPairs.has(`${buyer}|${listingId}`) || testListing(listingId)) return;
    if (buyer.includes("@") ? staffEmail(buyer) : staffAccount(buyer)) return;
    signals.push({ ...signal, buyer, listing_id: listingId });
  };
  const base = { listing_title: null, listing_url: null };
  for (const d of rows.deals) {
    if (TEST_IDS.has(d.supplier_account_id)) continue;
    const step = STEP_TEXT[d.workflow_step] ?? d.workflow_step.replaceAll("_", " ");
    const text = (d.status === "cancelled" ? `Deal cancelled at ${step}` : `Deal ${step}`) + money(d.agreed_amount, d.agreed_currency);
    add(d.counterparty_account_id, d.listing_id, { ...base, kind: "deal", text, at: d.created_at });
  }
  for (const o of rows.offers) {
    const qty = o.quantity_requested && o.quantity_requested > 1 ? ` × ${o.quantity_requested}` : "";
    add(o.buyer_account_id, o.listing_id, { ...base, kind: "offer", text: `Offer ${o.status}${money(o.amount, o.currency)}${qty}`, at: o.created_at });
  }
  for (const c of rows.chats) {
    if (TEST_IDS.has(c.supplier_account_id)) continue;
    add(c.counterparty_account_id, c.listing_id, { ...base, kind: "chat", text: "Messaged about a listing", at: c.created_at });
  }
  for (const b of rows.bids) {
    if (!b.email) continue;
    const email = b.email.toLowerCase();
    const price = b.price_per_kwh !== null ? ` ${(b.currency ?? "").toUpperCase()} ${b.price_per_kwh}/kWh` : money(b.amount_per_unit, b.currency);
    const kind = b.submission_kind === "buy_now" ? "buy-now" : b.submission_kind;
    add(accountByEmail.get(email) ?? email, b.listing_id, { ...base, kind: "auction", text: `Auction ${kind}${price}`, at: b.created_at });
  }

  const site = siteUrl.replace(/\/$/, "");
  for (const s of signals) {
    const listing = s.listing_id ? listingById.get(s.listing_id) : undefined;
    if (listing) {
      s.listing_title = listing.title;
      s.listing_url = `${site}/marketplace/${listing.seo_slug || listing.id}`;
    }
  }

  const personByEmail = new Map(rows.people.map((p) => [p.email.toLowerCase(), p]));
  const byBuyer = new Map<string, Signal[]>();
  for (const s of signals) byBuyer.set(s.buyer, [...(byBuyer.get(s.buyer) ?? []), s]);
  const result: FollowUp[] = [...byBuyer.entries()].map(([key, list]) => {
    list.sort((a, b) => b.at.localeCompare(a.at));
    const emails = rows.accountEmails.get(key) ?? (key.includes("@") ? [key] : []);
    const person = emails.map((e) => personByEmail.get(e)).find(Boolean) ?? null;
    const { buyer: _buyer, listing_id: _listing, ...latest } = list[0];
    return {
      key,
      name: rows.accountNames.get(key) ?? person?.name ?? key,
      email: emails[0] ?? null,
      person_id: person?.id ?? null,
      last_contact: person?.last_contact ?? null,
      contacted_since: !!person?.last_contact && Date.parse(person.last_contact) > Date.parse(latest.at),
      latest,
      more: list.length - 1,
    };
  });
  return result.sort((a, b) => Number(a.contacted_since) - Number(b.contacted_since) || b.latest.at.localeCompare(a.latest.at));
}
