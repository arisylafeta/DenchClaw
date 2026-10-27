import { guardRelay, readBody, relayError } from "@/lib/relay-route";
import { attachStockList, suggestStockFilters, type StockFilters } from "@/lib/relay";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 180;
type Context = { params: Promise<{ id: string }> };

const list = (v: unknown) => (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()).slice(0, 20);

/** Suggested filters for this email's stock list. */
export async function GET(_req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  try { return Response.json({ filters: await suggestStockFilters(id, guard.user.id) }); } catch (error) { return relayError(error); }
}

/** Builds the stock list with these filters and attaches it to the draft. */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const b = (await readBody(req)) ?? {};
  const minKwh = typeof b.minKwh === "number" && Number.isFinite(b.minKwh) ? b.minKwh : null;
  const filters: StockFilters = {
    chemistry: list(b.chemistry), types: list(b.types).filter((t) => ["pack", "module", "cell", "container"].includes(t)), makes: list(b.makes),
    countries: list(b.countries), minKwh, prices: b.prices === true, currency: b.currency === "EUR" ? "EUR" : "GBP",
  };
  try { return Response.json({ summary: await attachStockList(id, guard.user.id, filters) }); } catch (error) { return relayError(error); }
}
