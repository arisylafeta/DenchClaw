import { parseContactInput } from "@/lib/bulk-trade-details";
import { removeContact, updateContact } from "@/lib/crm-postgres/bulk-trade-details";
import { badRequest, guardBulkTrades, notFound, readJson } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; contactId: string }> };

export async function PATCH(req: Request, { params }: Params) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const parsed = parseContactInput(await readJson(req), false);
  if ("error" in parsed) return badRequest(parsed.error);
  const { id, contactId } = await params;
  const contact = await updateContact(id, contactId, parsed.value, guard.userId);
  return contact ? Response.json({ contact }) : notFound("Contact");
}

export async function DELETE(_req: Request, { params }: Params) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const { id, contactId } = await params;
  return (await removeContact(id, contactId, guard.userId))
    ? new Response(null, { status: 204 })
    : notFound("Contact");
}
