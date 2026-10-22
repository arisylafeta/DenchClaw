import { currentUser } from "@/lib/auth";
import { canReadWhatsapp } from "@/lib/crm-postgres/whatsapp";
import { queryPg, withPgTransaction } from "@/lib/postgres";
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
    return Response.json({
      trades:
        search.length < 2
          ? []
          : await queryPg(
              `select id,title from (select l.id,coalesce(nullif(l.spec->>'listing_title', ''), nullif(l.context->>'listing_title', ''), l.summary) as title from crm_bulk_listings l where l.status<>'closed') x where title ilike $1 order by title,id limit 20`,
              [`%${search}%`],
            ),
    });
  }
  return Response.json({
    links: await queryPg(
      `select e.bulk_listing_id as lot_id,
        case when e.reason like 'message:%' then 'whatsapp_live_message' else 'whatsapp_live_thread' end as evidence_kind,
        case when e.reason like 'message:%' then substr(e.reason, 9) else e.thread_id end as evidence_id,
        coalesce(nullif(l.spec->>'listing_title', ''), nullif(l.context->>'listing_title', ''), l.summary) as title
      from crm_bulk_thread_links e join crm_bulk_listings l on l.id=e.bulk_listing_id
      where e.channel='whatsapp' and e.thread_id=$1 and e.state<>'rejected' order by 4,2,3`,
      [p.get("threadId")],
    ),
  });
}
async function mutate(request: Request, remove: boolean) {
  const user = await currentUser();
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!canReadWhatsapp(user)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  let value: Record<string, unknown>;
  try {
    value = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (
    !value ||
    typeof value.lotId !== "string" ||
    typeof value.evidenceId !== "string" ||
    !["whatsapp_live_thread", "whatsapp_live_message"].includes(String(value.evidenceKind))
  ) {
    return Response.json({ error: "Invalid evidence link" }, { status: 400 });
  }
  const sourceTable =
    value.evidenceKind === "whatsapp_live_thread" ? "whatsapp_thread" : "whatsapp_message";
  const result = await withPgTransaction(async (client) => {
    // A thread link, or a message link kept as a thread link whose reason names the message.
    const source = await client.query(
      sourceTable === "whatsapp_thread"
        ? `select id as thread_id, null::text as body from whatsapp_thread where id=$1 for share`
        : `select thread_id, body from whatsapp_message where id=$1 for share`,
      [value.evidenceId],
    );
    const listing = await client.query(`select id from crm_bulk_listings where id=$1 for share`, [value.lotId]);
    if (!source.rows.length || !listing.rows.length) {
      return false;
    }
    const threadId = source.rows[0].thread_id as string;
    const reason = value.evidenceKind === "whatsapp_live_message" ? `message:${value.evidenceId}` : "thread";
    if (remove) {
      await client.query(
        `delete from crm_bulk_thread_links where channel='whatsapp' and thread_id=$1 and bulk_listing_id=$2 and offer_id is null
           and coalesce(reason, 'thread')=$3`,
        [threadId, value.lotId, reason],
      );
    } else {
      await client.query(
        `insert into crm_bulk_thread_links(channel,thread_id,bulk_listing_id,confidence,state,reason,quote,labelled_by,confirmed_by,confirmed_at)
         values('whatsapp',$1,$2,'high','confirmed',$3,$4,$5,$5,now())
         on conflict (channel, thread_id, bulk_listing_id, (coalesce(offer_id, ''))) do update
           set state='confirmed', reason=excluded.reason, quote=coalesce(excluded.quote, crm_bulk_thread_links.quote),
               confirmed_by=excluded.confirmed_by, confirmed_at=now()`,
        [threadId, value.lotId, reason, (source.rows[0].body as string | null)?.slice(0, 500) ?? null, user.email],
      );
    }
    return true;
  });
  return result
    ? Response.json({ ok: true })
    : Response.json({ error: "Source or trade not found" }, { status: 404 });
}
export async function POST(request: Request) {
  return mutate(request, false);
}
export async function DELETE(request: Request) {
  return mutate(request, true);
}
