import { currentUser } from "@/lib/auth";
import {
  parsePrefs, parseSubscription, pushPublicKey, removeSubscription, saveSubscription, sendPushToUser,
} from "@/lib/web-push";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const unauthorized = () => Response.json({ error: "Unauthorized" }, { status: 401 });
const readBody = async (req: Request): Promise<Record<string, unknown> | null> => {
  try { const body = await req.json(); return body && typeof body === "object" ? body as Record<string, unknown> : null; } catch { return null; }
};

/** The public VAPID key, or 404 when push is not configured on this server. */
export async function GET() {
  if (!(await currentUser())) { return unauthorized(); }
  const publicKey = pushPublicKey();
  return publicKey ? Response.json({ publicKey }) : Response.json({ error: "Push is not configured" }, { status: 404 });
}

/** Register or refresh this device's subscription and its notification prefs. */
export async function PUT(req: Request) {
  const user = await currentUser();
  if (!user) { return unauthorized(); }
  if (!pushPublicKey()) { return Response.json({ error: "Push is not configured" }, { status: 404 }); }
  const body = await readBody(req);
  const subscription = parseSubscription(body?.subscription);
  if (!body || !subscription) { return Response.json({ error: "A valid push subscription is required" }, { status: 400 }); }
  await saveSubscription(user.id, subscription, parsePrefs(body.prefs), req.headers.get("user-agent"));
  return Response.json({ ok: true });
}

/** Remove this device's subscription. */
export async function DELETE(req: Request) {
  const user = await currentUser();
  if (!user) { return unauthorized(); }
  const body = await readBody(req);
  if (typeof body?.endpoint !== "string" || !body.endpoint) { return Response.json({ error: "endpoint is required" }, { status: 400 }); }
  await removeSubscription(user.id, body.endpoint);
  return Response.json({ ok: true });
}

/** Send a test push to this device, to prove the closed-app path works. */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) { return unauthorized(); }
  const body = await readBody(req);
  if (typeof body?.endpoint !== "string" || !body.endpoint) { return Response.json({ error: "endpoint is required" }, { status: 400 }); }
  const delivered = await sendPushToUser(user.id, { title: "ReBattery CRM", body: "Push notifications are working.", tag: "test", url: "/" }, { endpoint: body.endpoint });
  return delivered ? Response.json({ ok: true }) : Response.json({ error: "Could not deliver; turn notifications off and on again" }, { status: 502 });
}
