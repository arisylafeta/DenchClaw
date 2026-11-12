import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { guardBulkTrades, notFound } from "@/lib/bulk-trades-route";
import { documentFile } from "@/lib/crm-postgres/bulk-documents";
import { DriveError, driveConnected, uploadToDrive } from "@/lib/google-drive";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BYTES = 100 * 1024 * 1024;

/** Saves a stored document to the signed-in user's own Google Drive; Office files become Docs, Sheets or Slides. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string; docId: string }> }) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const { id, docId } = await params;
  const row = await documentFile(id, docId);
  if (!row) return notFound("Document");
  if (row.content.length > MAX_BYTES) return Response.json({ error: "too_large", message: "That file is over 100 MB. Download it instead." }, { status: 413 });
  if (!(await driveConnected(guard.email).catch(() => false))) {
    return Response.json({ error: "drive_not_connected", message: "Google Drive isn't connected to this account yet." }, { status: 409 });
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), "bulk-doc-drive-"));
  try {
    const target = path.join(dir, "file");
    await writeFile(target, row.content);
    return Response.json(await uploadToDrive(guard.email, target, row.file_name));
  } catch (error) {
    if (error instanceof DriveError) return Response.json({ error: error.code, message: error.message }, { status: error.code === "drive_not_connected" ? 409 : 502 });
    throw error;
  } finally { await rm(dir, { recursive: true, force: true }); }
}
