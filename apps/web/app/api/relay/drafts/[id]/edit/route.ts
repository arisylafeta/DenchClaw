import { guardRelay, readBody, relayError } from "@/lib/relay-route";
import { editRelayDraft, type DraftEdit } from "@/lib/relay";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

const list = (v: unknown) => (Array.isArray(v) && v.every((a) => typeof a === "string") ? v.map((a) => a.trim().toLowerCase()).filter(Boolean) : undefined);

/** Alex's own edit of a Relay draft: `{ updated_at, body?, subject?, to?, cc?, bcc? }`. Never sends. */
export async function PATCH(req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const body = await readBody(req);
  if (!body || typeof body.updated_at !== "string") return Response.json({ error: "updated_at required" }, { status: 400 });
  for (const k of ["to", "cc", "bcc"] as const) if (body[k] !== undefined && !list(body[k])) return Response.json({ error: `${k} must be a list of addresses` }, { status: 400 });
  for (const k of ["body", "subject"] as const) if (body[k] !== undefined && typeof body[k] !== "string") return Response.json({ error: `${k} must be text` }, { status: 400 });
  const edit: DraftEdit = { body: body.body as string | undefined, subject: body.subject as string | undefined, to: list(body.to), cc: list(body.cc), bcc: list(body.bcc) };
  try {
    await editRelayDraft(id, guard.user.id, body.updated_at, edit);
    return Response.json({ ok: true });
  } catch (error) {
    return relayError(error);
  }
}
