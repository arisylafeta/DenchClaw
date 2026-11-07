import { guardRelay, relayError } from "@/lib/relay-route";
import { dealChecklistFor, setChecklistTick } from "@/lib/relay";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/** The deal checklist for an email: what we have from them and what is still missing. */
export async function GET(_req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  try { return Response.json(await dealChecklistFor(id, guard.user.id)); } catch (error) { return relayError(error); }
}

/** Ticks or unticks a helpful fact the CRM has no field for. */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const body = await req.json().catch(() => null) as { key?: unknown; have?: unknown } | null;
  if (typeof body?.key !== "string" || typeof body.have !== "boolean") return Response.json({ error: "key and have required" }, { status: 400 });
  try {
    await setChecklistTick(id, guard.user.id, body.key, body.have);
    return Response.json(await dealChecklistFor(id, guard.user.id));
  } catch (error) { return relayError(error); }
}
