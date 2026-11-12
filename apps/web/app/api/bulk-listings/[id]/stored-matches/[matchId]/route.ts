import { ALLOWED_EMAILS } from "@/lib/auth";
import { askMatch, extendReservation, matchFailure, matchNo, matchYes, releaseReservation } from "@/lib/crm-postgres/bulk-matches";
import { badRequest, guardBulkTrades, readJson } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string; matchId: string }> };

const CURRENCIES = new Set(["EUR", "GBP", "USD"]);

/**
 * One stored match: ask (returns a draft to read and send; nothing is sent here), yes (one offer at candidate), no (a
 * reason is required; the next best comes in), extend or release its reservation. Offered is set by the database when
 * the linked offer moves to offered.
 */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) { return guard.response; }
  const { id, matchId } = await params;
  const body = await readJson(req) as Record<string, unknown> | null;
  const actor = { userId: guard.userId, email: guard.email };
  try {
    switch (body?.action) {
      case "ask":
        if (!ALLOWED_EMAILS.has(guard.email.toLowerCase())) {
          return Response.json({ error: "Only Ari or Alex can create drafts." }, { status: 403 });
        }
        return Response.json(await askMatch(id, matchId, actor), { status: 201 });
      case "yes": {
        const quantity = body.quantity == null || body.quantity === "" ? null : Number(body.quantity);
        if (quantity != null && !(Number.isFinite(quantity) && quantity > 0)) { return badRequest("The quantity must be more than zero."); }
        if (body.validUntil != null && typeof body.validUntil !== "string") { return badRequest("validUntil must be a date."); }
        let quote: { amount: number; currency: string; unit: string } | null = null;
        if (body.quote != null) {
          const q = body.quote as Record<string, unknown>;
          const amount = Number(q.amount);
          if (!(Number.isFinite(amount) && amount > 0) || typeof q.currency !== "string" || !CURRENCIES.has(q.currency) || typeof q.unit !== "string" || !q.unit.trim()) {
            return badRequest("A quote needs an amount, a currency (EUR, GBP or USD) and a unit.");
          }
          quote = { amount, currency: q.currency, unit: q.unit.trim() };
        }
        return Response.json({ match: await matchYes(id, matchId, { quantity, quote, validUntil: (body.validUntil as string | null | undefined) || null }, actor) });
      }
      case "no":
        if (typeof body.reason !== "string" || !body.reason.trim()) { return badRequest("Say briefly why it is a no."); }
        return Response.json(await matchNo(id, matchId, body.reason, actor));
      case "extend":
        return Response.json({ match: await extendReservation(id, matchId, actor) });
      case "release":
        return Response.json(await releaseReservation(id, matchId, actor));
      default:
        return badRequest("Unknown action.");
    }
  } catch (error) {
    return matchFailure(error);
  }
}
