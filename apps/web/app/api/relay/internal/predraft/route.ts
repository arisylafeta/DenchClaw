import { internalAuthorised } from "@/lib/relay-learn";
import { predraftPending, predraftReplay, RELAY_OWNER_EMAIL } from "@/lib/relay";
import { queryPg } from "@/lib/postgres";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 600;

/**
 * Relay's drafts before Alex writes a note, called by the scan on this server with the internal secret.
 * {} drafts the emails that need one (at most 10, about six minutes). {cases: [...]} replays past emails for the eval and stores nothing.
 */
export async function POST(req: Request) {
  if (!internalAuthorised(req)) return Response.json({ error: "Not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { cases?: unknown; limit?: unknown; mode?: unknown };
  try {
    const [owner] = await queryPg<{ id: string }>("select id from crm_users where lower(email) = lower($1)", [RELAY_OWNER_EMAIL]);
    if (!owner) return Response.json({ error: "No Relay owner" }, { status: 404 });
    if (Array.isArray(body.cases)) return Response.json({ results: await predraftReplay(owner.id, body.cases.slice(0, 10) as Parameters<typeof predraftReplay>[1], body.mode === "options" ? "options" : "draft") });
    const limit = typeof body.limit === "number" ? Math.max(1, Math.min(10, body.limit)) : 10;
    return Response.json(await predraftPending(owner.id, limit));
  } catch (error) {
    console.error("relay predraft", error);
    return Response.json({ error: "Pre-drafting failed" }, { status: 500 });
  }
}
