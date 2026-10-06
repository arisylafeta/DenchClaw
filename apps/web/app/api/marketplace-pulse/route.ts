import { guardBulkTrades } from "@/lib/bulk-trades-route";
import { listSuggestions, listTargets, listWeeks } from "@/lib/crm-postgres/marketplace-pulse";
import { followUps } from "@/lib/marketplace-pulse-platform";
import type { PulseData } from "@/lib/marketplace-pulse";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const firstName = (email: string) => {
  const local = email.split("@")[0].split(/[._-]/)[0] ?? "";
  return local ? local[0].toUpperCase() + local.slice(1) : "";
};

/** Weekly numbers and targets from the CRM, and buyers to follow up read fresh from ReBattery. */
export async function GET() {
  const guard = await guardBulkTrades("Marketplace Pulse");
  if ("response" in guard) return guard.response;
  const [{ weeks, collected_at }, targets, suggestions, platform] = await Promise.all([
    listWeeks(12),
    listTargets(),
    listSuggestions(),
    followUps().catch((err) => {
      console.error("[marketplace-pulse] ReBattery read failed", err);
      return null;
    }),
  ]);
  const body: PulseData = {
    weeks, targets, collected_at,
    follow_ups: platform?.followUps ?? [],
    waiting: platform?.waiting ?? [],
    follow_up_error: platform ? null : "Could not read ReBattery just now, so there is no follow-up list.",
    sender: firstName(guard.email),
    suggestions,
  };
  return Response.json(body);
}
