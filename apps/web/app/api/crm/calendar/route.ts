import { getPostgresCalendarEvents } from "@/lib/crm-postgres/calendar";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

function clampInt(raw: string | null, fallback: number, max: number): number {
  const parsed = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {return fallback;}
  return Math.min(parsed, max);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const search = url.searchParams.get("q")?.trim().toLowerCase() ?? "";
  const fromIso = url.searchParams.get("from")?.trim() || null;
  const toIso = url.searchParams.get("to")?.trim() || null;
  const limit = clampInt(url.searchParams.get("limit"), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);

  const data = await getPostgresCalendarEvents({ search, fromIso, toIso, limit, offset });
  return Response.json(data);
}
