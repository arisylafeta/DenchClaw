import { guardRelay, readBody, relayError } from "@/lib/relay-route";
import { addRule, decideRule, deleteRule, listRules } from "@/lib/relay";

export const dynamic = "force-dynamic";

/** Writing rules: his own (add, delete), learned ones (delete rejects them for good) and proposals (approve or reject). */
export async function POST(req: Request) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const body = await readBody(req);
  try {
    if (typeof body?.text === "string" && body.text.trim()) await addRule(guard.user.id, body.text.trim());
    else if (typeof body?.delete === "string") await deleteRule(guard.user.id, body.delete);
    else if (typeof body?.approve === "string") await decideRule(guard.user.id, body.approve, "approve");
    else if (typeof body?.reject === "string") await decideRule(guard.user.id, body.reject, "reject");
    else return Response.json({ error: "text, delete, approve or reject required" }, { status: 400 });
    return Response.json({ rules: await listRules(guard.user.id) });
  } catch (error) {
    return relayError(error);
  }
}
