import { parseFileMeta, previewType } from "@/lib/bulk-trade-details";
import { getFileForDownload, updateFile } from "@/lib/crm-postgres/bulk-trade-details";
import { badRequest, guardBulkTrades, notFound, readJson } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; fileId: string }> };

/**
 * Serves a trade file to a signed-in user. With ?view=1, PDFs and raster images open in the tab,
 * locked down so the file cannot run script or load anything; every other file downloads.
 */
export async function GET(req: Request, { params }: Params) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const { id, fileId } = await params;
  const row = await getFileForDownload(id, fileId);
  if (!row) return notFound("File");

  const inlineType = new URL(req.url).searchParams.get("view") === "1" ? previewType(row.file_name) : null;
  // Header values must be ASCII; the full name travels in filename*.
  const safeName = row.file_name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const disposition = `${inlineType ? "inline" : "attachment"}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(row.file_name)}`;
  return new Response(new Uint8Array(row.content), {
    headers: {
      "content-type": inlineType ?? "application/octet-stream",
      "content-disposition": disposition,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
      ...(inlineType ? {
        "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; object-src 'self'; frame-ancestors 'self'",
      } : {}),
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
