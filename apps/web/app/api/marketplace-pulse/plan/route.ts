import { badRequest, guardBulkTrades, readJson } from "@/lib/bulk-trades-route";
import { savePlan } from "@/lib/crm-postgres/marketplace-pulse";
import { parsePlan } from "@/lib/marketplace-pulse-plan";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST { plan } saves the growth plan as a new version. */
export async function POST(req: Request) {
  const guard = await guardBulkTrades("Marketplace Pulse");
  if ("response" in guard) return guard.response;
  const body = (await readJson(req)) as { plan?: unknown } | null;
  const parsed = parsePlan(body?.plan);
  if ("error" in parsed) return badRequest(parsed.error);
  return Response.json({ plan: await savePlan(parsed.plan, guard.userId) }, { status: 201 });
}
