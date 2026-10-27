import { guardRelay, readBody, relayError } from "@/lib/relay-route";
import { addRule, deleteRule, listRules } from "@/lib/relay";

export const dynamic = "force-dynamic";

/** Writing rules applied to every Relay draft. */
export async function POST(req: Request) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const body = await readBody(req);
  try {
    if (typeof body?.text === "string" && body.text.trim()) await addRule(guard.user.id, body.text.trim());
    else if (typeof body?.delete === "string") await deleteRule(guard.user.id, body.delete);
    else return Response.json({ error: "text or delete required" }, { status: 400 });
    return Response.json({ rules: await listRules(guard.user.id) });
  } catch (error) {
    return relayError(error);
  }
}
