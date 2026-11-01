import { internalAuthorised, learnFromSends } from "@/lib/relay-learn";
import { RELAY_OWNER_EMAIL, RelayError } from "@/lib/relay";
import { queryPg } from "@/lib/postgres";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The weekly learning run, called by the Hermes job on this server with the internal secret (no user session). */
export async function POST(req: Request) {
  if (!internalAuthorised(req)) return Response.json({ error: "Not found" }, { status: 404 });
  try {
    const [owner] = await queryPg<{ id: string }>("select id from crm_users where lower(email) = lower($1)", [RELAY_OWNER_EMAIL]);
    if (!owner) return Response.json({ error: "No Relay owner" }, { status: 404 });
    return Response.json(await learnFromSends(owner.id));
  } catch (error) {
    console.error("relay learn", error);
    return Response.json({ error: error instanceof RelayError ? error.message : "Learning run failed" }, { status: 500 });
  }
}
