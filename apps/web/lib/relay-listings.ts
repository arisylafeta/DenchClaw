import "server-only";
import { spawn } from "node:child_process";
import { queryPg } from "./postgres";
import { identitySignatures, splitCopy } from "./mail-draft-actions";
import { editRelayDraft, RelayError, type RelayItem } from "./relay";
import { marketplace } from "./relay-context";
import { apiPayload, declineBody, groupFacts, linkBlock, LISTING_LINK_MARKER, placeLink, type ListingGroup, type ListingProposalView, type ProposalStatus } from "./relay-listings-core";
import { draftRows, isSent, type TalkRow } from "./relay-talk";

/**
 * "Prepare listings and link", the server part (see relay-listings-core.ts). The desk proposes, Alex approves on the
 * card, relay_listings.py does the marketplace writes and hands the link back through finishListings, which puts it into
 * the reply. Nothing here sends an email or publishes a listing.
 */

const RUNNER = process.env.RELAY_LISTINGS_RUNNER || "/root/denchclaw/scripts-live/scripts/rebattery/relay_listings.py";

type ProposalRow = {
  id: string; item_id: string; owner_id: string; seller_email: string; why: string; groups: { group: ListingGroup; payload: Record<string, unknown> }[];
  status: ProposalStatus; listing_ids: string[]; error: string | null; expires_at: string | null; created_at: string;
};

const COLUMNS = "id, item_id, owner_id, seller_email, why, groups, status, listing_ids, error, expires_at::text, created_at::text";

async function latest(itemId: string): Promise<ProposalRow | null> {
  const [row] = await queryPg<ProposalRow>(`select ${COLUMNS} from relay_listing_proposal where item_id = $1 order by created_at desc limit 1`, [itemId]);
  return row ?? null;
}

const view = (p: ProposalRow): ListingProposalView => ({
  id: p.id, status: p.status, sellerEmail: p.seller_email, why: p.why,
  groups: p.groups.map(({ group }) => ({ label: group.label, facts: groupFacts(group) })),
  listingCount: p.listing_ids.length, expiresAt: p.expires_at, error: p.error, createdAt: p.created_at,
});

/** The email's latest proposal for the card and the desk, or null. */
export async function listingProposal(itemId: string): Promise<ListingProposalView | null> {
  const p = await latest(itemId);
  return p ? view(p) : null;
}

/** The reply to the seller, unsent, with its main copy (no signature). */
async function replyOf(itemId: string): Promise<{ row: TalkRow; main: string } | null> {
  const row = (await draftRows(itemId)).find((r) => r.role === "primary" && r.mail_message_id);
  if (!row || isSent(row)) return null;
  return { row, main: splitCopy(row.body_text, (await identitySignatures()).get(row.identity_key ?? "") ?? null).main };
}

const versionOf = (row: TalkRow) => (row.updated_at ? new Date(row.updated_at).toISOString() : "");

/**
 * Who can't have listings prepared: a dismantler with listing permission gets its own account (Ari's rule, 30 Oct 2026),
 * and a seller who already lists adds new stock from their own account. Null when they can.
 */
async function notForThem(email: string): Promise<string | null> {
  const [dismantler] = await queryPg<{ name: string }>(
    `select c.name from crm_dismantlers d join crm_companies c on c.id = d.company_id
       where d.stock_phase = 'marketplace' and (exists (select 1 from crm_people p where p.company_id = d.company_id and lower(p.email) = $1)
         or lower(regexp_replace(c.domain, '^(https?://)?(www[.])?', '')) = split_part($1, '@', 2)) limit 1`, [email]);
  if (dismantler) return `${dismantler.name} is a dismantler with listing permission: it gets its own supplier account (a join link), never listings prepared under ReBattery Sales. Tell Alex; don't propose.`;
  const market = await marketplace(email);
  const lists = market?.accounts.find((a) => a.listingCount > 0);
  if (lists) return `They already list on the marketplace (${lists.name}, ${lists.listingCount} listing${lists.listingCount === 1 ? "" : "s"}): they add new stock from their own account, so send them there instead.`;
  return null;
}

/**
 * The desk's proposal: replaces a proposed, failed or declined one on this email. The reply must carry the marker where
 * the link goes. Refused while one is being created or once one is ready.
 */
export async function proposeListings(item: RelayItem, ownerId: string, groups: ListingGroup[], why: string, dryRun: boolean): Promise<string> {
  const email = (item.counterpart_email ?? "").toLowerCase();
  if (!email) throw new RelayError(422, "This email has no seller address to prepare listings for.");
  const blocked = await notForThem(email);
  if (blocked) throw new RelayError(422, blocked);
  const current = await latest(item.id);
  if (current?.status === "creating") throw new RelayError(409, "Relay is creating the listings for this email now. Wait for it.");
  if (current?.status === "ready") throw new RelayError(409, "Listings are already prepared and the link is in the reply.");
  const rows = groups.map((group, i) => ({ group, payload: apiPayload(group, `relay-${item.id.slice(0, 8)}-${i + 1}`) }));
  const summary = groups.map((g) => `${g.label}: ${groupFacts(g).join("; ")}`).join("\n");
  if (dryRun) return `DRY RUN, nothing was changed. Would propose ${groups.length} draft listing${groups.length === 1 ? "" : "s"} for ${email}:\n${summary}`;
  await queryPg("delete from relay_listing_proposal where item_id = $1 and status in ('proposed', 'failed', 'declined')", [item.id]);
  await queryPg("insert into relay_listing_proposal (item_id, owner_id, seller_email, why, groups) values ($1, $2::uuid, $3, $4, $5::jsonb)",
    [item.id, ownerId, email, why.slice(0, 300), JSON.stringify(rows)]);
  const reply = await replyOf(item.id);
  const marked = !!reply?.main.includes(LISTING_LINK_MARKER);
  return `Proposed ${groups.length} draft listing${groups.length === 1 ? "" : "s"}. Alex approves them on the card above the reply; Relay then creates them and puts the link in.${marked ? "" : ` Now put exactly ${LISTING_LINK_MARKER} in the reply where the link goes (write or update the reply).`}`;
}

