import { badRequest, guardBulkTrades, notFound, readJson } from "@/lib/bulk-trades-route";
import { abandonListing, reopenListing } from "@/lib/crm-postgres/bulk-listing-abandon";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Deals board, dropped on Abandoned. Body: { reason, note? }. Closes the listing with the reason and marks its live offers lost. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const body = (await readJson(req)) as { reason?: unknown; note?: unknown } | null;
  if (!body || typeof body !== "object") return badRequest("Body must be an object.");
  if (body.note != null && typeof body.note !== "string") return badRequest("note must be text.");
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 1000) : null;
  const { id } = await params;
  const result = await abandonListing(id, body.reason, note, { userId: guard.userId, email: guard.email });
  if (result === "missing") return notFound("Listing");
  if (result === "bad_reason") return badRequest("Pick a reason this listing stopped.");
  if (result === "closed") return Response.json({ error: "This listing is already closed. Refresh the board." }, { status: 409 });
  return Response.json({ ok: true });
}

/** Dragged out of Abandoned: reopens the listing and restores the offers the abandon marked lost. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const result = await reopenListing(id, { userId: guard.userId, email: guard.email });
  if (result === "missing") return notFound("Listing");
  if (result === "open") return Response.json({ ok: true, already: true });
  return Response.json({ ok: true });
}
