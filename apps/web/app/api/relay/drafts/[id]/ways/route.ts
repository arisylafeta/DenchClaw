import { guardRelay, readBody, relayError } from "@/lib/relay-route";
import { pickWay, prepareWays } from "@/lib/relay-ways";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/** The ways to answer an email. With pick: makes that way the draft. Without: has the other ways written, once, in the background. Never sends. */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const body = await readBody(req);
  try {
    if (body?.pick === undefined) return Response.json(await prepareWays(id, guard.user.id, body?.retry === true));
    if (typeof body.pick !== "number" || typeof body.updated_at !== "string") return Response.json({ error: "pick and updated_at required" }, { status: 400 });
    return Response.json(await pickWay(id, guard.user.id, body.pick, body.updated_at));
  } catch (error) {
    return relayError(error);
  }
}