/** Alex's approval: the runner creates the drafts and the invitation. */
export async function approveListings(itemId: string, ownerId: string, by: string): Promise<ListingProposalView> {
  const reply = await replyOf(itemId);
  if (!reply) throw new RelayError(409, "There's no unsent reply to put the link in. Ask Relay for the reply first.");
  const [p] = await queryPg<ProposalRow>(
    `update relay_listing_proposal set status = 'creating', approved_by = $3, approved_at = now(), error = null, updated_at = now()
       where id = (select id from relay_listing_proposal where item_id = $1 and owner_id = $2::uuid order by created_at desc limit 1)
         and status in ('proposed', 'failed') returning ${COLUMNS}`, [itemId, ownerId, by]);
  if (!p) throw new RelayError(409, "There's no proposal waiting for approval on this email.");
  try {
    const child = spawn("/usr/bin/python3", [RUNNER, p.id], { detached: true, stdio: "ignore" });
    child.on("error", () => void fail(p.id, "The listing job could not start."));
    child.unref();
  } catch {
    await fail(p.id, "The listing job could not start.");
    throw new RelayError(503, "Relay couldn't start creating the listings. Try again.");
  }
  return view(p);
}

/** Not now: the reply gets the sell page in place of the prepared link. */
export async function declineListings(itemId: string, ownerId: string): Promise<ListingProposalView> {
  const [p] = await queryPg<ProposalRow>(
    `update relay_listing_proposal set status = 'declined', updated_at = now()
       where id = (select id from relay_listing_proposal where item_id = $1 and owner_id = $2::uuid order by created_at desc limit 1)
         and status in ('proposed', 'failed') returning ${COLUMNS}`, [itemId, ownerId]);
  if (!p) throw new RelayError(409, "There's no proposal waiting on this email.");
  const reply = await replyOf(itemId);
  if (reply?.main.includes(LISTING_LINK_MARKER)) {
    await editRelayDraft(reply.row.id, ownerId, versionOf(reply.row), { body: declineBody(reply.main) }, { reason: "The sell page instead of prepared listings", by: "relay" });
  }
  return view(p);
}

async function fail(id: string, error: string): Promise<void> {
  await queryPg("update relay_listing_proposal set status = 'failed', error = $2, pid = null, updated_at = now() where id = $1 and status = 'creating'", [id, error.slice(0, 300)]);
}

/**
 * The runner's result. On success the link block goes into the reply (where the marker is, else before the sign-off)
 * and only the ids and expiry are kept; the link itself is never stored. Internal endpoint only.
 */
export async function finishListings(id: string, result: { ok: true; links: { label: string; url: string }[]; listingIds: string[]; invitationIds: string[]; expiresAt: string } | { ok: false; error: string }): Promise<void> {
  const [p] = await queryPg<ProposalRow>(`select ${COLUMNS} from relay_listing_proposal where id = $1 and status = 'creating'`, [id]);
  if (!p) throw new RelayError(409, "That proposal isn't being created.");
  if (!result.ok) return fail(id, result.error);
  // Ids are recorded first, so a failure placing the link still shows what exists on the marketplace.
  await queryPg("update relay_listing_proposal set listing_ids = $2, invitation_ids = $3, expires_at = $4::timestamptz, updated_at = now() where id = $1",
    [id, result.listingIds, result.invitationIds, result.expiresAt]);
  const reply = await replyOf(p.item_id);
  if (!reply) return fail(id, "The drafts and link were made, but the reply was gone or already sent, so the link wasn't placed. Ask for the link again.");
  await editRelayDraft(reply.row.id, p.owner_id, versionOf(reply.row), { body: placeLink(reply.main, linkBlock(result.links)) }, { reason: "The prepared listings' link", by: "relay" });
  await queryPg("update relay_listing_proposal set status = 'ready', ready_at = now(), pid = null, updated_at = now() where id = $1", [id]);
}

/** A runner that died without reporting: failed after 15 minutes, so the card offers a retry. */
export async function settleStaleListings(itemId: string): Promise<void> {
  await queryPg(`update relay_listing_proposal set status = 'failed', error = 'The listing job stopped without finishing. Check the marketplace before trying again.', updated_at = now()
    where item_id = $1 and status = 'creating' and updated_at < now() - interval '15 minutes'`, [itemId]);
}
