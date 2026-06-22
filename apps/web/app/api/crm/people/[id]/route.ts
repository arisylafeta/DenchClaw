import { getPostgresPersonProfile } from "@/lib/crm-postgres/person-profile";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const personId = id?.trim();
  if (!personId) {
    return Response.json({ error: "Missing person id." }, { status: 400 });
  }

  const profile = await getPostgresPersonProfile(personId);
  if (!profile) {
    return Response.json({ error: "Person not found." }, { status: 404 });
  }
  return Response.json(profile);
}
