import { guardRelay, relayError } from "@/lib/relay-route";
import { markDone } from "@/lib/relay";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/** No reply needed: marks the thread read and labels it "4 Sorted" in Gmail (it stays in the inbox), then hides it. */
export async function POST(_req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  try {
    return Response.json({ item: await markDone(id, guard.user.id, guard.user.email) });
  } catch (error) {
    return relayError(error);
  }
}
