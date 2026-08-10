import { currentUser } from "@/lib/auth";
import { getPostgresPersonProfile } from "@/lib/crm-postgres/person-profile";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const personId = id?.trim();
  if (!personId) {
    return Response.json({ error: "Missing person id." }, { status: 400 });
  }

  const profile = await getPostgresPersonProfile(personId, user.id);
  if (!profile) {
    return Response.json({ error: "Person not found." }, { status: 404 });
  }
  return Response.json(profile);
}
