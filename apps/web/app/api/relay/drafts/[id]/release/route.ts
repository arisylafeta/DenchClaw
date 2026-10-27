import { guardRelay, relayError } from "@/lib/relay-route";
import { settleStuckSend } from "@/lib/relay";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/** "Check if it went" for a send stuck or failed: sent if Gmail has it, otherwise back to a draft. Never sends. */
export async function POST(_req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  try { return Response.json(await settleStuckSend(id, guard.user.id)); } catch (error) { return relayError(error); }
}
