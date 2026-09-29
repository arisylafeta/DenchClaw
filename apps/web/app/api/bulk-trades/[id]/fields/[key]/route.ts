import { parseFieldInput } from "@/lib/bulk-trade-details";
import { setField } from "@/lib/crm-postgres/bulk-trade-details";
import { badRequest, guardBulkTrades, notFound, readJson } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PUT(req: Request, { params }: { params: Promise<{ id: string; key: string }> }) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const parsed = parseFieldInput(await readJson(req));
  if ("error" in parsed) return badRequest(parsed.error);
  const { id, key } = await params;
  const field = await setField(id, key, parsed.value, guard.userId);
  if (field === "unknown_field") return badRequest(`${key} is not a field for this kind of trade.`);
  return field ? Response.json({ field }) : notFound("Trade");
}
