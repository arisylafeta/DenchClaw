import { guardBulkTrades } from "@/lib/bulk-trades-route";
import { listWeeks } from "@/lib/crm-postgres/marketplace-pulse";
import { lastCollectedAt } from "@/lib/crm-postgres/home";
import { followUps } from "@/lib/marketplace-pulse-platform";
import { buildHome, type HomeData } from "@/lib/home-metrics";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The Home page: Marketplace Pulse's weekly numbers against the targets, and buyers waiting on us. */
export async function GET() {
  const guard = await guardBulkTrades("Home");
  if ("response" in guard) return guard.response;
  const [{ weeks }, collectedAt, platform] = await Promise.all([
    // Sixteen weeks covers the twelve-week chart, last month and the week before last.
    listWeeks(16),
    lastCollectedAt(),
    followUps().catch((err) => {
      console.error("[home] ReBattery read failed", err);
      return null;
    }),
  ]);
  const body: HomeData = buildHome({
    now: new Date(),
    weeks,
    collectedAt,
    waiting: platform?.waiting ?? [],
    followUps: platform?.followUps ?? [],
    followUpError: platform ? null : "Could not read ReBattery just now, so buyers waiting on us are missing.",
  });
  return Response.json(body);
}
