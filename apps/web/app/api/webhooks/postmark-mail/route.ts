import { createHash, timingSafeEqual } from "node:crypto";
import { queryPg } from "@/lib/postgres";
import { canonicalPostmarkTime, postmarkOpenEventId } from "@/lib/postmark-mail-webhook";

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
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {throw new Error("invalid");}
    payload = body as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON object" }, { status: 400 });
  }
  if (payload.RecordType !== "Open") {return Response.json({ status: "ignored", reason: "record_type" });}
  const at = typeof payload.ReceivedAt === "string" ? canonicalPostmarkTime(payload.ReceivedAt) : null;
  if (typeof payload.MessageID !== "string" || !payload.MessageID || !at) {
    return Response.json({ error: "Invalid open identity or timestamp" }, { status: 400 });
  }
  const detail: Record<string, unknown> = {
    RecordType: "Open", Type: "Opened", Details: { Summary: "Email opened" },
    MessageID: payload.MessageID, ReceivedAt: payload.ReceivedAt,
  };
  for (const key of ["Recipient", "FirstOpen", "Client", "OS", "Platform", "Geo", "UserAgent"]) {
    if (payload[key] !== undefined) {detail[key] = payload[key];}
  }
  try {
    const messages = await queryPg<{ id: string }>(
      "select id from mail_message where provider_message_id = $1", [payload.MessageID],
    );
    if (!messages.length) {
      console.info("Postmark mail webhook ignored unknown messages", { count: 1 });
      return Response.json({ status: "ignored", reason: "unknown_message" });
    }
    let inserted = 0;
    for (const message of messages) {
      // Source must match ingest.py: the unique key is (source, provider_event_id).
      // Keep event insertion and the earliest-open summary atomic.
      const rows = await queryPg<{ id: string }>(`
        with fresh as (
          insert into mail_event(message_id, type, source, provider_event_id, occurred_at, detail)
          values ($1, 'opened', 'postmark', $2, $3::timestamptz, $4::jsonb)
          on conflict do nothing returning id
        ), updated as (
          update mail_message set opened_at = least(opened_at, $3::timestamptz), updated_at = now()
          where id = $1 and exists (select 1 from fresh)
        ) select id from fresh`,
      [message.id, postmarkOpenEventId(message.id, at), at, JSON.stringify(detail)]);
      inserted += rows.length;
    }
    return Response.json({ status: inserted ? "recorded" : "duplicate", inserted });
  } catch {
    // Never log the error object: database errors can include query parameters.
    console.error("Postmark mail webhook ingestion failed");
    return Response.json({ error: "Ingestion failed" }, { status: 500 });
  }
}
