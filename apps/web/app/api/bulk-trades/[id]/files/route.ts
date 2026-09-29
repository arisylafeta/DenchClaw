import { parseFileMeta, type FileType } from "@/lib/bulk-trade-details";
import { MAX_TRADE_FILE_BYTES, discardTradeFile, storeTradeFile } from "@/lib/bulk-trade-files";
import { recordFile } from "@/lib/crm-postgres/bulk-trade-details";
import { badRequest, guardBulkTrades, notFound } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Multipart upload: "file", plus optional "file_type", "source_label" and "source_date". Buyers see it at Never. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || !file.name) return badRequest("Attach a file.");
  if (file.size > MAX_TRADE_FILE_BYTES) return badRequest("Files must be 50 MB or smaller.");

  const meta = parseFileMeta({
    ...(form!.get("file_type") ? { file_type: form!.get("file_type") } : {}),
    ...(form!.get("source_label") ? { source_label: form!.get("source_label") } : {}),
    ...(form!.get("source_date") ? { source_date: form!.get("source_date") } : {}),
  });
  if ("error" in meta) return badRequest(meta.error);
  const fileType: FileType = meta.value.file_type ?? "Other";

  const stored = await storeTradeFile(new Uint8Array(await file.arrayBuffer()));
  try {
    const saved = await recordFile(
      (await params).id,
      { ...stored, file_name: file.name, file_type: fileType, content_type: file.type || null, byte_size: file.size },
      { ...meta.value, file_type: fileType, visibility: "never" },
      guard.userId,
    );
    if (!saved) {
      await discardTradeFile(stored.storage_key);
      return notFound("Trade");
    }
    return Response.json({ file: saved }, { status: 201 });
  } catch (err) {
    await discardTradeFile(stored.storage_key);
    throw err;
  }
}
