import { demandMatchesV2 } from "@/lib/crm-postgres/demand-matches-v2";
import { recordMatchVerdict } from "@/lib/crm-postgres/demand-supply";
import { REASON_MAX } from "@/lib/crm-postgres/supply-matches";
import { badRequest, guardBulkTrades, linkedWrite, notFound, readJson } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ demandId: string }> };

/** The Matches tab on a request: where we can get it, one ranked list across every source we hold. */
export async function GET(_req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) {
    return guard.response;
  }
  const result = await demandMatchesV2((await params).demandId);
  return result ? Response.json(result) : notFound("Request");
}

/**
 * Not a fit for one unit, with a short reason, kept as Supply activity on the request. On a grouped row (`group:` key)
 * it applies to every unit in the group: one verdict per unit, so each stays hidden on its own, as the reader expects.
 */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) {
    return guard.response;
  }
  const { demandId } = await params;
  const body = await readJson(req) as Record<string, unknown> | null;
  if (!body || typeof body.key !== "string" || !/^(group:)?(listing|stock|trade|supply):/.test(body.key)) return badRequest("Which match?");
  if (typeof body.label !== "string" || !body.label.trim()) return badRequest("Which match?");
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) return badRequest("Say briefly why it is not a fit.");
  if (reason.length > REASON_MAX) return badRequest(`Keep the reason under ${REASON_MAX} characters.`);
  const matches = await demandMatchesV2(demandId);
  if (!matches) return notFound("Request");
  const row = matches.rows.find((item) => item.key === body.key);
  // A unit inside a group is still a match of this request.
  const unit = row ? null : matches.rows.flatMap((item) => item.group?.units ?? []).find((item) => item.key === body.key);
  if (!row && !unit) return notFound("Match");
  const units = row?.group ? row.group.units : [{ key: body.key as string, vehicle: null }];
  return linkedWrite(async () => {
    const activity = [];
    for (const item of units) {
      activity.push(await recordMatchVerdict(demandId, {
        key: item.key, verdict: "not_a_fit", reason,
        title: row?.group ? `${body.label as string}: ${item.vehicle} (group of ${units.length})` : body.label as string,
      }, guard.userId));
    }
    return Response.json({ activity: activity[0], count: activity.length }, { status: 201 });
  });
}
