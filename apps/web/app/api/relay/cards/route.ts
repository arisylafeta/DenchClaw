import { guardRelay, relayError } from "@/lib/relay-route";
import { listLeadCards } from "@/lib/relay-lead";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The lead cards to work through and Alex's saved answers. Asking is also what gets new lead emails read into cards. */
export async function GET() {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  try {
    return Response.json(await listLeadCards(guard.user));
  } catch (error) {
    return relayError(error);
  }
}
