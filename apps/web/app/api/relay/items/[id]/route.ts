import { guardRelay, readBody, relayError } from "@/lib/relay-route";
import { RELAY_TABS, updateRelayItem, type RelayItemPatch, type RelayTab } from "@/lib/relay";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

/** Saves the note, moves the item to another tab ("Needs reply" moves Other to Action), snoozes it, or reopens it (Undo). */
export async function PATCH(req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const body = await readBody(req);
  const patch: RelayItemPatch = {};
  if (typeof body?.note === "string") patch.note = body.note;
  if (typeof body?.tab === "string") {
    if (!RELAY_TABS.includes(body.tab as RelayTab)) return Response.json({ error: "Unknown tab" }, { status: 400 });
    patch.tab = body.tab as RelayTab;
    if (body.sticky === false) patch.sticky = false;
  }
  if (typeof body?.snooze_until === "string" || body?.snooze_until === null) patch.snooze_until = body.snooze_until as string | null;
  // Undo of Done or "Don't chase": back to open. Closing goes through /done, which also labels the thread in Gmail.
  if (body?.status === "open") { patch.status = "open"; patch.done_reason = ""; }
  try {
    const item = await updateRelayItem(id, guard.user.id, patch);
    return item ? Response.json({ item }) : Response.json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    return relayError(error);
  }
}
