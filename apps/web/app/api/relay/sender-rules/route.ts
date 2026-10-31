import { guardRelay, readBody, relayError } from "@/lib/relay-route";
import { addSenderRule, deleteSenderRule, listSenderRules } from "@/lib/relay";

export const dynamic = "force-dynamic";

/** Sorting rules: "always needs a reply" or "never needs a reply" for a sender's company (or address, for free mail). */
export async function POST(req: Request) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const body = await readBody(req);
  try {
    if (typeof body?.email === "string" && (body.tab === "action" || body.tab === "other")) {
      const rule = await addSenderRule(guard.user.id, body.email, body.tab);
      return Response.json({ rule, rules: await listSenderRules(guard.user.id) });
    }
    if (typeof body?.delete === "string") {
      await deleteSenderRule(guard.user.id, body.delete);
      return Response.json({ rules: await listSenderRules(guard.user.id) });
    }
    return Response.json({ error: "email and tab, or delete, required" }, { status: 400 });
  } catch (error) {
    return relayError(error);
  }
}
