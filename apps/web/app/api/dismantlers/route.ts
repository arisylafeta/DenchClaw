import { parseDismantlerPatch } from "@/lib/dismantlers";
import { createDismantler, listDismantlers } from "@/lib/crm-postgres/dismantlers";
import { withPlatform, withPlatformOne } from "@/lib/dismantlers-platform";
import { badRequest, dismantlerWrite, guardDismantlers, readJson } from "@/lib/dismantlers-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const guard = await guardDismantlers();
  if ("response" in guard) return guard.response;
  const { dismantlers, owners } = await listDismantlers();
  return Response.json({ ...(await withPlatform(dismantlers)), owners });
}

/** POST { company_id } or { name }, plus any dismantler fields. */
export async function POST(req: Request) {
  const guard = await guardDismantlers();
  if ("response" in guard) return guard.response;
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return badRequest("Body must be an object.");
  const { company_id: companyId, name, ...rest } = body;
  if (companyId !== undefined && typeof companyId !== "string") return badRequest("company_id must be text.");
  if (name !== undefined && typeof name !== "string") return badRequest("name must be text.");
  const parsed = parseDismantlerPatch(rest);
  if ("error" in parsed) return badRequest(parsed.error);
  return dismantlerWrite(async () => {
    const dismantler = await createDismantler({ company_id: companyId || null, name: name ?? null, patch: parsed.patch }, guard.userId);
    return Response.json({ dismantler: await withPlatformOne(dismantler) }, { status: 201 });
  });
}
