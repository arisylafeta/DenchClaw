import { guardRelay, relayError } from "@/lib/relay-route";
import { dealOptions } from "@/lib/relay";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Open deals for "Link to deal". */
export async function GET() {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  try { return Response.json({ deals: await dealOptions() }); } catch (error) { return relayError(error); }
}
