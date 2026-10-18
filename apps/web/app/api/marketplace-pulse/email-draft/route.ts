import { badRequest, guardBulkTrades, readJson } from "@/lib/bulk-trades-route";
import { createGmailDraft, gmailDraftUrl, parseEmailDraft } from "@/lib/gmail-drafts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Creates a Gmail draft to a marketplace buyer in the signed-in user's own account. Nothing is sent. */
export async function POST(req: Request) {
  const guard = await guardBulkTrades("Marketplace Pulse");
  if ("response" in guard) return guard.response;
  const parsed = parseEmailDraft(await readJson(req));
  if ("error" in parsed) return badRequest(parsed.error);
  try {
    const created = await createGmailDraft(guard.email, parsed.value);
    return Response.json({ url: gmailDraftUrl(guard.email, created.messageId) }, { status: 201 });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Could not create the draft." }, { status: 502 });
  }
}
