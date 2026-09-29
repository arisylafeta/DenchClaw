import { parseFileMeta } from "@/lib/bulk-trade-details";
import { readTradeFile } from "@/lib/bulk-trade-files";
import { getFileForDownload, updateFile } from "@/lib/crm-postgres/bulk-trade-details";
import { badRequest, guardBulkTrades, notFound, readJson } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; fileId: string }> };

/** Downloads a trade file for a signed-in user. Always an attachment, never rendered inline. */
export async function GET(_req: Request, { params }: Params) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const { id, fileId } = await params;
  const row = await getFileForDownload(id, fileId);
  if (!row) return notFound("File");
  const bytes = await readTradeFile(row.storage_key).catch(() => null);
  if (!bytes) return notFound("File");
  const safeName = row.file_name.replace(/["\\\r\n]/g, "_");
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(row.file_name)}`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  });
}

export async function PATCH(req: Request, { params }: Params) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const parsed = parseFileMeta(await readJson(req));
  if ("error" in parsed) return badRequest(parsed.error);
  const { id, fileId } = await params;
  const file = await updateFile(id, fileId, parsed.value, guard.userId);
  return file ? Response.json({ file }) : notFound("File");
}
