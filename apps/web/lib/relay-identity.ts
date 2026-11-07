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

const domainOf = (email: string) => email.split("@")[1] ?? "";

/** True when the person on the thread owns the deal: the same address, or the same company domain (not a free-mail one). */
export function ownsDeal(ownerEmail: string | null | undefined, counterpartEmail: string | null | undefined): boolean {
  const owner = (ownerEmail ?? "").toLowerCase().trim();
  const other = (counterpartEmail ?? "").toLowerCase().trim();
  if (!owner || !other) return false;
  if (owner === other) return true;
  const domain = domainOf(owner);
  return !!domain && domain === domainOf(other) && !isBundledPersonalDomain(domain);
}

type DealRow = Record<string, unknown> & { owner_email?: string | null };

/** The deal facts a draft may use. Its owner sees the whole record. Anyone else on the deal (a supplier answering a
 * buyer's request) sees only what the deal is, never who is behind it, their price, notes or site. */
export function dealSummaryText(row: DealRow, counterpartEmail: string | null | undefined): string {
  if (ownsDeal(row.owner_email, counterpartEmail)) {
    const keep = Object.entries(row)
      .filter(([key, value]) => key !== "owner_email" && value !== null && value !== "" && !/(_at|_id|^id|match_hash)$/.test(key) && !(value instanceof Date))
      .slice(0, 40);
    return keep.map(([key, value]) => `${key}: ${(typeof value === "object" ? JSON.stringify(value) : String(value)).slice(0, 400)}`).join("\n");
  }
  const context = (row.context && typeof row.context === "object" ? row.context : {}) as Record<string, unknown>;
  const party = typeof row.party === "string" ? row.party.trim() : "";
  let title = String(context.listing_title ?? row.summary ?? "").slice(0, 200);
  if (party.length > 2) title = title.split(new RegExp(party.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")).join("[the other side]");
  const lines = [
    "This person is on the deal as a counterparty, not its owner. Never name or describe the other side, and never give their price, budget, notes or site.",
    `kind: ${row.kind === "demand" ? "demand (a buyer's request this person may be able to supply)" : String(row.kind ?? "")}`,
    title && `title: ${title}`,
    row.quantity ? `quantity: ${String(row.quantity).slice(0, 100)}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}
