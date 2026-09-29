import { parseBuyerInput } from "@/lib/bulk-trade-details";
import { addBuyer } from "@/lib/crm-postgres/bulk-trade-details";
import { badRequest, guardBulkTrades, linkedWrite, notFound, readJson } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const parsed = parseBuyerInput(await readJson(req), true);
  if ("error" in parsed) return badRequest(parsed.error);
  const { id } = await params;
  return linkedWrite(async () => {
    const buyer = await addBuyer(id, parsed.value as typeof parsed.value & { name: string }, guard.userId);
    return buyer ? Response.json({ buyer }, { status: 201 }) : notFound("Trade");
  });
}
