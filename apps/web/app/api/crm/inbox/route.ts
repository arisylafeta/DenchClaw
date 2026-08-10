import { currentUser } from "@/lib/auth";
import { getPostgresInbox } from "@/lib/crm-postgres/inbox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const VALID_SENDER_FILTERS = new Set(["person", "all", "automated"]);
type SenderFilter = "person" | "all" | "automated";

export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const search = url.searchParams.get("q")?.trim().toLowerCase() ?? "";
  const senderRaw = url.searchParams.get("sender") ?? "person";
  const senderFilter: SenderFilter = (VALID_SENDER_FILTERS.has(senderRaw)
    ? senderRaw
    : "person") as SenderFilter;
  const personId = url.searchParams.get("personId")?.trim() || null;
  const limit = clampInt(
    url.searchParams.get("limit"),
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
  );
  const offset = Math.max(
    0,
    parseInt(url.searchParams.get("offset") ?? "0", 10) || 0,
  );

  if (process.env.CRM_DB_BACKEND === "duckdb") {
    return Response.json(
      { error: "Per-user inbox isolation requires the Postgres backend." },
      { status: 503 },
    );
  }

  const data = await getPostgresInbox(
    { search, senderFilter, personId, limit, offset },
    user.id,
  );
  return Response.json(data);
}

function clampInt(raw: string | null, fallback: number, max: number): number {
  const parsed = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}
