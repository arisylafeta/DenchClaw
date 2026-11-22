import { guardRelay, relayError } from "@/lib/relay-route";
import { stopDesk } from "@/lib/relay-desk";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/** Stops the desk turn on this email: the runner kills it within a couple of seconds. Changes it already made stay (Undo works). */
export async function POST(_req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  try {
    return Response.json({ run: await stopDesk(id, guard.user.id) });
  } catch (error) {
    return relayError(error);
  }
}
