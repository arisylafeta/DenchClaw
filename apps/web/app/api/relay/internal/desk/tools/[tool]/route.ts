import { internalAuthorised } from "@/lib/relay-learn";
import { deskTool } from "@/lib/relay-desk";
import { isDeskTool } from "@/lib/relay-desk-core";
import { RelayError } from "@/lib/relay";
import { DraftActionError } from "@/lib/mail-draft-actions";
import { readBody } from "@/lib/relay-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 180;
type Context = { params: Promise<{ tool: string }> };

/**
 * One relay MCP tool call from the desk (relay_desk_mcp.py): { item, run, args, dry_run }. Internal secret only. Answers
 * { text } for the desk to read, or { error } with a reason it can act on (a leak, a changed version, a bad argument).
 */
export async function POST(req: Request, { params }: Context) {
  if (!internalAuthorised(req)) return Response.json({ error: "Not found" }, { status: 404 });
  const { tool } = await params;
  if (!isDeskTool(tool)) return Response.json({ error: "Unknown tool" }, { status: 404 });
  const body = await readBody(req);
  const item = typeof body?.item === "string" ? body.item : "";
  const run = typeof body?.run === "string" && body.run ? body.run : null;
  if (!item || item.length > 100 || (run && run.length > 100)) return Response.json({ error: "item required" }, { status: 400 });
  try {
    return Response.json({ text: await deskTool({ itemId: item, runId: run, dryRun: body?.dry_run === true }, tool, body?.args ?? {}) });
  } catch (error) {
    if (error instanceof RelayError || error instanceof DraftActionError) return Response.json({ error: error.message }, { status: error.status });
    console.error("relay desk tool", tool, error);
    return Response.json({ error: "That tool failed. Try again, or carry on without it." }, { status: 500 });
  }
}
