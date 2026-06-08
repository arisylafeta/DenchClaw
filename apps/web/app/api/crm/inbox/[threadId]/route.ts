import {
  ONBOARDING_OBJECT_IDS,
} from "@/lib/workspace-schema-migrations";
import {
  buildEntryProjection,
  loadCrmFieldMaps,
  safeQuery,
  sqlString,
} from "@/lib/crm-queries";
import {
  bodyLooksLikeHtml,
  hydrateMessageBodies,
  type MessageNeedingHydration,
} from "@/lib/gmail-body-hydrate";
import {
  markEmailBodyHydrationAttempted,
  readEmailBodyHydrationAttempted,
} from "@/lib/denchclaw-state";
import { getPostgresInboxThread } from "@/lib/crm-postgres/inbox-thread";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Message = {
  id: string;
  subject: string | null;
  sent_at: string | null;
  preview: string | null;
  body: string | null;
  has_attachments: boolean;
  gmail_message_id: string | null;
  sender_type: string | null;
  from_person_id: string | null;
  to_person_ids: string[];
  cc_person_ids: string[];
};

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await ctx.params;
  const id = threadId?.trim();
  if (!id) {
    return Response.json({ error: "Missing thread id." }, { status: 400 });
  }

  if (process.env.CRM_DB_BACKEND === "postgres") {
    const data = await getPostgresInboxThread(id);
    return Response.json(data);
  }

  const fieldMaps = await loadCrmFieldMaps();

  const threadFieldId = fieldMaps.email_message["Thread"];
  if (!threadFieldId) {
    return Response.json({ error: "Schema migration didn't run — Thread field missing." }, { status: 500 });
  }

  const projection = buildEntryProjection({
    objectId: ONBOARDING_OBJECT_IDS.email_message,
    fieldMap: fieldMaps.email_message,
    aliasedFields: [
      { name: "Subject", alias: "subject" },
      { name: "Sent At", alias: "sent_at" },
      { name: "Body Preview", alias: "preview" },
      { name: "Body", alias: "body" },
      { name: "Has Attachments", alias: "has_attachments" },
      { name: "Gmail Message ID", alias: "gmail_message_id" },
      { name: "Sender Type", alias: "sender_type" },
      { name: "From", alias: "from_relation" },
      { name: "To", alias: "to_relation" },
      { name: "Cc", alias: "cc_relation" },
      { name: "Thread", alias: "thread_relation" },
    ],
  });

  const sql = `
    SELECT * FROM (${projection}) sub
    WHERE thread_relation = ${sqlString(id)}
    ORDER BY sent_at ASC NULLS LAST;
  `;
  const rows = await safeQuery<Record<string, string | null>>(sql);

  // Hydrate everyone we reference (From/To/Cc) in one go
  const allPersonIds = new Set<string>();
  for (const row of rows) {
    if (row.from_relation) {allPersonIds.add(row.from_relation);}
    for (const id of parseRelationIds(row.to_relation)) {allPersonIds.add(id);}
    for (const id of parseRelationIds(row.cc_relation)) {allPersonIds.add(id);}
  }
  const peopleNameFieldId = fieldMaps.people["Full Name"];
  const peopleEmailFieldId = fieldMaps.people["Email Address"];
  const peopleAvatarFieldId = fieldMaps.people["Avatar URL"];
  const personById = new Map<string, { id: string; name: string | null; email: string | null; avatar_url: string | null }>();
  if (allPersonIds.size > 0 && (peopleNameFieldId || peopleEmailFieldId)) {
    const inList = Array.from(allPersonIds).map((pid) => sqlString(pid)).join(", ");
    const peopleSql = `
      SELECT
        e.id AS person_id,
        ${peopleNameFieldId ? `MAX(CASE WHEN ef.field_id = '${peopleNameFieldId}' THEN ef.value END)` : "NULL"} AS name,
        ${peopleEmailFieldId ? `MAX(CASE WHEN ef.field_id = '${peopleEmailFieldId}' THEN ef.value END)` : "NULL"} AS email,
        ${peopleAvatarFieldId ? `MAX(CASE WHEN ef.field_id = '${peopleAvatarFieldId}' THEN ef.value END)` : "NULL"} AS avatar_url
      FROM entries e
      LEFT JOIN entry_fields ef ON ef.entry_id = e.id
      WHERE e.object_id = '${ONBOARDING_OBJECT_IDS.people}'
        AND e.id IN (${inList})
      GROUP BY e.id;
    `;
    const peopleRows = await safeQuery<{
      person_id: string;
      name: string | null;
      email: string | null;
      avatar_url: string | null;
    }>(peopleSql);
    for (const row of peopleRows) {
      personById.set(row.person_id, {
        id: row.person_id,
        name: row.name,
        email: row.email,
        avatar_url: row.avatar_url,
      });
    }
  }

  // ─── Lazy-hydrate full bodies from Composio.
  //
  // Two cases trigger a fetch:
  //
  //   1. Body is empty — the sync stores only the snippet (Composio's
  //      verbose page mode exceeds the gateway 413 cap at 50-message
  //      pages), so the first time a thread is opened we fetch the
  //      full bodies in parallel and persist them back to DuckDB.
  //
  //   2. Body is non-empty but doesn't look like HTML — predates the
  //      extractFullBody bug fix, where Composio's plain-text
  //      `messageText` was preferred over the actual text/html part.
  //      We re-fetch once per entry to get the rich HTML body.
  //
  // To keep case (2) from re-hitting Composio every single thread open
  // for genuinely plain-text emails, we persist a marker file of entry
  // IDs we've already attempted. Once an entry is in the set we skip
  // it forever (delete the file to force a workspace-wide retry).
  const attemptedHtmlRehydrate = readEmailBodyHydrationAttempted();
  const toHydrate: MessageNeedingHydration[] = [];
  const newlyAttempted: string[] = [];
  for (const row of rows) {
    if (!row.gmail_message_id) continue;
    const entryId = String(row.entry_id);
    const stored = (row.body ?? "").trim();
    const bodyEmpty = stored === "";
    const bodyIsPlainText =
      !bodyEmpty && !bodyLooksLikeHtml(stored) && !attemptedHtmlRehydrate.has(entryId);
    if (bodyEmpty || bodyIsPlainText) {
      toHydrate.push({
        entryId,
        gmailMessageId: row.gmail_message_id,
      });
      if (bodyIsPlainText) {
        newlyAttempted.push(entryId);
      }
    }
  }

  const hydrated = await hydrateMessageBodies(toHydrate);

  // Persist the "attempted" set even when a re-fetch returned the same
  // plain text (genuine plain-text email) — that's the whole point of
  // the marker, so we don't keep fetching the same Gmail message every
  // time the thread is opened.
  if (newlyAttempted.length > 0 && !hydrated.skipped) {
    try {
      markEmailBodyHydrationAttempted(newlyAttempted);
    } catch {
      // Marker writes are best-effort; failure just means we may
      // re-attempt one more time on the next request.
    }
  }

  const messages: Message[] = rows.map((row) => {
    const entryId = String(row.entry_id);
    const fetchedBody = hydrated.bodies.get(entryId);
    return {
      id: entryId,
      subject: row.subject,
      sent_at: row.sent_at,
      preview: row.preview,
      body: fetchedBody ?? row.body,
      has_attachments: row.has_attachments === "true",
      gmail_message_id: row.gmail_message_id,
      sender_type: row.sender_type,
      from_person_id: row.from_relation || null,
      to_person_ids: parseRelationIds(row.to_relation),
      cc_person_ids: parseRelationIds(row.cc_relation),
    };
  });

  return Response.json({
    thread_id: id,
    messages,
    people: Array.from(personById.values()),
    body_hydration: {
      attempted: toHydrate.length,
      fetched: hydrated.bodies.size,
      failed: hydrated.failed,
      skipped: hydrated.skipped,
      rehydrated_plain_text: newlyAttempted.length,
    },
  });
}

function parseRelationIds(value: string | null): string[] {
  if (!value) {return [];}
  const trimmed = value.trim();
  if (!trimmed) {return [];}
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {return parsed.map(String).filter(Boolean);}
    } catch {
      return [trimmed];
    }
  }
  return [trimmed];
}
