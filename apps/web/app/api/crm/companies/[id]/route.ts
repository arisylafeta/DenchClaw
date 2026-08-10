import { currentUser } from "@/lib/auth";
import { getPostgresCompanyProfile } from "@/lib/crm-postgres/company-profile";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const companyId = id?.trim();
  if (!companyId) {
    return Response.json({ error: "Missing company id." }, { status: 400 });
  }

  const profile = await getPostgresCompanyProfile(companyId, user.id);
  if (!profile) {
    return Response.json({ error: "Company not found." }, { status: 404 });
  }
  return Response.json(profile);
}
