import { getDismantler, logEmailDraft } from "@/lib/crm-postgres/dismantlers";
import { createGmailDraft, gmailDraftUrl, parseEmailDraft } from "@/lib/gmail-drafts";
import { badRequest, guardDismantlers, notFound, readJson } from "@/lib/dismantlers-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Creates a Gmail draft in the signed-in user's own account. Nothing is sent. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardDismantlers();
  if ("response" in guard) return guard.response;
  const parsed = parseEmailDraft(await readJson(req));
  if ("error" in parsed) return badRequest(parsed.error);
  const { id } = await params;
  if (!(await getDismantler(id))) return notFound("Dismantler");

  let created;
  try {
    created = await createGmailDraft(guard.email, parsed.value);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Could not create the draft." }, { status: 502 });
  }
  await logEmailDraft(id, { to: parsed.value.to, subject: parsed.value.subject, draft_id: created.draftId }, guard.userId);
  return Response.json({ url: gmailDraftUrl(guard.email, created.messageId) }, { status: 201 });
}
