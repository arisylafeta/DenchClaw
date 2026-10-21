import { getListing } from "@/lib/crm-postgres/bulk-listings";
import { ACTIVITY_KINDS, ACTIVITY_REF_KINDS, addDemandActivity, listDemandActivity, type DemandActivityInput } from "@/lib/crm-postgres/bulk-demand-activity";
import { badRequest, guardBulkTrades, linkedWrite, notFound, readJson } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  if (!await getListing(id)) return notFound("Listing");
  return Response.json({ activity: await listDemandActivity(id) });
}

export async function POST(req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const body = await readJson(req) as Record<string, unknown> | null;
  if (!body || !(ACTIVITY_KINDS as readonly unknown[]).includes(body.kind)) return badRequest("Invalid activity kind.");
  if (typeof body.title !== "string" || !body.title.trim()) return badRequest("Title is required.");
  if (body.body != null && typeof body.body !== "string") return badRequest("Body must be text.");
  if (body.refKind != null && !(ACTIVITY_REF_KINDS as readonly unknown[]).includes(body.refKind)) return badRequest("Invalid reference kind.");
  if (body.refId != null && typeof body.refId !== "string") return badRequest("Reference must be text.");
  if (body.data != null && (typeof body.data !== "object" || Array.isArray(body.data))) return badRequest("Data must be an object.");
  if (body.occurredAt != null && (typeof body.occurredAt !== "string" || !Number.isFinite(Date.parse(body.occurredAt)))) return badRequest("Invalid activity date.");
  if (!await getListing(id)) return notFound("Listing");
  return linkedWrite(async () => Response.json({ activity: await addDemandActivity({
    demandId: id, kind: body.kind as DemandActivityInput["kind"], title: body.title as string,
    body: body.body as string | undefined, refKind: body.refKind as DemandActivityInput["refKind"],
    refId: body.refId as string | undefined, data: body.data as Record<string, unknown> | undefined,
    occurredAt: body.occurredAt as string | undefined, actorUserId: guard.userId,
  }) }, { status: 201 }));
}
