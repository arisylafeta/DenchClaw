import { isBundledPersonalDomain } from "./personal-email-blocklist";

/** Who a Relay reply is sent as. supply@ talks to sellers, buy@ to buyers, everything else is Alex. */
export type ReplyIdentity = "alex" | "supply" | "buy";

const SUPPLY = "supply@rebattery.io";
const BUY = "buy@rebattery.io";

type IdentityMessage = { direction: string; to_emails: string[]; cc_emails: string[]; identity_key: string | null };

/** The shared inbox the thread is addressed to, else the one we last wrote from, else Alex.
 * messages are newest first. When a message reached both inboxes, the contact's side decides. */
export function replyIdentity(messages: IdentityMessage[], contactType?: string | null): ReplyIdentity {
  const latest = messages.find((m) => m.direction === "inbound") ?? messages[0];
  const addresses = new Set([...(latest?.to_emails ?? []), ...(latest?.cc_emails ?? [])].map((a) => a.toLowerCase().trim()));
  const supply = latest?.identity_key === "supply" || addresses.has(SUPPLY);
  const buy = latest?.identity_key === "buy" || addresses.has(BUY);
  if (supply && buy) return contactType === "buyer" ? "buy" : "supply";
  if (supply) return "supply";
  if (buy) return "buy";
  const sent = messages.find((m) => m.direction === "outbound")?.identity_key;
  return sent === "supply" || sent === "buy" ? sent : "alex";
}

// Personal and ISP mail the bundled list misses; the scanner's FREEMAIL carries the same ones.
const MORE_PERSONAL = new Set(["seznam.cz", "wp.pl", "o2.pl", "onet.pl", "btinternet.com", "sky.com", "virginmedia.com", "talktalk.net", "ntlworld.com"]);
const domainOf = (email: string) => email.split("@")[1] ?? "";

/** A personal or ISP mail domain, which never identifies a company. */
export const isPersonalDomain = (domain: string) => isBundledPersonalDomain(domain) || MORE_PERSONAL.has(domain.toLowerCase());

/** True when the person on the thread owns the deal: the same address, or the same company domain (never a personal one). */
export function ownsDeal(ownerEmail: string | null | undefined, counterpartEmail: string | null | undefined): boolean {
  const owner = (ownerEmail ?? "").toLowerCase().trim();
  const other = (counterpartEmail ?? "").toLowerCase().trim();
  if (!owner || !other) return false;
  if (owner === other) return true;
  const domain = domainOf(owner);
  return !!domain && domain === domainOf(other) && !isBundledPersonalDomain(domain) && !MORE_PERSONAL.has(domain);
}

/** True when the person on the thread is one of the deal's own people: its main contact or another contact on it
 * (crm_bulk_offers role 'contact'), by address or company domain as `ownsDeal`. */
export function ownsDealAny(ownerEmails: (string | null | undefined)[], counterpartEmail: string | null | undefined): boolean {
  return ownerEmails.some((owner) => ownsDeal(owner, counterpartEmail));
}

type DealRow = Record<string, unknown> & { owner_email?: string | null; owner_emails?: string[] | null };

const OWNER_NOTE = "Private to this deal's owner: never put their name, price, budget, notes or site into an email to anyone else, including follow-on emails.";

/** The deal facts a draft may use. Its owner sees the whole record. Anyone else on the deal (a supplier answering a
 * buyer's request) sees only the listing title, quantity and kind: never the summary or notes, which can carry the
 * buyer's price, site or people. */
export function dealSummaryText(row: DealRow, counterpartEmail: string | null | undefined): string {
  if (ownsDealAny([row.owner_email, ...(Array.isArray(row.owner_emails) ? row.owner_emails : [])], counterpartEmail)) {
    const keep = Object.entries(row)
      .filter(([key, value]) => key !== "owner_email" && key !== "owner_emails" && value !== null && value !== "" && !/(_at|_id|^id|match_hash)$/.test(key) && !(value instanceof Date))
      .slice(0, 40);
    return [OWNER_NOTE, ...keep.map(([key, value]) => `${key}: ${(typeof value === "object" ? JSON.stringify(value) : String(value)).slice(0, 400)}`)].join("\n");
  }
  const context = (row.context && typeof row.context === "object" ? row.context : {}) as Record<string, unknown>;
  const spec = (row.spec && typeof row.spec === "object" ? row.spec : {}) as Record<string, unknown>;
  let title = String(context.listing_title ?? spec.listing_title ?? "").slice(0, 200);
  const party = typeof row.party === "string" ? row.party.trim() : "";
  for (const name of [party, party.split(/\s+/)[0] ?? ""]) {
    if (name.length > 2) title = title.split(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")).join("[the other side]");
  }
  if (/[€$£]|\b(eur|usd|gbp)\b|\/\s*kwh/i.test(title)) title = "";  // a price in a hand-written title stays private
  const lines = [
    "This person is on the deal as a counterparty, not its owner. Never name or describe the other side, and never give their price, budget, notes or site.",
    `kind: ${row.kind === "demand" ? "demand (a buyer's request this person may be able to supply)" : String(row.kind ?? "")}`,
    title && `title: ${title}`,
    row.quantity ? `quantity: ${String(row.quantity).slice(0, 100)}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

/** The shared inbox a thread involves. A thread copied to both goes by the contact's side. */
export function threadInbox(supply: boolean, buy: boolean, contactType?: string | null): "supply" | "buy" | null {
  if (supply && buy) return contactType === "buyer" ? "buy" : "supply";
  return supply ? "supply" : buy ? "buy" : null;
}

type LastDealJob = { status: string; created_at: string } | null | undefined;

/** What Relay offers for the deal: create one for a seller or buyer email with none, or update it when their reply is newest.
 * Nothing while Matcha works, and nothing again until a new message arrives after Matcha's last finished run. */
export function suggestDealAction(
  item: { bulk_listing_id: string | null; contact_type: string | null; last_message: { direction: string | null; at?: string | null } | null },
  inbox: "supply" | "buy" | null,
  lastJob?: LastDealJob,
): "create" | "update" | null {
  if (lastJob && ["queued", "running", "ready", "finalising"].includes(lastJob.status)) return null;
  const at = item.last_message?.at ? Date.parse(item.last_message.at) : NaN;
  if (lastJob?.status === "done" && (Number.isNaN(at) || Date.parse(lastJob.created_at) >= at)) return null;
  if (item.bulk_listing_id) return item.last_message?.direction === "inbound" ? "update" : null;
  return inbox || item.contact_type === "buyer" || item.contact_type === "supplier" ? "create" : null;
}

/** A deal Matcha names may be linked to the email only when it is this email's deal already, the thread is tagged with it,
 * or the person writing owns it. A made-up or someone else's listing is refused. */
export function dealResultFits(d: { listingId: string; currentListingId: string | null; threadLinked: boolean; ownerEmail: string | null; contactEmails?: string[]; counterpartEmail: string | null }): boolean {
  return d.listingId === d.currentListingId || d.threadLinked || ownsDealAny([d.ownerEmail, ...(d.contactEmails ?? [])], d.counterpartEmail);
}
