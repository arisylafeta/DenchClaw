import { ownerOfUser, tickMention } from "@/lib/crm-postgres/bulk-notes";
import { guardBulkTrades } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ activityId: string }> };

/** The signed-in person ticks a mention of them, and it leaves their Today. Nobody else can tick it for them. */
export async function POST(_req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const { activityId } = await params;
  const me = await ownerOfUser(guard.userId);
  if (!me) return Response.json({ error: "Only Alex, Sean and Ari have mentions." }, { status: 403 });
  if (!await tickMention(activityId, me)) return Response.json({ error: "That mention is not yours to tick." }, { status: 404 });
  return Response.json({ ok: true });
}
