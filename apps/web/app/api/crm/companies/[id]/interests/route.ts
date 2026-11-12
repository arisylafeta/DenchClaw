import { currentUser } from "@/lib/auth";
import {
  InterestInvalid,
  InterestReadOnly,
  createBuyerInterest,
  expireBuyerInterest,
  listBuyerInterests,
  updateBuyerInterest,
  type InterestInput,
} from "@/lib/crm-postgres/buyer-interest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET   /api/crm/companies/:id/interests   live wants, synced lines with their source
 * POST  /api/crm/companies/:id/interests   add a mastered want (standing, interest, inferred)
 * PATCH /api/crm/companies/:id/interests   edit a mastered want, or expire it with {"id": "...", "action": "expire"}
 *
 * Synced lines (ask, saved_search, bought, declined) are read-only here: they change only at their source row.
 */
export async function GET(_req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) {return Response.json({ error: "Unauthorized" }, { status: 401 });}
  const { id } = await ctx.params;
  const companyId = id?.trim();
  if (!companyId) {return Response.json({ error: "Missing company id." }, { status: 400 });}
  try {
    return Response.json({ interests: await listBuyerInterests(companyId) });
  } catch {
    return Response.json({ error: "Could not load wants." }, { status: 500 });
  }
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export async function POST(req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) {return Response.json({ error: "Unauthorized" }, { status: 401 });}
  const { id } = await ctx.params;
  const companyId = id?.trim();
  if (!companyId) {return Response.json({ error: "Missing company id." }, { status: 400 });}
  const body = await readBody(req);
  if (!body) {return Response.json({ error: "Send a JSON object." }, { status: 400 });}
  try {
    const line = await createBuyerInterest(companyId, body as InterestInput);
    return Response.json({ interest: line }, { status: 201 });
  } catch (error) {
    if (error instanceof InterestReadOnly) {return Response.json({ error: error.message }, { status: 403 });}
    if (error instanceof InterestInvalid) {return Response.json({ error: error.message }, { status: 400 });}
    return Response.json({ error: "Could not save the want." }, { status: 500 });
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  const user = await currentUser();
  if (!user) {return Response.json({ error: "Unauthorized" }, { status: 401 });}
  const { id } = await ctx.params;
  const companyId = id?.trim();
  if (!companyId) {return Response.json({ error: "Missing company id." }, { status: 400 });}
  const body = await readBody(req);
  if (!body) {return Response.json({ error: "Send a JSON object." }, { status: 400 });}
  const interestId = typeof body.id === "string" ? body.id.trim() : "";
  if (!interestId) {return Response.json({ error: "Missing want id." }, { status: 400 });}
  const patch: InterestInput = { ...body };
  delete (patch as Record<string, unknown>).id;
  const action = body.action;
  delete (patch as Record<string, unknown>).action;
  try {
    const line = action === "expire"
      ? await expireBuyerInterest(companyId, interestId)
      : await updateBuyerInterest(companyId, interestId, patch);
    if (!line) {return Response.json({ error: "Want not found." }, { status: 404 });}
    return Response.json({ interest: line });
  } catch (error) {
    if (error instanceof InterestReadOnly) {return Response.json({ error: error.message }, { status: 403 });}
    if (error instanceof InterestInvalid) {return Response.json({ error: error.message }, { status: 400 });}
    return Response.json({ error: "Could not save the want." }, { status: 500 });
  }
}
