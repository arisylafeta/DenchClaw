import { guardRelay, relayError } from "@/lib/relay-route";
import { startDealJob } from "@/lib/relay";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/** "Create deal" or "Update deal from this reply": starts Matcha on the email's thread. Nothing is sent. */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const action = (await req.json().catch(() => null) as { action?: unknown } | null)?.action;
  if (action !== "create" && action !== "update") return Response.json({ error: "action must be create or update" }, { status: 400 });
  try { await startDealJob(id, guard.user.id, action); return Response.json({ ok: true }); } catch (error) { return relayError(error); }
}
