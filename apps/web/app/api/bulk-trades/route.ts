import { currentUser } from "@/lib/auth";
import { listBulkTrades, listTradeOwners } from "@/lib/crm-postgres/bulk-trades";
import { checkStatus, possibleTrades } from "@/lib/crm-postgres/bulk-trade-proposals";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function postgresOnly(): Response | null {
  return process.env.CRM_DB_BACKEND === "postgres"
    ? null
    : Response.json({ error: "Bulk Trades requires the Postgres backend" }, { status: 503 });
}

/** `?inbox=1` returns only what the sheet header needs (owners, check status, possible trades), not every trade. */
export async function GET(req: Request) {
  const unavailable = postgresOnly();
  if (unavailable) return unavailable;
  if (!(await currentUser())) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const inboxOnly = new URL(req.url).searchParams.has("inbox");
  const [list, check, possible] = await Promise.all([
    inboxOnly ? listTradeOwners().then((owners) => ({ owners })) : listBulkTrades(), checkStatus(), possibleTrades()]);
  return Response.json({ ...list, check, possible });
}
