import { guardRelay, readBody, relayError } from "@/lib/relay-route";
import { setFill } from "@/lib/relay-price";
import { fillValue } from "@/lib/relay-price-core";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/** Alex's price for one price gap: `{ key, value }`, whole pounds, or value null to clear it. Returns `{ fills }`. */
export async function PUT(req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const body = await readBody(req);
  if (typeof body?.key !== "string" || !("value" in body)) return Response.json({ error: "key and value required" }, { status: 400 });
  const value = fillValue(body.value);
  if ("error" in value) return Response.json({ error: value.error }, { status: 400 });
  try {
    return Response.json({ fills: await setFill(id, guard.user.id, body.key, value.value) });
  } catch (error) {
    return relayError(error);
  }
}
