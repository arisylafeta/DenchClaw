import { guardRelay, relayError } from "@/lib/relay-route";
import { retryJob } from "@/lib/relay";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/** Retry: runs the agent job again with the same note. */
export async function POST(_req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  try { await retryJob(id, guard.user.id); return Response.json({ ok: true }); } catch (error) { return relayError(error); }
}
