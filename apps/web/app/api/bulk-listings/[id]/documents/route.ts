import { parseDocInput } from "@/lib/bulk-documents";
import { badRequest, guardBulkTrades, notFound } from "@/lib/bulk-trades-route";
import { addDocument, listDocuments, MAX_DOCUMENT_BYTES } from "@/lib/crm-postgres/bulk-documents";
import { loadRegistry } from "@/lib/crm-postgres/bulk-registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  return Response.json({ documents: await listDocuments((await params).id) });
}

/**
 * JSON { title, doc_type?, state?, direction?, url?, note? } adds a link or a wanted document.
 * Multipart (file, plus optional title, doc_type, state, direction, note) uploads a file.
 */
export async function POST(req: Request, { params }: Params) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const registry = await loadRegistry();
  let body: unknown;
  let file: { name: string; type: string | null; content: Buffer } | null = null;
  if ((req.headers.get("content-type") ?? "").startsWith("multipart/")) {
    const form = await req.formData().catch(() => null);
    const upload = form?.get("file");
    if (!(upload instanceof File) || !upload.name) return badRequest("Attach a file.");
    if (upload.size > MAX_DOCUMENT_BYTES) return badRequest("Files must be 25 MB or smaller.");
    file = { name: upload.name, type: upload.type || null, content: Buffer.from(await upload.arrayBuffer()) };
    const text = (key: string) => (form!.get(key) ? { [key]: String(form!.get(key)) } : {});
    body = { title: String(form!.get("title") || upload.name), ...text("doc_type"), ...text("state"), ...text("direction"), ...text("note") };
  } else {
    body = await req.json().catch(() => null);
  }
  const parsed = parseDocInput(body, registry.documentTypes, true);
  if ("error" in parsed) return badRequest(parsed.error);
  const document = await addDocument(id, parsed.value as typeof parsed.value & { title: string }, file, guard.userId);
  return document ? Response.json({ document }, { status: 201 }) : notFound("Listing");
}
