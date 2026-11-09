import { currentUser } from "@/lib/auth";
import { saveMailAttachmentToDrive } from "@/lib/mail-attachments";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Saves one attachment of a message the user can see to their own Google Drive. Body: { name }. */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
  const name = typeof body?.name === "string" ? body.name : "";
  const result = await saveMailAttachmentToDrive(id, user, name);
  if ("error" in result) return Response.json({ error: result.error, message: result.message }, { status: result.status });
  return Response.json(result);
}
