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
              `select id,title from crm_bulk_trade_lots where title ilike $1 order by title,id limit 20`,
              [`%${search}%`],
            ),
    });
  }
  return Response.json({
    links: await queryPg(
      `select e.lot_id,e.evidence_kind,e.evidence_id,l.title from crm_bulk_trade_evidence_links e join crm_bulk_trade_lots l on l.id=e.lot_id left join whatsapp_message m on e.evidence_kind='whatsapp_live_message' and m.id=e.evidence_id where (e.evidence_kind='whatsapp_live_thread' and e.evidence_id=$1) or m.thread_id=$1 order by l.title,e.evidence_kind,e.evidence_id`,
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
    const source = await client.query(`select id from ${sourceTable} where id=$1 for share`, [
      value.evidenceId,
    ]);
    const trade = await client.query(`select id from crm_bulk_trade_lots where id=$1 for share`, [
      value.lotId,
    ]);
    if (!source.rows.length || !trade.rows.length) {
      return false;
    }
    if (remove) {
      await client.query(
        `delete from crm_bulk_trade_evidence_links where lot_id=$1 and evidence_kind=$2 and evidence_id=$3`,
        [value.lotId, value.evidenceKind, value.evidenceId],
      );
    } else {
      await client.query(
        `insert into crm_bulk_trade_evidence_links(lot_id,evidence_kind,evidence_id) values($1,$2,$3) on conflict do nothing`,
        [value.lotId, value.evidenceKind, value.evidenceId],
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
