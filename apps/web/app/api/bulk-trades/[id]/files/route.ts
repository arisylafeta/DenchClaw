import { MAX_TRADE_FILE_BYTES, parseFileMeta, type FileType } from "@/lib/bulk-trade-details";
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
  if (file.size > MAX_TRADE_FILE_BYTES) return badRequest("Files must be 25 MB or smaller.");

  const text = (key: string) => (form!.get(key) ? { [key]: form!.get(key) } : {});
  const meta = parseFileMeta({ ...text("file_type"), ...text("source_label"), ...text("source_date") });
  if ("error" in meta) return badRequest(meta.error);
  const fileType: FileType = meta.value.file_type ?? "Other";

  const saved = await recordFile(
    (await params).id,
    { file_name: file.name, file_type: fileType, content_type: file.type || null, content: Buffer.from(await file.arrayBuffer()) },
    { ...meta.value, file_type: fileType, visibility: "never" },
    guard.userId,
  );
  return saved ? Response.json({ file: saved }, { status: 201 }) : notFound("Trade");
}
