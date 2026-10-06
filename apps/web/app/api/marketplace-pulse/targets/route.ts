import { badRequest, guardBulkTrades, readJson } from "@/lib/bulk-trades-route";
import { setTarget } from "@/lib/crm-postgres/marketplace-pulse";
import { isMetricKey } from "@/lib/marketplace-pulse";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** PUT { metric, weekly_target } sets a weekly target; a null target clears it. */
export async function PUT(req: Request) {
  const guard = await guardBulkTrades("Marketplace Pulse");
  if ("response" in guard) return guard.response;
  const body = (await readJson(req)) as { metric?: unknown; weekly_target?: unknown } | null;
  if (!body || !isMetricKey(body.metric)) return badRequest("Unknown metric.");
  const target = body.weekly_target;
  if (target !== null && (typeof target !== "number" || !Number.isFinite(target) || target < 0)) {
    return badRequest("A target is a number of 0 or more, or null to clear it.");
  }
  await setTarget(body.metric, target, guard.userId);
  return Response.json({ metric: body.metric, weekly_target: target });
}
