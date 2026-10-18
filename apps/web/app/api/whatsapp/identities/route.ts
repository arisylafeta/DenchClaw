import { currentUser } from "@/lib/auth";
import { queryPg } from "@/lib/postgres";
import {
  canReadWhatsapp,
  decideWhatsappIdentity,
  whatsappIdentities,
} from "@/lib/crm-postgres/whatsapp";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!canReadWhatsapp(user)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  const p = new URL(request.url).searchParams;
  if (p.has("search")) {
    const search = p.get("search")?.trim() ?? "";
    if (search.length < 2) {
      return Response.json({ people: [] });
    }
    return Response.json({
      people: await queryPg(
        `select id,full_name as name from crm_people where full_name ilike $1 or email ilike $1 order by full_name,id limit 20`,
        [`%${search}%`],
      ),
    });
  }
  try {
    return Response.json(
      await whatsappIdentities(Number(p.get("limit") ?? 50), Number(p.get("offset") ?? 0)),
    );
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_pagination") {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!canReadWhatsapp(user)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!input || typeof input !== "object") {
    return Response.json({ error: "Invalid decision" }, { status: 400 });
  }
  const value = input as Record<string, unknown>;
  if (
    typeof value.identityId !== "string" ||
    ["personId", "companyId", "unlinkId"].some(
      (key) => value[key] !== undefined && typeof value[key] !== "string",
    ) ||
    (value.shared !== undefined && typeof value.shared !== "boolean")
  ) {
    return Response.json({ error: "Invalid decision" }, { status: 400 });
  }
  try {
    return Response.json(
      await decideWhatsappIdentity(
        value.identityId,
        value as { personId?: string; companyId?: string; unlinkId?: string; shared?: boolean },
        user.id,
      ),
    );
  } catch (error) {
    if (
      error instanceof Error &&
      [
        "unknown_identity",
        "active_link_not_found",
        "target_required",
        "identity_already_linked",
      ].includes(error.message)
    ) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    if (error && typeof error === "object" && "code" in error && error.code === "23503") {
      return Response.json({ error: "Target no longer exists" }, { status: 409 });
    }
    throw error;
  }
}
