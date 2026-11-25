import { statSync } from "node:fs";
import { basename } from "node:path";
import { currentUser } from "@/lib/auth";
import { DriveError, driveConnected, uploadToDrive } from "@/lib/google-drive";
import { isProtectedSystemPath, resolveFilesystemPath } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BYTES = 100 * 1024 * 1024;
/** Documents only: what a person would open in Google Docs, Sheets or Slides, or view as a PDF. */
const DOCUMENT_EXT = new Set(["xlsx", "xls", "ods", "csv", "docx", "doc", "odt", "rtf", "pptx", "ppt", "odp", "pdf"]);

/** Body: { path }. Saves a workspace file to the signed-in user's own Google Drive; Office files become Google files. */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { path?: unknown } | null;
  const path = typeof body?.path === "string" ? body.path : "";
  const resolved = path ? resolveFilesystemPath(path) : null;
  if (!resolved) return Response.json({ error: "not_found", message: "File not found." }, { status: 404 });
  const file = resolved.absolutePath;
  const name = basename(file);
  if (!DOCUMENT_EXT.has((name.split(".").pop() ?? "").toLowerCase()) || isProtectedSystemPath(resolved)) {
    return Response.json({ error: "not_allowed", message: "Only documents and spreadsheets can be saved to Drive." }, { status: 400 });
  }
  let size: number;
  try {
    const stat = statSync(file);
    if (!stat.isFile()) throw new Error("not a file");
    size = stat.size;
  } catch { return Response.json({ error: "not_found", message: "File not found." }, { status: 404 }); }
  if (size > MAX_BYTES) return Response.json({ error: "too_large", message: "That file is over 100 MB. Download it instead." }, { status: 413 });
  if (!(await driveConnected(user.email).catch(() => false))) {
    return Response.json({ error: "drive_not_connected", message: "Google Drive isn't connected to this account yet." }, { status: 409 });
  }
  try {
    return Response.json(await uploadToDrive(user.email, file, name));
  } catch (error) {
    if (error instanceof DriveError) return Response.json({ error: error.code, message: error.message }, { status: error.code === "drive_not_connected" ? 409 : 502 });
    throw error;
  }
}
