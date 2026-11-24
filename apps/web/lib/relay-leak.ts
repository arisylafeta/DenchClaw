import "server-only";
import { queryPg } from "./postgres";
import { stockFits } from "./relay-price";
import type { StockFit } from "./relay-price-types";
import { replyIdentity } from "./relay-identity";
import { draftSide, leakFacts, leaks, moneyMentions, type Leak, type LeakFacts, type Party, type Side } from "./relay-leak-core";
import { knownCosts } from "./relay-linked";
import { secretCosts } from "./relay-linked-core";
import { inPlaySql, viewRoleSql } from "./relay-round";

/**
 * The leak guard, the I/O part: gathers who is on each side of an email's thread (the counterpart, the linked deal's
 * buyer, the suppliers of the stock that fits, every Relay email on it) and checks a draft against them. Used before a
 * chat change is saved and before anything is sent, scheduled or copied to Gmail.
 */

type ItemRow = { id: string; contact_type: string | null; counterpart_name: string | null; counterpart_email: string | null; company: string | null; bulk_listing_id: string | null; mail_thread_id: string | null };
/** One Relay email on the thread as the guard needs it. body: the whole text as it would go. */
export type GuardDraft = { id: string; role: "primary" | "follow"; to_kind: Side | null; to: string[]; body: string };
export type ThreadSides = { side: Side; facts: LeakFacts; kinds: Map<string, Side> };

/** Whose thread this is: the contact's type, else the shared inbox it is on. */
async function itemSide(item: ItemRow): Promise<Side> {
  if (item.contact_type === "buyer") return "buyer";
  if (item.contact_type === "supplier") return "supplier";
  if (!item.mail_thread_id) return "other";
  const messages = await queryPg<{ direction: string; to_emails: string[]; cc_emails: string[]; identity_key: string | null }>(
    `select direction, coalesce(to_emails,'{}') as to_emails, coalesce(cc_emails,'{}') as cc_emails, identity_key from mail_message
     where thread_id = $1 order by coalesce(sent_at, accepted_at, created_at) desc limit 8`, [item.mail_thread_id]);
  const inbox = replyIdentity(messages, item.contact_type);
  return inbox === "buy" ? "buyer" : inbox === "supply" ? "supplier" : "other";
}

/** The buyer on the linked deal, when the deal is a buyer's request. */
async function dealBuyer(listingId: string | null): Promise<Party | null> {
  if (!listingId) return null;
  const [row] = await queryPg<Party & { kind: string }>(
    `select b.kind, p.full_name as name, c.name as company, lower(coalesce(b.email, p.email)) as email
       from crm_bulk_listings b left join crm_people p on p.id = b.person_id left join crm_companies c on c.id = p.company_id where b.id = $1`, [listingId]);
  return row?.kind === "demand" ? { name: row.name, company: row.company, email: row.email } : null;
}

/** The sides of an email's thread and the facts every Relay email on it is checked against. `stock` saves a second
 * read when the caller already has it; `drafts` are the emails as they will be (a chat turn's new text included). */
export async function threadSides(itemId: string, ownerId: string, drafts: GuardDraft[], stock?: StockFit[]): Promise<ThreadSides> {
  const [item] = await queryPg<ItemRow>(
    "select id, contact_type, counterpart_name, counterpart_email, company, bulk_listing_id, mail_thread_id from relay_item where id = $1 and owner_id = $2::uuid", [itemId, ownerId]);
  if (!item) throw new Error("Relay item not found for the leak check");
  const [fits, costs] = await Promise.all([stock ?? stockFits(itemId, ownerId), knownCosts(item)]);
  const side = await itemSide(item);
  const buyerParty = side === "buyer" ? null : await dealBuyer(item.bulk_listing_id);
  const counterpart = { name: item.counterpart_name, company: item.company, email: item.counterpart_email };
  // A supplier's own emails on the thread hold what they want for the stock: those figures are costs.
  const theirs = side === "supplier" && item.mail_thread_id ? await queryPg<{ body_text: string | null }>(
    "select body_text from mail_message where thread_id = $1 and direction = 'inbound' order by coalesce(sent_at, created_at) desc limit 8", [item.mail_thread_id]) : [];
  const supplierEmails = [...fits.map((f) => f.supplier.email), side === "supplier" ? item.counterpart_email : null].filter((e): e is string => !!e).map((e) => e.toLowerCase());
  const buyerEmail = (side === "buyer" ? item.counterpart_email : buyerParty?.email)?.toLowerCase() ?? null;
  const kinds = new Map(drafts.map((d) => [d.id, draftSide({ toKind: d.to_kind, role: d.role, to: d.to }, side, { suppliers: supplierEmails, buyer: buyerEmail })]));
  const facts = leakFacts({
    side, counterpart, dealBuyer: buyerParty,
    // The pack in play and what it cost us, as well as the stock that fits.
    stock: [...fits.map((f) => ({ name: f.supplier.name, email: f.supplier.email, cost: f.cost?.amount ?? null })), ...secretCosts(costs).map((c) => ({ name: c.supplier, email: null, cost: c.amount }))],
    drafts: drafts.map((d) => ({ toKind: kinds.get(d.id) ?? "other", to: d.to, body: d.body })),
    theirAmounts: theirs.flatMap((m) => moneyMentions(m.body_text ?? "").map((x) => x.value)),
  });
  return { side, facts, kinds };
}

/** The Relay emails on an item, as they are now, for the guard. */
export async function guardDrafts(itemId: string): Promise<GuardDraft[]> {
  return queryPg<GuardDraft>(
    `select d.id, ${viewRoleSql("$1")} as role, d.to_kind, coalesce(m.to_emails, '{}') as to, coalesce(m.body_text, '') as body
       from relay_draft d join mail_message m on m.id = d.mail_message_id where ${inPlaySql("$1")}`, [itemId]);
}

/** What one Relay email, as it is now, would leak: checked against everything on its thread, and on the email it goes with. */
export async function draftLeaks(draftId: string, ownerId: string): Promise<{ to: string; problems: Leak[] }> {
  const [row] = await queryPg<{ item_id: string; linked_item_id: string | null }>(
    "select d.item_id, d.linked_item_id from relay_draft d join relay_item i on i.id = d.item_id where d.id = $1 and i.owner_id = $2::uuid", [draftId, ownerId]);
  if (!row) throw new Error("Relay draft not found for the leak check");
  let to = "";
  const problems: Leak[] = [];
  for (const itemId of [row.item_id, row.linked_item_id].filter((id): id is string => !!id)) {
    const drafts = await guardDrafts(itemId);
    const draft = drafts.find((d) => d.id === draftId);
    if (!draft) continue;
    to ||= draft.to.join(", ") || "nobody yet";
    const sides = await threadSides(itemId, ownerId, drafts);
    for (const p of leaks({ toKind: sides.kinds.get(draftId) ?? "other", body: draft.body }, sides.facts)) if (!problems.some((q) => q.text === p.text)) problems.push(p);
  }
  return { to, problems };
}
