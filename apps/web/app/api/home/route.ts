import { guardBulkTrades } from "@/lib/bulk-trades-route";
import { listWeeks } from "@/lib/crm-postgres/marketplace-pulse";
import { bulkRows, lastCollectedAt } from "@/lib/crm-postgres/home";
import { platformRows } from "@/lib/home-platform-read";
import { platformHome } from "@/lib/home-platform";
import { bulkHome } from "@/lib/home-bulk";
import { REPLY_SINCE } from "@/lib/home-metrics";
import { buildHome, type HomeData } from "@/lib/home";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const settle = <T>(promise: Promise<T>, what: string): Promise<{ value: T } | { error: string }> =>
  promise.then((value) => ({ value }), (err: unknown) => {
    console.error(`[home] ${what} read failed`, err);
    return { error: err instanceof Error ? err.message : String(err) };
  });

/** The Home page: this month's goals, marketplace health, the weekly funnel and bulk trades. */
export async function GET() {
  const guard = await guardBulkTrades("Home");
  if ("response" in guard) {return guard.response;}
  const now = new Date();
  const [crm, platform] = await Promise.all([
    // Sixteen snapshot weeks cover the thirteen-week funnel chart and the eight-week comparison.
    settle(Promise.all([listWeeks(16), lastCollectedAt(), bulkRows()]), "CRM"),
    settle(platformRows(), "ReBattery platform"),
  ]);
  const [pulse, collectedAt, bulk] = "value" in crm ? crm.value : [null, null, null];
  const body: HomeData = buildHome({
    now,
    weeks: pulse?.weeks ?? [],
    collectedAt,
    platform: "value" in platform ? platformHome(platform.value, now, REPLY_SINCE) : null,
    platformError: "error" in platform ? "Could not read ReBattery just now, so live marketplace numbers are missing." : null,
    bulk: bulk ? bulkHome(bulk, now) : null,
    crmError: "error" in crm ? "Could not read the CRM just now, so bulk trades and the weekly funnel are missing." : null,
  });
  return Response.json(body);
}
