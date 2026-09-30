import { OUTREACH_STEP, OUTREACH_WORKING_DAYS, addWorkingDays, isValidDate } from "@/lib/dismantlers";
import { todayInLondon } from "@/lib/bulk-trades";
import { startOutreach } from "@/lib/crm-postgres/dismantlers";
import { withPlatform } from "@/lib/dismantlers-platform";
import { badRequest, dismantlerWrite, guardDismantlers, readJson } from "@/lib/dismantlers-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST { ids, next_step?, next_step_due? }: moves a batch to Talking with a follow-up. */
export async function POST(req: Request) {
  const guard = await guardDismantlers();
  if ("response" in guard) return guard.response;
  const body = (await readJson(req)) as Record<string, unknown> | null;
  const ids = Array.isArray(body?.ids) ? body.ids : null;
  if (!ids?.length || ids.length > 200 || !ids.every((id) => typeof id === "string")) return badRequest("Pick 1 to 200 dismantlers.");
  const step = typeof body?.next_step === "string" && body.next_step.trim() ? body.next_step.trim() : OUTREACH_STEP;
  const due = typeof body?.next_step_due === "string" && body.next_step_due ? body.next_step_due : addWorkingDays(todayInLondon(), OUTREACH_WORKING_DAYS);
  if (!isValidDate(due)) return badRequest("next_step_due must be a YYYY-MM-DD date.");
  return dismantlerWrite(async () => {
    const dismantlers = await startOutreach([...new Set(ids as string[])], { next_step: step, next_step_due: due }, guard.userId);
    return Response.json({ dismantlers: (await withPlatform(dismantlers)).dismantlers });
  });
}
