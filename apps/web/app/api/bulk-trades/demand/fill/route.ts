import { fillDemandFromText } from "@/lib/demand-fill";
import { badRequest, guardBulkTrades, readJson } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Body: { text }. Returns suggested Add demand fields for Alex to check; nothing is saved. */
export async function POST(req: Request) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const body = (await readJson(req)) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (text.length < 10) return badRequest("Paste the email text first.");
  try {
    return Response.json({ fields: await fillDemandFromText(text) });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Could not read that text." }, { status: 502 });
  }
}
