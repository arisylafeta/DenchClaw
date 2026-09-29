import { getBulkTrade } from "@/lib/crm-postgres/bulk-trades";
import { buyerOnTrade, createTrackedLinks, logEmailDraft } from "@/lib/crm-postgres/bulk-trade-details";
import { createGmailDraft, gmailDraftUrl, parseEmailDraft } from "@/lib/gmail-drafts";
import { linksIn, replaceLinks, trackedLinkBase } from "@/lib/tracked-links";
import { badRequest, guardBulkTrades, notFound, readJson } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Creates a Gmail draft in the signed-in user's own account. Nothing is sent. With link tracking
 * configured, each web link becomes a tracked link unique to this draft (and buyer, if given).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const input = (await readJson(req)) as Record<string, unknown> | null;
  const parsed = parseEmailDraft(input);
  if ("error" in parsed) return badRequest(parsed.error);

  const { id } = await params;
  if (!(await getBulkTrade(id))) return notFound("Trade");
  const buyerId = typeof input?.buyer_id === "string" && input.buyer_id ? input.buyer_id : null;
  if (buyerId && !(await buyerOnTrade(id, buyerId))) return notFound("Buyer");

  const draft = { ...parsed.value };
  const base = trackedLinkBase();
  let tracked = 0;
  if (base && input?.track_links !== false) {
    const urls = linksIn(draft.body).filter((url) => !url.startsWith(`${base}/t/`));
    const tokens = await createTrackedLinks(id, buyerId, draft.to.join(", ") || null, urls, guard.userId);
    draft.body = replaceLinks(draft.body, new Map([...tokens].map(([url, token]) => [url, `${base}/t/${token}`])));
    tracked = tokens.size;
  }

  let created;
  try {
    created = await createGmailDraft(guard.email, draft);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Could not create the draft." }, { status: 502 });
  }
  await logEmailDraft(id, { to: draft.to, subject: draft.subject, draft_id: created.draftId, buyer_id: buyerId, tracked_links: tracked }, guard.userId);
  return Response.json({ url: gmailDraftUrl(guard.email, created.messageId), tracked_links: tracked }, { status: 201 });
}
