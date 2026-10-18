// Turns platform rows into the follow-up list (one row per buyer, staff and test accounts left out,
// listings the buyer has paid for skipped, those not contacted since their latest signal first) and
// the "waiting on us" list (offers no one has answered, accepted deals left unpaid for two days).
import exclusions from "./marketplace-pulse-exclusions.json";
import type { FollowUp, FollowUpSignal, ListingLink, WaitingItem } from "./marketplace-pulse";

const STAFF = new RegExp(exclusions.staff_email_pattern, "i");
const TEST_IDS = new Set(Object.keys(exclusions.test_account_ids));
const TEST_EMAILS = new Set(exclusions.test_emails.map((e) => e.toLowerCase()));
const PAID_STEPS = new Set(["payment_confirmed", "collection_scheduled", "delivered", "completed"]);
const UNANSWERED_OFFERS = new Set(["submitted", "under_review"]);
const UNPAID_STEPS = new Set(["accepted", "terms_agreed", "payment_pending"]);
const STUCK_MS = 48 * 3_600_000;
const STEP_TEXT: Record<string, string> = {
  accepted: "accepted, not paid",
  terms_agreed: "terms agreed, not paid",
  payment_pending: "payment pending",
};

export type Person = { id: string; email: string; name: string; first_name: string | null; last_contact: string | null; subscribed: boolean; opted_out: boolean };
export type Specs = { chemistry: string | null; format: string | null; manufacturer: string | null; pack_kwh?: number | null } | null;
export type Listing = { id: string; title: string; seo_slug: string | null; supplier_account_id: string; created_at?: string; specs: Specs };

export type FollowUpRows = {
  deals: { id: string; status: string; workflow_step: string; created_at: string; listing_id: string | null; supplier_account_id: string; counterparty_account_id: string | null; agreed_amount: number | null; agreed_currency: string | null }[];
  payments: { deal_id: string }[];
  offers: { created_at: string; status: string; buyer_account_id: string; listing_id: string; amount: number | null; currency: string | null; quantity_requested: number | null; expires_at: string | null }[];
  chats: { created_at: string; listing_id: string | null; supplier_account_id: string; counterparty_account_id: string | null }[];
  bids: { created_at: string; email: string | null; listing_id: string | null; submission_kind: string; price_per_kwh: number | null; amount_per_unit: number | null; currency: string | null }[];
  /** Listings named in the rows above. */
  listings: Listing[];
  /** Every published listing, for "similar listings". */
  live: Listing[];
  /** Buyer and seller account names. */
  accountNames: Map<string, string>;
  /** Lower-cased member emails per buyer account. */
  accountEmails: Map<string, string[]>;
  people: Person[];
};

type Signal = FollowUpSignal & { buyer: string; listing_id: string | null };

const staffEmail = (email: string) => STAFF.test(email) || TEST_EMAILS.has(email.toLowerCase());
const money = (amount: number | null, currency: string | null) =>
  amount === null ? "" : ` ${(currency ?? "").toUpperCase()} ${Number(amount).toLocaleString("en-GB")}`;
