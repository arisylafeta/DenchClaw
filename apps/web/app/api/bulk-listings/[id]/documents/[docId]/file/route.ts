import { previewType } from "@/lib/bulk-trade-details";
import { guardBulkTrades, notFound } from "@/lib/bulk-trades-route";
import { documentFile } from "@/lib/crm-postgres/bulk-documents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Serves a stored document. With ?view=1, PDFs and raster images open in the tab, locked down; everything else downloads. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; docId: string }> }) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const { id, docId } = await params;
  const row = await documentFile(id, docId);
  if (!row) return notFound("Document");
  const inlineType = new URL(req.url).searchParams.get("view") === "1" ? previewType(row.file_name) : null;
  const safeName = row.file_name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return new Response(new Uint8Array(row.content), {
    headers: {
      "content-type": inlineType ?? "application/octet-stream",
      "content-disposition": `${inlineType ? "inline" : "attachment"}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(row.file_name)}`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
      ...(inlineType ? { "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; object-src 'self'; frame-ancestors 'self'" } : {}),
    },
  });
}
