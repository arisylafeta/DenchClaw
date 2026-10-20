import { parseDocInput } from "@/lib/bulk-documents";
import { badRequest, guardBulkTrades, notFound, readJson } from "@/lib/bulk-trades-route";
import { attachFile, deleteDocument, MAX_DOCUMENT_BYTES, updateDocument } from "@/lib/crm-postgres/bulk-documents";
import { loadRegistry } from "@/lib/crm-postgres/bulk-registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; docId: string }> };

/** JSON edits the document. Multipart with a "file" attaches bytes (a needed document becomes received). */
export async function PATCH(req: Request, { params }: Params) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const { id, docId } = await params;
  if ((req.headers.get("content-type") ?? "").startsWith("multipart/")) {
    const form = await req.formData().catch(() => null);
    const upload = form?.get("file");
    if (!(upload instanceof File) || !upload.name) return badRequest("Attach a file.");
    if (upload.size > MAX_DOCUMENT_BYTES) return badRequest("Files must be 25 MB or smaller.");
    const document = await attachFile(id, docId, { name: upload.name, type: upload.type || null, content: Buffer.from(await upload.arrayBuffer()) }, guard.userId);
    return document ? Response.json({ document }) : notFound("Document");
  }
  const parsed = parseDocInput(await readJson(req), (await loadRegistry()).documentTypes, false);
  if ("error" in parsed) return badRequest(parsed.error);
  try {
    const document = await updateDocument(id, docId, parsed.value);
    return document ? Response.json({ document }) : notFound("Document");
  } catch (err) {
    // A document that is no longer wanted needs a file or a link behind it.
    if ((err as { code?: string }).code === "23514") return badRequest("Attach a file or add a link before marking it received, sent or signed.");
    throw err;
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const { id, docId } = await params;
  return (await deleteDocument(id, docId)) ? Response.json({ ok: true }) : notFound("Document");
}
