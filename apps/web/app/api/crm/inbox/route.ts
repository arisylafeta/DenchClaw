import {
  ONBOARDING_OBJECT_IDS,
} from "@/lib/workspace-schema-migrations";
import {
  buildEntryProjection,
  loadCrmFieldMaps,
  safeQuery,
} from "@/lib/crm-queries";
import { getPostgresInbox } from "@/lib/crm-postgres/inbox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

type ThreadParticipant = {
  id: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
};

type ThreadRow = {
  id: string;
  subject: string | null;
  last_message_at: string | null;
  message_count: number | null;
  gmail_thread_id: string | null;
  participant_ids: string[];
  participants: ThreadParticipant[];
  snippet: string | null;
  primary_sender_type: string | null;
  /** Display name for the row's headline sender — the From of the latest message. */
  primary_sender_name: string | null;
  primary_sender_email: string | null;
  primary_sender_id: string | null;
};

const VALID_SENDER_FILTERS = new Set(["person", "all", "automated"]);
type SenderFilter = "person" | "all" | "automated";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const search = url.searchParams.get("q")?.trim().toLowerCase() ?? "";
  const senderRaw = url.searchParams.get("sender") ?? "person";
  const senderFilter: SenderFilter = (VALID_SENDER_FILTERS.has(senderRaw) ? senderRaw : "person") as SenderFilter;
  const personId = url.searchParams.get("personId")?.trim() || null;
  const limit = clampInt(url.searchParams.get("limit"), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);

  if (process.env.CRM_DB_BACKEND !== "duckdb") {
    const data = await getPostgresInbox({ search, senderFilter, personId, limit, offset });
    return Response.json(data);
  }

  const fieldMaps = await loadCrmFieldMaps();

  const threadProjection = buildEntryProjection({
    objectId: ONBOARDING_OBJECT_IDS.email_thread,
    fieldMap: fieldMaps.email_thread,
    aliasedFields: [
      { name: "Subject", alias: "subject" },
      { name: "Last Message At", alias: "last_message_at" },
      { name: "Message Count", alias: "message_count" },
      { name: "Gmail Thread ID", alias: "gmail_thread_id" },
      { name: "Participants", alias: "participants_json" },
    ],
  });

  let where = "1=1";
  if (search) {
    const safe = search.replace(/'/g, "''");
    where += ` AND LOWER(COALESCE(subject, '')) LIKE '%${safe}%'`;
  }
  if (personId) {
    const safeId = personId.replace(/"/g, '""').replace(/'/g, "''");
    where += ` AND participants_json LIKE '%"${safeId}"%'`;
  }

  // Per-thread "primary sender" = sender of the latest message in the
  // thread. We project sender_type, snippet, AND from_person_id so the
  // list row can show "Sarah Chen" as the headline sender without
  // hydrating the full thread.
  //
  // Performance note: a naive `LEFT JOIN (…aggregate over all messages…)`
  // scales with the ENTIRE email_message table (~10k+ rows for most
  // real inboxes) on every request. Instead we pre-filter the base
  // thread list to a generous window (5× the page size, bounded), then
  // run the aggregate only over messages in those threads. For a page
  // of 100 with 500 candidate threads the aggregate touches ~500-1000
  // rows instead of 10k, cutting the warm-query time to ~1/5.
  const messageThreadFieldId = fieldMaps.email_message["Thread"];
  const messageSentFieldId = fieldMaps.email_message["Sent At"];
  const messageSenderTypeFieldId = fieldMaps.email_message["Sender Type"];
  const messagePreviewFieldId = fieldMaps.email_message["Body Preview"];
  const messageFromFieldId = fieldMaps.email_message["From"];
  const windowSize = Math.max(limit * 5, 250);
  const hasLatestMsg = Boolean(messageThreadFieldId && messageSentFieldId);

  const latestMsgCte = hasLatestMsg
    ? `
        , candidate_threads AS (
          SELECT entry_id FROM base
          WHERE ${where}
          ORDER BY last_message_at DESC NULLS LAST
          LIMIT ${windowSize}
        ),
        latest_msg AS (
          SELECT
            thread_value AS thread_id,
            ${messageSenderTypeFieldId ? "ARG_MAX(sender_type_value, sent_at_value)" : "NULL"} AS sender_type,
            ${messagePreviewFieldId ? "ARG_MAX(preview_value, sent_at_value)" : "NULL"} AS snippet,
            ${messageFromFieldId ? "ARG_MAX(from_value, sent_at_value)" : "NULL"} AS from_person_id
          FROM (
            SELECT
              e.id AS msg_id,
              MAX(CASE WHEN ef.field_id = '${messageThreadFieldId}' THEN ef.value END) AS thread_value,
              MAX(CASE WHEN ef.field_id = '${messageSentFieldId}' THEN ef.value END) AS sent_at_value,
              ${messageSenderTypeFieldId ? `MAX(CASE WHEN ef.field_id = '${messageSenderTypeFieldId}' THEN ef.value END)` : "NULL"} AS sender_type_value,
              ${messagePreviewFieldId ? `MAX(CASE WHEN ef.field_id = '${messagePreviewFieldId}' THEN ef.value END)` : "NULL"} AS preview_value,
              ${messageFromFieldId ? `MAX(CASE WHEN ef.field_id = '${messageFromFieldId}' THEN ef.value END)` : "NULL"} AS from_value
            FROM entries e
            JOIN entry_fields ef
              ON ef.entry_id = e.id
             AND ef.field_id IN ('${messageThreadFieldId}', '${messageSentFieldId}'
               ${messageSenderTypeFieldId ? `, '${messageSenderTypeFieldId}'` : ""}
               ${messagePreviewFieldId ? `, '${messagePreviewFieldId}'` : ""}
               ${messageFromFieldId ? `, '${messageFromFieldId}'` : ""})
            WHERE e.object_id = '${ONBOARDING_OBJECT_IDS.email_message}'
            GROUP BY e.id
          ) m
          WHERE m.thread_value IN (SELECT entry_id FROM candidate_threads)
          GROUP BY thread_value
        )
      `
    : "";

  const senderJoin = hasLatestMsg
    ? `LEFT JOIN latest_msg ON latest_msg.thread_id = base.entry_id`
    : "";

  let senderWhere = "";
  if (hasLatestMsg && senderFilter === "person") {
    senderWhere = `AND (latest_msg.sender_type IS NULL OR latest_msg.sender_type = 'Person')`;
  } else if (hasLatestMsg && senderFilter === "automated") {
    senderWhere = `AND latest_msg.sender_type IS NOT NULL AND latest_msg.sender_type <> 'Person'`;
  }

  // Combined data + count in a single round trip: each DuckDB CLI spawn
  // is ~150ms of pure overhead on this machine, so halving the call count
  // shaves ~150ms off the warm path. `COUNT(*) OVER ()` returns the total
  // of the filtered set on every row (LIMIT applies after the window).
  const sql = `
    WITH base AS (${threadProjection})
    ${latestMsgCte}
    SELECT
      base.*,
      ${hasLatestMsg ? "latest_msg.sender_type AS sender_type, latest_msg.snippet AS snippet, latest_msg.from_person_id AS from_person_id" : "NULL AS sender_type, NULL AS snippet, NULL AS from_person_id"},
      COUNT(*) OVER () AS _total
    FROM base
    ${senderJoin}
    WHERE ${where}
      ${senderWhere}
    ORDER BY base.last_message_at DESC NULLS LAST
    LIMIT ${limit} OFFSET ${offset};
  `;

  const threadRows = await safeQuery<Record<string, string | null>>(sql);
  const total = threadRows[0]?._total ? Number(threadRows[0]._total) : 0;

  // Hydrate participants — including the latest-message sender id so the
  // row can show "Sarah Chen" without a second query.
  const participantIdSet = new Set<string>();
  const parsedThreads = threadRows.map((row) => {
    const ids = parseRelationIds(row.participants_json);
    for (const id of ids) {
      participantIdSet.add(id);
    }
    if (row.from_person_id) {
      participantIdSet.add(row.from_person_id);
    }
    return {
      id: String(row.entry_id),
      subject: row.subject,
      last_message_at: row.last_message_at,
      message_count: row.message_count ? Number(row.message_count) : null,
      gmail_thread_id: row.gmail_thread_id,
      participant_ids: ids,
      snippet: row.snippet,
      primary_sender_type: row.sender_type,
      primary_sender_id: row.from_person_id ?? null,
    };
  });

  const peopleNameFieldId = fieldMaps.people["Full Name"];
  const peopleEmailFieldId = fieldMaps.people["Email Address"];
  const peopleAvatarFieldId = fieldMaps.people["Avatar URL"];
  const personById = new Map<string, ThreadParticipant>();
  if (participantIdSet.size > 0 && (peopleNameFieldId || peopleEmailFieldId)) {
    const inList = Array.from(participantIdSet)
      .map((id) => `'${id.replace(/'/g, "''")}'`)
      .join(", ");
    const sqlPeople = `
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
    }>(sqlPeople);
    for (const row of peopleRows) {
      personById.set(row.person_id, {
        id: row.person_id,
        name: row.name,
        email: row.email,
        avatar_url: row.avatar_url,
      });
    }
  }

  const threads: ThreadRow[] = parsedThreads.map((t) => {
    // Build participants array, with the From-of-latest-message bumped
    // to position 0 so list rows show the most relevant face.
    const seen = new Set<string>();
    const participants: ThreadParticipant[] = [];
    if (t.primary_sender_id) {
      const sender = personById.get(t.primary_sender_id);
      if (sender) {
        participants.push(sender);
        seen.add(sender.id);
      }
    }
    for (const id of t.participant_ids) {
      if (seen.has(id)) {continue;}
      const p = personById.get(id);
      if (p) {
        participants.push(p);
        seen.add(id);
      }
    }
    const primary = t.primary_sender_id ? personById.get(t.primary_sender_id) : undefined;
    return {
      id: t.id,
      subject: t.subject,
      last_message_at: t.last_message_at,
      message_count: t.message_count,
      gmail_thread_id: t.gmail_thread_id,
      participant_ids: t.participant_ids,
      participants,
      snippet: t.snippet,
      primary_sender_type: t.primary_sender_type,
      primary_sender_id: primary?.id ?? null,
      primary_sender_name: primary?.name ?? null,
      primary_sender_email: primary?.email ?? null,
    };
  });

  return Response.json({ threads, total, limit, offset, sender: senderFilter });
}

function clampInt(raw: string | null, fallback: number, max: number): number {
  const parsed = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {return fallback;}
  return Math.min(parsed, max);
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
