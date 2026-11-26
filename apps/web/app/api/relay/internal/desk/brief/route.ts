import { internalAuthorised } from "@/lib/relay-learn";
import { deskBrief } from "@/lib/relay-desk";
import { isDeskMode } from "@/lib/relay-desk-core";
import { RelayError } from "@/lib/relay";
import { readBody } from "@/lib/relay-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

/** The desk runner (relay_desk.py) asks for one turn's brief and prompt, built fresh from the email as it is now. Internal secret only. */
export async function POST(req: Request) {
  if (!internalAuthorised(req)) return Response.json({ error: "Not found" }, { status: 404 });
  const body = await readBody(req);
  const item = typeof body?.item === "string" ? body.item : "";
  const text = typeof body?.text === "string" ? body.text : "";
  if (!item || item.length > 100 || !isDeskMode(body?.mode)) return Response.json({ error: "item and mode required" }, { status: 400 });
  try {
    // as_of (an ISO time) replays the email as it stood then; only for dry runs, which never write.
    const asOf = body?.dry_run === true && typeof body?.as_of === "string" && !Number.isNaN(Date.parse(body.as_of)) ? new Date(body.as_of).toISOString() : undefined;
    return Response.json(await deskBrief(item, body.mode, text, asOf));
  } catch (error) {
    if (error instanceof RelayError) return Response.json({ error: error.message }, { status: error.status });
    console.error("relay desk brief", error);
    return Response.json({ error: "Couldn't build the brief" }, { status: 500 });
  }
}
