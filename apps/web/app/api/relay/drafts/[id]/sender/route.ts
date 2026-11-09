import { guardRelay, readBody, relayError } from "@/lib/relay-route";
import { changeSender } from "@/lib/relay";
import { isSenderKey } from "@/lib/relay-senders";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/** Changes who one unsent Relay draft is from (`identity`: alex, supply, buy or hello), for the version Alex saw (`updated_at`). */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const body = await readBody(req);
  if (!isSenderKey(body?.identity) || typeof body?.updated_at !== "string") {
    return Response.json({ error: "identity and updated_at required" }, { status: 400 });
  }
  try {
    await changeSender(id, guard.user.id, body.identity, body.updated_at);
    return Response.json({ changed: true });
  } catch (error) {
    return relayError(error);
  }
}
