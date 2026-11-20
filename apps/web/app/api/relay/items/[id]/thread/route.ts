import { guardRelay, relayError } from "@/lib/relay-route";
import { readRelayItem, RelayError } from "@/lib/relay";
import { queryPg } from "@/lib/postgres";
import type { ThreadEmail } from "@/lib/relay-email-clean";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };


/** The emails on this item's thread, newest first, so the page can open any earlier one in full. Read only. */
export async function GET(_req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  try {
    const item = await readRelayItem(id, guard.user.id);
    if (!item) throw new RelayError(404, "Not found");
    if (!item.mail_thread_id) return Response.json({ emails: [] });
    const emails = await queryPg<ThreadEmail>(
      `select id, direction, from_email, coalesce(sent_at, accepted_at, created_at)::text as at, left(coalesce(body_text, ''), 20000) as text
         from mail_message where thread_id = $1 and state in ('received','accepted','sent','delivered','opened','clicked','replied')
         order by coalesce(sent_at, accepted_at, created_at) desc limit 40`, [item.mail_thread_id]);
    return Response.json({ emails });
  } catch (error) {
    return relayError(error);
  }
}
