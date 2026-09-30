import { parseDismantlerPatch } from "@/lib/dismantlers";
import { getDismantlerDetail, updateDismantler } from "@/lib/crm-postgres/dismantlers";
import { badRequest, dismantlerWrite, guardDismantlers, notFound, readJson } from "@/lib/dismantlers-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const guard = await guardDismantlers();
  if ("response" in guard) return guard.response;
  const detail = await getDismantlerDetail((await params).id, guard.userId);
  return detail ? Response.json(detail) : notFound("Dismantler");
}

export async function PATCH(req: Request, { params }: Params) {
  const guard = await guardDismantlers();
  if ("response" in guard) return guard.response;
  const parsed = parseDismantlerPatch(await readJson(req));
  if ("error" in parsed) return badRequest(parsed.error);
  const { id } = await params;
  return dismantlerWrite(async () => {
    const dismantler = await updateDismantler(id, parsed.patch, guard.userId);
    return dismantler ? Response.json({ dismantler }) : notFound("Dismantler");
  });
}
