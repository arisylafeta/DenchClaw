import { createHash, timingSafeEqual } from "node:crypto";
import { queryPg } from "@/lib/postgres";
import { boundedPostmarkMetadata, canonicalPostmarkTime, PostmarkBodyTooLarge, postmarkOpenEventId, readPostmarkBody } from "@/lib/postmark-mail-webhook";

// Fill webhook-only metadata, retaining existing values and richer nested objects.
// Reuse the expression in WHERE so identical redeliveries do not write a row.
const enrichedDetail = `coalesce(existing.detail, '{}'::jsonb) || (
  select jsonb_object_agg(key, case
    when jsonb_typeof(existing.detail -> key) = 'object' and jsonb_typeof(value) = 'object'
      then value || (existing.detail -> key)
    else coalesce(nullif(nullif(existing.detail -> key, 'null'::jsonb), '""'::jsonb), value)
    end)
  from jsonb_each(excluded.detail)
  where key in ('FirstOpen', 'Client', 'OS', 'Platform', 'Geo', 'UserAgent', 'RecordType')
)`;

export const runtime = "nodejs";

function authorised(request: Request): boolean {
  const user = process.env.POSTMARK_MAIL_WEBHOOK_USER;
  const password = process.env.POSTMARK_MAIL_WEBHOOK_PASSWORD;
  if (!user || !password) {return false;}
  const header = request.headers.get("authorization") || "";
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header);
  if (!match) {return false;}
  // Hash both sides so timingSafeEqual always compares fixed-length buffers.
  const actual = createHash("sha256").update(Buffer.from(match[1], "base64")).digest();
  const expected = createHash("sha256").update(`${user}:${password}`).digest();
  return timingSafeEqual(actual, expected);
}

export async function POST(request: Request): Promise<Response> {
  if (!authorised(request)) {
    return Response.json({ error: "Unauthorised" }, { status: 401, headers: { "WWW-Authenticate": "Basic realm=\"Postmark mail\"" } });
  }
  let payload: Record<string, unknown>;
  try {
    const body = await readPostmarkBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) {throw new Error("invalid");}
    payload = body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof PostmarkBodyTooLarge) {return Response.json({ error: "Body too large" }, { status: 413 });}
    return Response.json({ error: "Invalid JSON object" }, { status: 400 });
  }
  if (payload.RecordType !== "Open") {return Response.json({ status: "ignored", reason: "record_type" });}
  const at = typeof payload.ReceivedAt === "string" ? canonicalPostmarkTime(payload.ReceivedAt) : null;
  if (typeof payload.MessageID !== "string" || !payload.MessageID || !at) {
    return Response.json({ error: "Invalid open identity or timestamp" }, { status: 400 });
  }
  const detail: Record<string, unknown> = {
    RecordType: "Open", Type: "Opened", Details: { Summary: "Email opened" },
    MessageID: payload.MessageID.slice(0, 256), ReceivedAt: payload.ReceivedAt,
  };
  for (const key of ["Recipient", "FirstOpen", "Client", "OS", "Platform", "Geo", "UserAgent"]) {
    if (payload[key] !== undefined) {detail[key] = boundedPostmarkMetadata(payload[key], key === "UserAgent" ? 512 : 256);}
  }
  try {
    const messages = await queryPg<{ id: string }>(
      "select id from mail_message where provider_message_id = $1", [payload.MessageID],
    );
    if (!messages.length) {
      console.info("Postmark mail webhook awaiting messages", { count: 1 });
      return Response.json({ error: "Message not yet available" }, { status: 503 });
    }
    let inserted = 0;
    for (const message of messages) {
      // Source must match ingest.py: the unique key is (source, provider_event_id).
      // Keep event insertion and the earliest-open summary atomic.
      const rows = await queryPg<{ id: string; inserted: boolean }>(`
        with fresh as (
          insert into mail_event as existing(message_id, type, source, provider_event_id, occurred_at, detail)
          values ($1, 'opened', 'postmark', $2, $3::timestamptz, $4::jsonb)
          on conflict (source, provider_event_id) where provider_event_id is not null
          do update set detail = ${enrichedDetail}
          where existing.detail is distinct from ${enrichedDetail}
          returning id, (xmax = 0) as inserted
        ), updated as (
          update mail_message set opened_at = least(opened_at, $3::timestamptz), updated_at = now()
          where id = $1 and exists (select 1 from fresh where inserted)
        ) select id, inserted from fresh`,
      [message.id, postmarkOpenEventId(message.id, at), at, JSON.stringify(detail)]);
      inserted += rows.filter((row) => row.inserted).length;
    }
    return Response.json({ status: inserted ? "recorded" : "duplicate", inserted });
  } catch {
    // Never log the error object: database errors can include query parameters.
    console.error("Postmark mail webhook ingestion failed");
    return Response.json({ error: "Ingestion failed" }, { status: 500 });
  }
}
