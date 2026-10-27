import { guardRelay, readBody, relayError } from "@/lib/relay-route";
import { detachFile } from "@/lib/relay";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/** Removes one attachment (by sha256) from an unsent draft. */
export async function DELETE(req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const sha = (await readBody(req))?.sha256;
  if (typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha)) return Response.json({ error: "sha256 required" }, { status: 400 });
  try { await detachFile(id, guard.user.id, sha); return Response.json({ ok: true }); } catch (error) { return relayError(error); }
}
