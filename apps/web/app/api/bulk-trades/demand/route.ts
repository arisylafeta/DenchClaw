import { parseDemandInput } from "@/lib/bulk-demand";
import { addDemand, crmIdsForEmail, lastMatchRun, listDemand, possibleDemand } from "@/lib/crm-postgres/bulk-demand";
import { badRequest, guardBulkTrades, readJson } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const [demand, possible, matched] = await Promise.all([listDemand(), possibleDemand(), lastMatchRun()]);
  return Response.json({ demand, possible, matched });
}

export async function POST(req: Request) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const parsed = parseDemandInput(await readJson(req), true);
  if ("error" in parsed) return badRequest(parsed.error);
  const input = parsed.value as typeof parsed.value & { buyer: string; wants: string };
  const crm = input.person_id ? {} : await crmIdsForEmail(input.email);
  const demand = await addDemand({ ...crm, ...input }, guard.userId, { source_label: "Added by hand" });
  return Response.json({ demand }, { status: 201 });
}
