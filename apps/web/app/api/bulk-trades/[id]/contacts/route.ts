import { parseContactInput } from "@/lib/bulk-trade-details";
import { addContact } from "@/lib/crm-postgres/bulk-trade-details";
import { badRequest, guardBulkTrades, notFound, readJson } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const parsed = parseContactInput(await readJson(req), true);
  if ("error" in parsed) return badRequest(parsed.error);
  const contact = await addContact((await params).id, parsed.value as typeof parsed.value & { name: string }, guard.userId);
  return contact ? Response.json({ contact }, { status: 201 }) : notFound("Trade");
}
