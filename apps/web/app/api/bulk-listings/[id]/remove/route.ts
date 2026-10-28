import { queryPg } from "@/lib/postgres";
import { getListing } from "@/lib/crm-postgres/bulk-listings";
import { guardBulkTrades, notFound } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** "Remove as bulk trade": closes the listing as not a fit and says so in its Story. The row stays, so it can be reopened. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const listing = await getListing(id);
  if (!listing) return notFound("Listing");
  if (listing.status === "closed") return Response.json({ ok: true, already: true });
  await queryPg("update crm_bulk_listings set status = 'closed', closed_reason = 'not_a_fit', updated_at = now() where id = $1", [id]);
  await queryPg(
    `insert into crm_bulk_listing_activity (bulk_listing_id, kind, title, body, actor_user_id, data) values ($1, 'status', 'Removed as a bulk trade', $2, $3::uuid, $4::jsonb)`,
    [id, `Closed as not a fit by ${guard.email}. Previous status: ${listing.status}.`, guard.userId, JSON.stringify({ previous_status: listing.status, closed_reason: "not_a_fit" })]);
  return Response.json({ ok: true });
}
