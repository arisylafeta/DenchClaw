import { getPostgresCalendarEvent } from "@/lib/crm-postgres/calendar";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/crm/calendar/:id
 *
 * Returns the full detail for a single calendar_event entry, backed by Postgres.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const eventId = id?.trim();
  if (!eventId) {
    return Response.json({ error: "Missing event id." }, { status: 400 });
  }

  const data = await getPostgresCalendarEvent(eventId);
  if (!data) {
    return Response.json({ error: "Event not found." }, { status: 404 });
  }
  return Response.json(data);
}
