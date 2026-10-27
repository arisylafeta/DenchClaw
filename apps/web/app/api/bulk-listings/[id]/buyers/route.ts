import { addOffer, OfferConflict } from "@/lib/crm-postgres/bulk-offers";
import { supplyBuyers } from "@/lib/crm-postgres/supply-buyers";
import { queryPg } from "@/lib/postgres";
import { badRequest, guardBulkTrades, linkedWrite, notFound, readJson } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/** CRM buyer companies whose buy box fits this supply listing. Suggestions only. */
export async function GET(_req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const result = await supplyBuyers((await params).id);
  return result ? Response.json(result) : notFound("Supply listing");
}

/** Save one suggested company as a `candidate` offer on the supply. Nothing is sent. */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const body = await readJson(req) as Record<string, unknown> | null;
  if (!body || typeof body.companyId !== "string" || !body.companyId) return badRequest("Which company?");
  if (body.personId != null && typeof body.personId !== "string") return badRequest("personId must be text.");
  const [company] = await queryPg<{ id: string; name: string }>(`select id, name from crm_companies where id = $1`, [body.companyId]);
  if (!company) return notFound("Company");
  if (!(await supplyBuyers(id))) return notFound("Supply listing");
  const [person] = body.personId ? await queryPg<{ id: string; full_name: string | null; email: string | null }>(
    `select id, full_name, email from crm_people where id = $1 and company_id = $2`, [body.personId, company.id]) : [];
  if (body.personId && !person) return badRequest("That person is not at this company.");
  const [existing] = await queryPg<{ id: string }>(
    `select id from crm_bulk_offers where bulk_listing_id = $1 and role = 'counterparty' and company_id = $2 limit 1`, [id, company.id]);
  if (existing) return Response.json({ error: "This company is already on the listing.", offerId: existing.id }, { status: 409 });
  return linkedWrite(async () => {
    try {
      const offer = await addOffer(id, { name: company.name, companyId: company.id, personId: person?.id ?? null, contact: person?.email ?? null, stage: "candidate" });
      await queryPg(
        `insert into crm_bulk_listing_activity (bulk_listing_id, offer_id, person_id, kind, title, data, actor_user_id)
         values ($1, $2, $3, 'status', $4, $5::jsonb, $6)`,
        [id, offer.id, person?.id ?? null, `${company.name} · Candidate (suggested from buyer profile)`, JSON.stringify({ stage: "candidate", source: "buyer_profile" }), guard.userId]);
      return Response.json({ offer }, { status: 201 });
    } catch (err) {
      if (err instanceof OfferConflict) return Response.json({ error: err.message, offerId: err.existingOfferId ?? null }, { status: 409 });
      throw err;
    }
  });
}
