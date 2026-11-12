import { internalAuthorised } from "@/lib/relay-learn";
import { RELAY_OWNER_EMAIL, scanFollowUp } from "@/lib/relay";
import { queryPg } from "@/lib/postgres";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Relay's background work without the page open, called by the inbox scan (relay_scan.py) after each run with the
 * internal secret (no user session): opens the deals of lead cards whose reply has gone, queues "Update deal from this
 * reply" for new replies on deal threads, prepares due chases into Review as drafts (nothing is sent), and marks new
 * supply for standing requests. Relay also does the first two on every inbox load.
 */
export async function POST(req: Request) {
  if (!internalAuthorised(req)) return Response.json({ error: "Not found" }, { status: 404 });
  const [owner] = await queryPg<{ id: string }>("select id from crm_users where lower(email) = lower($1)", [RELAY_OWNER_EMAIL]);
  if (!owner) return Response.json({ error: "No Relay owner" }, { status: 404 });
  const done = await scanFollowUp(owner.id);
  return Response.json({
    ok: true, cards_sent: done.front.sent, deals_opened: done.front.opened.length, updates_queued: done.front.queued.length,
    chases: "error" in done.chases ? done.chases : { prepared: done.chases.prepared.length, cancelled: done.chases.cancelled + done.front.cancelled, refused: done.chases.refused.length },
    new_supply: done.new_supply,
  });
}
