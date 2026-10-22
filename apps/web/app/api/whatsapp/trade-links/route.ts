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
      `select lot_id, evidence_kind, evidence_id, title from (
        select e.bulk_listing_id as lot_id, 'whatsapp_live_thread' as evidence_kind, e.thread_id as evidence_id, coalesce(nullif(l.spec->>'listing_title', ''), nullif(l.context->>'listing_title', ''), l.summary) as title
          from crm_bulk_thread_links e join crm_bulk_listings l on l.id=e.bulk_listing_id
         where e.channel='whatsapp' and e.thread_id=$1 and e.state<>'rejected'
        union all
        select a.bulk_listing_id, 'whatsapp_live_message', a.data->>'whatsapp_message_id', coalesce(nullif(l.spec->>'listing_title', ''), nullif(l.context->>'listing_title', ''), l.summary)
          from crm_bulk_listing_activity a join crm_bulk_listings l on l.id=a.bulk_listing_id
         where a.data->>'whatsapp_thread_id'=$1 and a.data ? 'whatsapp_message_id') x order by title, evidence_kind, evidence_id`,
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
    // A thread is a thread link on the listing; each linked message is its own WhatsApp entry on the listing's Story,
    // so several messages and the whole thread can be linked independently.
    const source = await client.query(
      sourceTable === "whatsapp_thread"
        ? `select id as thread_id, null::text as body, null::timestamptz as occurred_at from whatsapp_thread where id=$1 for share`
        : `select thread_id, body, occurred_at from whatsapp_message where id=$1 for share`,
      [value.evidenceId],
    );
    const listing = await client.query(`select id from crm_bulk_listings where id=$1 for share`, [value.lotId]);
    if (!source.rows.length || !listing.rows.length) {
      return false;
    }
    const threadId = source.rows[0].thread_id as string;
    if (value.evidenceKind === "whatsapp_live_thread") {
      if (remove) {
        await client.query(
          `delete from crm_bulk_thread_links where channel='whatsapp' and thread_id=$1 and bulk_listing_id=$2 and offer_id is null`,
          [threadId, value.lotId],
        );
      } else {
        await client.query(
          `insert into crm_bulk_thread_links(channel,thread_id,bulk_listing_id,confidence,state,reason,labelled_by,confirmed_by,confirmed_at)
           values('whatsapp',$1,$2,'high','confirmed','Linked from WhatsApp',$3,$3,now())
           on conflict (channel, thread_id, bulk_listing_id, (coalesce(offer_id, ''))) do update
             set state='confirmed', confirmed_by=excluded.confirmed_by, confirmed_at=now()`,
          [threadId, value.lotId, user.email],
        );
      }
    } else if (remove) {
      await client.query(
        `delete from crm_bulk_listing_activity where bulk_listing_id=$1 and kind='whatsapp' and data->>'whatsapp_message_id'=$2`,
        [value.lotId, value.evidenceId],
      );
    } else {
      await client.query(
        `insert into crm_bulk_listing_activity (bulk_listing_id, kind, title, body, data, occurred_at)
         select $1, 'whatsapp', 'WhatsApp message', $2, $3, coalesce($4::timestamptz, now())
         where not exists (select 1 from crm_bulk_listing_activity where bulk_listing_id=$1 and data->>'whatsapp_message_id'=$5)`,
        [value.lotId, source.rows[0].body ?? null,
          JSON.stringify({ whatsapp_message_id: value.evidenceId, whatsapp_thread_id: threadId, linked_by: user.email }),
          source.rows[0].occurred_at ?? null, value.evidenceId],
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
