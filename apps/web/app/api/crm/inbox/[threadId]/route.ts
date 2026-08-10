import { currentUser } from "@/lib/auth";
import { getPostgresInboxThread } from "@/lib/crm-postgres/inbox-thread";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ threadId: string }> },
) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { threadId } = await ctx.params;
  const id = threadId?.trim();
  if (!id) {
    return Response.json({ error: "Missing thread id." }, { status: 400 });
  }

  if (process.env.CRM_DB_BACKEND === "duckdb") {
    return Response.json(
      { error: "Per-user inbox isolation requires the Postgres backend." },
      { status: 503 },
    );
  }

  const data = await getPostgresInboxThread(id, user.id);
  return data
    ? Response.json(data)
    : Response.json({ error: "Thread not found." }, { status: 404 });
}
