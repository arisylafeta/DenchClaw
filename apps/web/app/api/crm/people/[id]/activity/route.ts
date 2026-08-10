import { currentUser } from "@/lib/auth";
import { getPostgresPersonActivity } from "@/lib/crm-postgres/activity";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

function clampInt(value: string | null, fallback: number, max: number): number {
  const parsed = parseInt(value ?? String(fallback), 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(1, Math.min(max, parsed));
}

/**
 * GET /api/crm/people/:id/activity?limit=100&offset=0
 *
 * Returns the timeline of interaction rows for this person, backed by Postgres.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const personId = id?.trim();
  if (!personId) {
    return Response.json({ error: "Missing person id." }, { status: 400 });
  }

  const url = new URL(req.url);
  const limit = clampInt(url.searchParams.get("limit"), DEFAULT_LIMIT, MAX_LIMIT);
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);

  try {
    const activity = await getPostgresPersonActivity(
      { personId, limit, offset },
      user.id,
    );
    return Response.json(activity);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "INVALID_INPUT") {
      return Response.json({ error: "Missing person id." }, { status: 400 });
    }
    if (code === "NOT_FOUND") {
      return Response.json({ error: "Person not found." }, { status: 404 });
    }
    return Response.json({ error: "Failed to load activity." }, { status: 500 });
  }
}
