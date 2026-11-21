import { guardRelay, relayError } from "@/lib/relay-route";
import { searchContacts } from "@/lib/relay-contacts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Address autocomplete for To, Cc and Bcc: `?q=` returns `{ contacts }`. Read only. */
export async function GET(req: Request) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const q = new URL(req.url).searchParams.get("q") ?? "";
  try {
    return Response.json({ contacts: await searchContacts(q.slice(0, 100)) });
  } catch (error) {
    return relayError(error);
  }
}
