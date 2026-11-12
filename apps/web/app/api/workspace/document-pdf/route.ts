import { basename } from "node:path";
import { readWorkspaceFile } from "@/lib/workspace";
import { renderDocumentPdf } from "@/lib/document-pdf";
import { parseArtifactRef } from "@/lib/mail-artifacts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/workspace/document-pdf?path=cv/x.md : the workspace markdown file printed as a PDF. */
export async function GET(req: Request) {
  const path = new URL(req.url).searchParams.get("path") ?? "";
  // Same path rules as the chat artifact: workspace-relative markdown or text only.
  if (!parseArtifactRef(JSON.stringify({ kind: "document", path }))) {
    return Response.json({ error: "Invalid document path" }, { status: 400 });
  }
  const file = readWorkspaceFile(path);
  if (!file) {return Response.json({ error: "File not found or access denied" }, { status: 404 });}
  const name = basename(path).replace(/\.[^.]+$/, "") || "document";
  try {
    const pdf = await renderDocumentPdf(file.content, name);
    return new Response(new Uint8Array(pdf), {
      headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf"`, "cache-control": "no-store" },
    });
  } catch {
    return Response.json({ error: "Could not render the PDF" }, { status: 500 });
  }
}
