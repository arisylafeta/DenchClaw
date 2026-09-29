import { followTrackedLink } from "@/lib/crm-postgres/bulk-trade-details";
import { TOKEN, isAutomatedVisit } from "@/lib/tracked-links";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const notFound = () => new Response("Link not found", { status: 404, headers: { "content-type": "text/plain" } });

async function follow(req: Request, token: string) {
  if (process.env.CRM_DB_BACKEND !== "postgres" || !TOKEN.test(token)) return notFound();
  const destination = await followTrackedLink(token, !isAutomatedVisit(req.method, req.headers.get("user-agent")));
  if (!destination) return notFound();
  return new Response(null, {
    status: 302,
    headers: { location: destination, "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

/** Public: forwards a tracked link from a trade email and counts a person's click. */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  return follow(req, (await params).token);
}

export async function HEAD(req: Request, { params }: { params: Promise<{ token: string }> }) {
  return follow(req, (await params).token);
}
