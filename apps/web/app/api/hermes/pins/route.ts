import { currentUser } from "@/lib/auth";
import { resolveAgentBackend } from "@/lib/agent-backend";
import { listPins, PinError, setPin } from "@/lib/hermes-pins";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (resolveAgentBackend() !== "hermes") return Response.json({ error: "Hermes is not enabled" }, { status: 404 });
  try { return Response.json({ pins: await listPins(user.id) }); }
  catch { return Response.json({ error: "Could not load pins" }, { status: 502 }); }
}
export async function PUT(req: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (resolveAgentBackend() !== "hermes") return Response.json({ error: "Hermes is not enabled" }, { status: 404 });
  let body: { key?: unknown; pinned?: unknown };
  try { body = await req.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (typeof body.key !== "string" || !body.key || body.key.length > 2000 || typeof body.pinned !== "boolean") {
    return Response.json({ error: "key (string) and pinned (boolean) are required" }, { status: 400 });
  }
  try { return Response.json({ key: body.key, pinned: body.pinned, pins: await setPin(user.id, body.key, body.pinned) }); }
  catch (error) {
    return error instanceof PinError ? Response.json({ error: error.message }, { status: error.status }) : Response.json({ error: "Could not update pin" }, { status: 502 });
  }
}
