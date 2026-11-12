import { guardRelay, relayError } from "@/lib/relay-route";
import { dealChecklistFor, setChecklistState, setChecklistTick } from "@/lib/relay";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/** The deal checklist for an email: what we have from them, what is still missing, and where Qualified stands. */
export async function GET(_req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  try { return Response.json(await dealChecklistFor(id, guard.user.id)); } catch (error) { return relayError(error); }
}

/**
 * Changes the checklist, one of:
 * - `{ key, have }`: ticks or unticks a helpful fact the CRM has no field for;
 * - `{ key, checked }` or `{ key, cannot }`: a person checked an item, or marked that they cannot provide it;
 * - `{ qualified }`: the person's Qualified tick, refused until every item it needs is done.
 */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const body = await req.json().catch(() => null) as { key?: unknown; have?: unknown; checked?: unknown; cannot?: unknown; qualified?: unknown } | null;
  const flag = (v: unknown) => (typeof v === "boolean" ? v : undefined);
  try {
    if (typeof body?.qualified === "boolean") await setChecklistState(id, guard.user, { qualified: body.qualified });
    else if (typeof body?.key === "string" && typeof body.have === "boolean") await setChecklistTick(id, guard.user.id, body.key, body.have);
    else if (typeof body?.key === "string" && (flag(body.checked) !== undefined || flag(body.cannot) !== undefined)) {
      await setChecklistState(id, guard.user, { key: body.key, checked: flag(body.checked), cannot: flag(body.cannot) });
    } else return Response.json({ error: "key with have, checked or cannot; or qualified" }, { status: 400 });
    return Response.json(await dealChecklistFor(id, guard.user.id));
  } catch (error) { return relayError(error); }
}
