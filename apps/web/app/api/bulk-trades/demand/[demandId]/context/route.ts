import { getDemand } from "@/lib/crm-postgres/bulk-demand";
import { getBuyer } from "@/lib/crm-postgres/company-profile";
import { buyerMail } from "@/lib/crm-postgres/demand-context";
import { guardBulkTrades, notFound } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ demandId: string }> };

/** The buyer behind a demand row: profile, engagement, their other asks and recent email with them. */
export async function GET(_req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const demand = await getDemand((await params).demandId);
  if (!demand) return notFound("Demand");
  const [buyer, mail] = await Promise.all([
    demand.company_id ? getBuyer(demand.company_id) : null,
    buyerMail(demand, guard.userId),
  ]);
  return Response.json({ buyer, mail });
}
