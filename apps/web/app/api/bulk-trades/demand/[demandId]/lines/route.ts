import { parseLines } from "@/lib/demand-lines";
import { setDemandLines } from "@/lib/crm-postgres/bulk-demand";
import { badRequest, guardBulkTrades, notFound, readJson } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ demandId: string }> };

/** Replaces a request's pack types (Group matches counts stock against them). Body: { lines: [...] }; [] removes them. */
export async function PUT(req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const body = await readJson(req) as Record<string, unknown> | null;
  if (!body || !("lines" in body)) return badRequest("lines is required.");
  const parsed = parseLines(body.lines);
  if ("error" in parsed) return badRequest(parsed.error);
  const lines = await setDemandLines((await params).demandId, parsed.value);
  return lines ? Response.json({ lines }) : notFound("Request");
}
