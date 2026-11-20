import { guardRelay, relayError } from "@/lib/relay-route";
import { listWaiting } from "@/lib/relay-rank";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** "Waiting on you": one row per person, ranked now, by band, plus the counts on the view tabs. */
export async function GET() {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  try {
    return Response.json(await listWaiting(guard.user.id));
  } catch (error) {
    return relayError(error);
  }
}
