import { guardRelay, readBody, relayError } from "@/lib/relay-route";
import { acceptFill } from "@/lib/relay-price";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/** Alex accepts Relay's price for one gap as it is (`{ key }`): it becomes his, and a re-price keeps it. Returns `{ fills }`. */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const body = await readBody(req);
  if (typeof body?.key !== "string") return Response.json({ error: "key required" }, { status: 400 });
  try {
    return Response.json({ fills: await acceptFill(id, guard.user.id, body.key) });
  } catch (error) {
    return relayError(error);
  }
}
