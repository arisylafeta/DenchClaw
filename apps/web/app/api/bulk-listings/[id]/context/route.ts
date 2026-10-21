import { getListing } from "@/lib/crm-postgres/bulk-listings";
import { getBuyer } from "@/lib/crm-postgres/company-profile";
import { buyerMail } from "@/lib/crm-postgres/demand-context";
import { queryPg } from "@/lib/postgres";
import { guardBulkTrades, notFound } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/** The buyer behind a demand row: profile, engagement, their other asks and recent email with them. */
export async function GET(_req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const demand = await getListing((await params).id);
  if (!demand) return notFound("Listing");
  const [buyer, mail, people] = await Promise.all([
    demand.kind === "demand" && demand.company_id ? getBuyer(demand.company_id) : null,
    buyerMail(demand, guard.userId),
    // The person we deal with: by link, else by the email on the demand.
    queryPg<{ id: string; name: string | null; email: string | null; job_title: string | null; phone: string | null; linkedin_url: string | null;
      company_name: string | null; company_domain: string | null; website: string | null }>(
      `select p.id, p.full_name as name, p.email, p.job_title, p.phone, p.linkedin_url, c.name as company_name, c.domain as company_domain, c.website
       from crm_people p left join crm_companies c on c.id = p.company_id
       where p.id = $1 or ($1::text is null and $2::text is not null and lower(p.email) = lower($2))
       order by (p.id = $1) desc nulls last limit 1`,
      [demand.person_id, demand.email]),
  ]);
  return Response.json({ buyer, mail, person: people[0] ?? null });
}
