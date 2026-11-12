import { internalAuthorised } from "@/lib/relay-learn";
import { frontDoor, RELAY_OWNER_EMAIL } from "@/lib/relay";
import { queryPg } from "@/lib/postgres";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The front door's background work without the page open: opens the deals of lead cards whose reply has gone and
 * queues "Update deal from this reply" for new replies on deal threads. For a scheduled caller on this server, with the
 * internal secret (no user session). Relay also does this on every inbox load.
 */
export async function POST(req: Request) {
  if (!internalAuthorised(req)) return Response.json({ error: "Not found" }, { status: 404 });
  const [owner] = await queryPg<{ id: string }>("select id from crm_users where lower(email) = lower($1)", [RELAY_OWNER_EMAIL]);
  if (!owner) return Response.json({ error: "No Relay owner" }, { status: 404 });
  await frontDoor(owner.id);
  return Response.json({ ok: true });
}
