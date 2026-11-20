import { internalAuthorised } from "@/lib/relay-learn";
import { prepareDrafts } from "@/lib/relay-prepare";
import { RELAY_OWNER_EMAIL, RelayError } from "@/lib/relay";
import { queryPg } from "@/lib/postgres";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 900;

/** Drafts replies ahead of time for the top of "Waiting on you", called by the Hermes job with the internal secret. */
export async function POST(req: Request) {
  if (!internalAuthorised(req)) return Response.json({ error: "Not found" }, { status: 404 });
  try {
    const [owner] = await queryPg<{ id: string }>("select id from crm_users where lower(email) = lower($1)", [RELAY_OWNER_EMAIL]);
    if (!owner) return Response.json({ error: "No Relay owner" }, { status: 404 });
    return Response.json(await prepareDrafts(owner.id));
  } catch (error) {
    console.error("relay prepare", error);
    return Response.json({ error: error instanceof RelayError ? error.message : "Preparing drafts failed" }, { status: 500 });
  }
}
