import { z } from "zod";
import { announceBuyRequest, buyRequestAnnouncement, commercialStockAuthorised, unauthorised } from "@/lib/commercial-stock-access";
import { createBuyRequest } from "@/lib/crm-postgres/commercial-stock";

export const runtime = "nodejs";

const input = z.strictObject({
  sourcingRequestId: z.uuid(),
  conversationId: z.uuid().nullable(),
  email: z.email().max(254),
  wants: z.string().trim().min(2).max(2000),
  country: z.string().trim().max(80).nullable(),
  neededBy: z.iso.date().nullable(),
  timing: z.string().trim().max(500).nullable(),
  lines: z.array(z.strictObject({
    groupKey: z.string().regex(/^grp_[0-9a-f]{16}$/),
    quantity: z.number().int().positive().max(100_000),
    targetPriceEur: z.number().positive().max(10_000_000).nullable().optional(),
    label: z.string().trim().max(200).nullable().optional(),
  })).min(1).max(30),
});

/** Saves a commercial buyer's request as demand with the matching stock attached per supplier. Never sends to suppliers. */
export async function POST(request: Request): Promise<Response> {
  if (!commercialStockAuthorised(request)) return unauthorised();
  const parsed = input.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid buy request" }, { status: 400 });
  const result = await createBuyRequest({ ...parsed.data, email: parsed.data.email.toLowerCase() });
  if (result.created) {
    void announceBuyRequest(buyRequestAnnouncement({
      listingId: result.listingId, email: parsed.data.email.toLowerCase(), suppliers: result.suppliers,
      units: parsed.data.lines.reduce((sum, line) => sum + line.quantity, 0),
      lines: result.lines.map((line) => ({ label: line.label, wanted: line.wanted, allocated: line.allocated })),
    }));
  }
  // Only counts go back: the platform never receives supplier identity, stock ids or CRM ids.
  return Response.json({ created: result.created, lines: result.lines.map(({ groupKey, wanted, allocated }) => ({ groupKey, wanted, allocated })) });
}
