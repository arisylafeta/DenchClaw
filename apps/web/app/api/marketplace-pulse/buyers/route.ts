import { badRequest, guardBulkTrades, readJson } from "@/lib/bulk-trades-route";
import { addMarketplaceBuyer } from "@/lib/crm-postgres/marketplace-pulse";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

/** POST { email, name } adds a marketplace buyer to the CRM and to Supply update (unless opted out). */
export async function POST(req: Request) {
  const guard = await guardBulkTrades("Marketplace Pulse");
  if ("response" in guard) return guard.response;
  const body = (await readJson(req)) as { email?: unknown; name?: unknown } | null;
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!EMAIL.test(email)) return badRequest("A valid email is needed.");
  // The name is a label for a new person (often the buyer's company); it is never used as a first name.
  return Response.json(await addMarketplaceBuyer(email, name && name.toLowerCase() !== email.toLowerCase() ? name : null), { status: 201 });
}
