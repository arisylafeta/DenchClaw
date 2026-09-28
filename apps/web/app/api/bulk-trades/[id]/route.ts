import { currentUser } from "@/lib/auth";
import { parseTradePatch } from "@/lib/bulk-trades";
import { updateBulkTrade } from "@/lib/crm-postgres/bulk-trades";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (process.env.CRM_DB_BACKEND !== "postgres") {
    return Response.json({ error: "Bulk Trades requires the Postgres backend" }, { status: 503 });
  }
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const parsed = parseTradePatch(await req.json().catch(() => null));
  if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 });

  const trade = await updateBulkTrade(id, parsed.patch, user.id);
  if (!trade) return Response.json({ error: "Trade not found" }, { status: 404 });
  return Response.json({ trade });
}
