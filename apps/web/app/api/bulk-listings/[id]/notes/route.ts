import { getListing } from "@/lib/crm-postgres/bulk-listings";
import { addTeamNote, listTeamNotes } from "@/lib/crm-postgres/bulk-notes";
import { badRequest, guardBulkTrades, notFound, readJson } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/** The deal's team notes, newest first. */
export async function GET(_req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  if (!await getListing(id)) return notFound("Listing");
  return Response.json({ notes: await listTeamNotes(id) });
}

/** A team note; @Alex, @Sean and @Ari in it show on that person's Today until they tick it. Nobody is emailed. */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const body = await readJson(req) as { text?: unknown } | null;
  if (typeof body?.text !== "string" || !body.text.trim()) return badRequest("Write the note first.");
  if (!await getListing(id)) return notFound("Listing");
  return Response.json({ note: await addTeamNote(id, body.text, { userId: guard.userId, email: guard.email }) }, { status: 201 });
}
