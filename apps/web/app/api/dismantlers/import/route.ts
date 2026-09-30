import { parseImport } from "@/lib/dismantlers";
import { importDismantlers } from "@/lib/crm-postgres/dismantlers";
import { badRequest, dismantlerWrite, guardDismantlers, readJson } from "@/lib/dismantlers-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST { text, apply }: previews a pasted list, and with apply adds the new ones to Found. */
export async function POST(req: Request) {
  const guard = await guardDismantlers();
  if ("response" in guard) return guard.response;
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (typeof body?.text !== "string") return badRequest("Paste a list first.");
  const { rows, errors } = parseImport(body.text);
  if (errors.length) return badRequest(errors.join(" "));
  if (!rows.length) return badRequest("Paste a list first.");
  if (rows.length > 500) return badRequest("Import up to 500 at a time.");
  return dismantlerWrite(async () => Response.json({
    plan: await importDismantlers(rows, body.apply === true, guard.userId),
    applied: body.apply === true,
  }));
}
