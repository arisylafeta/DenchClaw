import { guardRelay, relayError } from "@/lib/relay-route";
import { listSuggestions } from "@/lib/relay-suggest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The answers Relay suggests for the emails that need a reply. Asking is also what gets the next emails read. */
export async function GET() {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  try {
    return Response.json(await listSuggestions(guard.user));
  } catch (error) {
    return relayError(error);
  }
}
