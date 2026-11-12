import { DEAL_OWNERS, dealOwner } from "@/lib/bulk-owner";
import { openMentionsFor, ownerOfUser } from "@/lib/crm-postgres/bulk-notes";
import { guardBulkTrades } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Team-note mentions not yet ticked: the signed-in person's, or (?for=Sean) another owner's when Today shows their deals. */
export async function GET(req: Request) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const asked = dealOwner(new URL(req.url).searchParams.get("for"));
  const me = await ownerOfUser(guard.userId);
  const person = asked ?? me;
  if (!person) return Response.json({ person: null, me, mentions: [], people: DEAL_OWNERS });
  return Response.json({ person, me, mentions: await openMentionsFor(person) });
}
