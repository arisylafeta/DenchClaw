import { resolveConflict } from "@/lib/crm-postgres/bulk-trade-details";
import { badRequest, guardBulkTrades, notFound, readJson } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Body: { choice: -1 } keeps the current value, { choice: n } takes alternative n. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; key: string }> }) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const body = (await readJson(req)) as { choice?: unknown } | null;
  const choice = body?.choice;
  if (typeof choice !== "number" || !Number.isInteger(choice) || choice < -1) {
    return badRequest("choice must be -1 or an alternative's index.");
  }
  const { id, key } = await params;
  const field = await resolveConflict(id, key, choice, guard.userId);
  return field ? Response.json({ field }) : notFound("Conflict");
}
