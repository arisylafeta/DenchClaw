import { guardBulkTrades } from "@/lib/bulk-trades-route";
import { listTargets, listWeeks } from "@/lib/crm-postgres/marketplace-pulse";
import { followUps } from "@/lib/marketplace-pulse-platform";
import type { FollowUp, PulseData } from "@/lib/marketplace-pulse";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Weekly numbers and targets from the CRM, and buyers to follow up read fresh from ReBattery. */
export async function GET() {
  const guard = await guardBulkTrades("Marketplace Pulse");
  if ("response" in guard) return guard.response;
  const [{ weeks, collected_at }, targets, followUp] = await Promise.all([
    listWeeks(12),
    listTargets(),
    followUps().then(
      (list): [FollowUp[], string | null] => [list, null],
      (err): [FollowUp[], string | null] => {
        console.error("[marketplace-pulse] ReBattery read failed", err);
        return [[], "Could not read ReBattery just now, so there is no follow-up list."];
      },
    ),
  ]);
  const body: PulseData = { weeks, targets, collected_at, follow_ups: followUp[0], follow_up_error: followUp[1] };
  return Response.json(body);
}
