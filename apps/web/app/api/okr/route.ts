import { guardBulkTrades } from "@/lib/bulk-trades-route";
import { listWeeks } from "@/lib/crm-postgres/marketplace-pulse";
import { lastCollectedAt } from "@/lib/crm-postgres/home";
import { okrBulkRows, okrProgress } from "@/lib/crm-postgres/okr";
import { platformRows } from "@/lib/home-platform-read";
import { buildOkr } from "@/lib/okr";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const settle = <T>(promise: Promise<T>, what: string): Promise<{ value: T } | { error: string }> =>
  promise.then((value) => ({ value }), (err: unknown) => {
    console.error(`[okr] ${what} read failed`, err);
    return { error: err instanceof Error ? err.message : String(err) };
  });

/** The OKR viewer: key results, KPI series and baselines for the quarter. */
export async function GET(_req: Request) {
  const guard = await guardBulkTrades("OKRs");
  if ("response" in guard) { return guard.response; }
  const [crm, platform] = await Promise.all([
    // 30 snapshot weeks cover the 21 drawn weeks.
    settle(Promise.all([listWeeks(30), lastCollectedAt(), okrBulkRows(), okrProgress()]), "CRM"),
    settle(platformRows(), "ReBattery platform"),
  ]);
  const [pulse, collectedAt, bulk, progress] = "value" in crm ? crm.value : [null, null, null, {}];
  return Response.json(buildOkr({
    now: new Date(),
    platform: "value" in platform ? platform.value : null,
    pulse: pulse?.weeks ?? [],
    pulseCollectedAt: collectedAt,
    bulk,
    progress,
    errors: { platform: "error" in platform, crm: "error" in crm },
  }));
}
