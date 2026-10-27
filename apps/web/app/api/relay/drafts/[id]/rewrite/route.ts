import { guardRelay, readBody, relayError } from "@/lib/relay-route";
import { rewriteDraft } from "@/lib/relay";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 180;
type Context = { params: Promise<{ id: string }> };

/** AI edit of a draft: "Shorter", "Warmer" or any instruction. Saves the new copy; never sends. */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const instruction = (await readBody(req))?.instruction;
  if (typeof instruction !== "string" || !instruction.trim() || instruction.length > 1000) return Response.json({ error: "instruction required" }, { status: 400 });
  try {
    return Response.json(await rewriteDraft(id, guard.user.id, instruction.trim()));
  } catch (error) {
    return relayError(error);
  }
}