const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function assembleFollowUps(rows: FollowUpRows, siteUrl: string, now = new Date()): { followUps: FollowUp[]; waiting: WaitingItem[] } {
  const site = siteUrl.replace(/\/$/, "");
  const url = (l: Listing) => `${site}/marketplace/${l.seo_slug || l.id}`;
  const staffAccount = (id: string) => TEST_IDS.has(id) || (rows.accountEmails.get(id) ?? []).some(staffEmail);
  const listingById = new Map([...rows.live, ...rows.listings].map((l) => [l.id, l]));
  const testListing = (id: string | null) => !!id && TEST_IDS.has(listingById.get(id)?.supplier_account_id ?? "");
  // An auction bidder who also has an account is that account.
  const accountByEmail = new Map<string, string>();
  for (const [account, emails] of rows.accountEmails) for (const email of emails) accountByEmail.set(email, account);
  const buyerName = (key: string) => rows.accountNames.get(key) ?? key;

  const paidDeals = new Set(rows.payments.map((p) => p.deal_id));
  const paid = (d: FollowUpRows["deals"][number]) => paidDeals.has(d.id) || PAID_STEPS.has(d.workflow_step) || d.status === "completed";
  const paidPairs = new Set(rows.deals.filter(paid).map((d) => `${d.counterparty_account_id}|${d.listing_id}`));

  const signals: Signal[] = [];
  const waiting: WaitingItem[] = [];
  const real = (buyer: string | null, listingId: string | null): buyer is string =>
    !!buyer && !testListing(listingId) && !(buyer.includes("@") ? staffEmail(buyer) : staffAccount(buyer));
  const add = (buyer: string | null, listingId: string | null, signal: FollowUpSignal) => {
    if (real(buyer, listingId) && !paidPairs.has(`${buyer}|${listingId}`)) signals.push({ ...signal, buyer, listing_id: listingId });
  };
  const waitingOn = (listingId: string | null) => {
    const listing = listingId ? listingById.get(listingId) : undefined;
    return {
      listing_title: listing?.title ?? null,
      listing_url: listing ? url(listing) : null,
      seller: listing ? rows.accountNames.get(listing.supplier_account_id) ?? null : null,
    };
  };

  const base = { listing_title: null, listing_url: null };
  for (const d of rows.deals) {
    if (TEST_IDS.has(d.supplier_account_id) || paid(d)) continue;
    const step = STEP_TEXT[d.workflow_step] ?? d.workflow_step.replaceAll("_", " ");
    const text = (d.status === "cancelled" ? `Deal cancelled at ${step}` : `Deal ${step}`) + money(d.agreed_amount, d.agreed_currency);
    add(d.counterparty_account_id, d.listing_id, { ...base, kind: "deal", status: d.status === "cancelled" ? "cancelled" : d.workflow_step, text, at: d.created_at });
    if (d.status === "open" && UNPAID_STEPS.has(d.workflow_step) && now.getTime() - Date.parse(d.created_at) > STUCK_MS
      && real(d.counterparty_account_id, d.listing_id)) {
      waiting.push({ kind: "deal", text, buyer: buyerName(d.counterparty_account_id!), at: d.created_at, expires_at: null, ...waitingOn(d.listing_id) });
    }
  }
  for (const o of rows.offers) {
    const qty = o.quantity_requested && o.quantity_requested > 1 ? ` × ${o.quantity_requested}` : "";
    const text = `Offer${money(o.amount, o.currency)}${qty}`;
    if (UNANSWERED_OFFERS.has(o.status)) {
      // Waiting on the seller, not the buyer, so it is not a follow-up.
      if (real(o.buyer_account_id, o.listing_id)) {
        waiting.push({ kind: "offer", text, buyer: buyerName(o.buyer_account_id), at: o.created_at, expires_at: o.expires_at, ...waitingOn(o.listing_id) });
      }
      continue;
    }
    add(o.buyer_account_id, o.listing_id, { ...base, kind: "offer", status: o.status, text: `Offer ${o.status}${money(o.amount, o.currency)}${qty}`, at: o.created_at });
  }
  for (const c of rows.chats) {
    if (TEST_IDS.has(c.supplier_account_id)) continue;
    add(c.counterparty_account_id, c.listing_id, { ...base, kind: "chat", status: "", text: "Messaged about a listing", at: c.created_at });
  }
  for (const b of rows.bids) {
    if (!b.email) continue;
    const email = b.email.toLowerCase();
    const price = b.price_per_kwh !== null ? ` ${(b.currency ?? "").toUpperCase()} ${b.price_per_kwh}/kWh` : money(b.amount_per_unit, b.currency);
    const kind = b.submission_kind === "buy_now" ? "buy-now" : b.submission_kind;
    add(accountByEmail.get(email) ?? email, b.listing_id, { ...base, kind: "auction", status: "", text: `Auction ${kind}${price}`, at: b.created_at });
  }
  for (const s of signals) {
    const listing = s.listing_id ? listingById.get(s.listing_id) : undefined;
    if (listing) {
      s.listing_title = listing.title;
      s.listing_url = url(listing);
    }
  }

  const live = rows.live.filter((l) => !TEST_IDS.has(l.supplier_account_id)).sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  /**
   * Same chemistry and format, then half to double the capacity, or the same maker when the size is
   * unknown. Same maker first, newest first.
   */
  const similar = (listingId: string | null): ListingLink[] => {
    const specs = listingId ? listingById.get(listingId)?.specs : null;
    if (!specs?.chemistry || !specs.format) return [];
    const kwh = Number(specs.pack_kwh) || 0;
    const closeSize = (l: Listing) => kwh
      ? Number(l.specs?.pack_kwh) >= kwh / 2 && Number(l.specs?.pack_kwh) <= kwh * 2
      : same(l.specs?.manufacturer, specs.manufacturer);
    const matches = live.filter((l) => l.id !== listingId && same(l.specs?.chemistry, specs.chemistry) && same(l.specs?.format, specs.format) && closeSize(l));
    const byMaker = [...matches.filter((l) => same(l.specs?.manufacturer, specs.manufacturer)), ...matches.filter((l) => !same(l.specs?.manufacturer, specs.manufacturer))];
    return byMaker.slice(0, 3).map((l) => ({ title: l.title, url: url(l) }));
  };

  const personByEmail = new Map(rows.people.map((p) => [p.email.toLowerCase(), p]));
  const byBuyer = new Map<string, Signal[]>();
  for (const s of signals) byBuyer.set(s.buyer, [...(byBuyer.get(s.buyer) ?? []), s]);
  const followUps: FollowUp[] = [...byBuyer.entries()].map(([key, list]) => {
    list.sort((a, b) => b.at.localeCompare(a.at));
    const emails = rows.accountEmails.get(key) ?? (key.includes("@") ? [key] : []);
    const person = emails.map((e) => personByEmail.get(e)).find(Boolean) ?? null;
    const { buyer: _buyer, listing_id: listingId, ...latest } = list[0];
    return {
      key,
      name: rows.accountNames.get(key) ?? person?.name ?? key,
      email: emails[0] ?? null,
      person_id: person?.id ?? null,
      first_name: person?.first_name ?? null,
      subscribed: person?.subscribed ?? false,
      opted_out: person?.opted_out ?? false,
      last_contact: person?.last_contact ?? null,
      contacted_since: !!person?.last_contact && Date.parse(person.last_contact) > Date.parse(latest.at),
      latest,
      more: list.length - 1,
      similar: similar(listingId),
    };
  });
  followUps.sort((a, b) => Number(a.contacted_since) - Number(b.contacted_since) || b.latest.at.localeCompare(a.latest.at));
  // Soonest to expire first, then the longest stuck.
  waiting.sort((a, b) => (a.expires_at ?? "9").localeCompare(b.expires_at ?? "9") || a.at.localeCompare(b.at));
  return { followUps, waiting };
}
