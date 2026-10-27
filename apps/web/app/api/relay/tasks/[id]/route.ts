import { guardRelay, readBody, relayError } from "@/lib/relay-route";
import { draftForTask, updateTask } from "@/lib/relay";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;
type Context = { params: Promise<{ id: string }> };

/** done | retire | reopen | snooze {until} | draft (reply on the task's thread from its note, into Review). */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const body = await readBody(req);
  const action = body?.action;
  try {
    if (action === "draft") return Response.json(await draftForTask(id, guard.user));
    if (action === "done" || action === "retire" || action === "reopen") { await updateTask(id, guard.user, action); return Response.json({ ok: true }); }
    if (action === "snooze") { await updateTask(id, guard.user, "snooze", typeof body?.until === "string" ? body.until : undefined); return Response.json({ ok: true }); }
    return Response.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    return relayError(error);
  }
}
