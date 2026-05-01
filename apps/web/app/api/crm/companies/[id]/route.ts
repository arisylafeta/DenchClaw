import {
  ONBOARDING_OBJECT_IDS,
} from "@/lib/workspace-schema-migrations";
import {
  buildEntryProjection,
  buildLatestMessagePerThreadCte,
  hydratePeopleByIds,
  jsonArrayContains,
  loadCrmFieldMaps,
  safeQuery,
  sqlString,
} from "@/lib/crm-queries";
import { deriveDisplayDomain, deriveWebsite } from "@/lib/website-from-domain";
import { getConnectionStrengthBucket } from "@/lib/connection-strength-label";
import { getPostgresCompanyProfile } from "@/lib/crm-postgres/company-profile";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const companyId = id?.trim();
  if (!companyId) {
    return Response.json({ error: "Missing company id." }, { status: 400 });
  }

  if (process.env.CRM_DB_BACKEND === "postgres") {
    const profile = await getPostgresCompanyProfile(companyId);
    if (!profile) {
      return Response.json({ error: "Company not found." }, { status: 404 });
    }
    return Response.json(profile);
  }

  const fieldMaps = await loadCrmFieldMaps();

  // ─── 1. Company row ──────────────────────────────────────────────────
  const companySql = buildEntryProjection({
    objectId: ONBOARDING_OBJECT_IDS.company,
    fieldMap: fieldMaps.company,
    aliasedFields: [
      { name: "Company Name", alias: "name" },
      { name: "Domain", alias: "domain" },
      { name: "Website", alias: "website" },
      { name: "Industry", alias: "industry" },
      { name: "Type", alias: "type" },
      { name: "Source", alias: "source" },
      { name: "Strength Score", alias: "strength_score" },
      { name: "Last Interaction At", alias: "last_interaction_at" },
      { name: "Notes", alias: "notes" },
    ],
    whereSql: `e.id = ${sqlString(companyId)}`,
  });
  const companyRows = await safeQuery<Record<string, string | null>>(companySql);
  if (companyRows.length === 0) {
    return Response.json({ error: "Company not found." }, { status: 404 });
  }
  const raw = companyRows[0];
  const strengthScoreNum = raw.strength_score ? Number(raw.strength_score) : 0;
  const bucket = getConnectionStrengthBucket(strengthScoreNum);
  const company = {
    id: String(raw.entry_id),
    name: raw.name,
    domain: raw.domain,
    website: raw.website ?? deriveWebsite(raw.domain ?? null),
    industry: raw.industry,
    type: raw.type,
    source: raw.source,
    strength_score: Number.isFinite(strengthScoreNum) ? strengthScoreNum : null,
    strength_label: bucket.label,
    strength_color: bucket.color,
    last_interaction_at: raw.last_interaction_at,
    notes: raw.notes,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
  };

  // ─── 2. People at this company ─────────────────────────────────────────
  type PersonRow = Record<string, string | null>;
  let people: Array<{
    id: string;
    name: string | null;
    email: string | null;
    job_title: string | null;
    strength_score: number | null;
    strength_label: string;
    strength_color: string;
    last_interaction_at: string | null;
    avatar_url: string | null;
  }> = [];
  const companyDomain = deriveDisplayDomain(company.domain ?? company.website);
  const peopleCompanyFieldId = fieldMaps.people["Company"];
  const peoplePredicates: string[] = [];
  if (peopleCompanyFieldId) {
    peoplePredicates.push(
      `sub.company_id = ${sqlString(company.id)}`,
      jsonArrayContains("sub.company_id", company.id),
    );
  }
  if (companyDomain) {
    const domainSql = sqlString(companyDomain.toLowerCase());
    const emailDomainSql = "LOWER(SUBSTR(sub.email, INSTR(sub.email, '@') + 1))";
    peoplePredicates.push(
      `${emailDomainSql} = ${domainSql}`,
      `${emailDomainSql} LIKE '%.' || ${domainSql}`,
    );
  }

  if (peoplePredicates.length > 0) {
    const peopleProjection = buildEntryProjection({
      objectId: ONBOARDING_OBJECT_IDS.people,
      fieldMap: fieldMaps.people,
      aliasedFields: [
        { name: "Full Name", alias: "name" },
        { name: "Email Address", alias: "email" },
        { name: "Company", alias: "company_id" },
        { name: "Job Title", alias: "job_title" },
        { name: "Strength Score", alias: "strength_score" },
        { name: "Last Interaction At", alias: "last_interaction_at" },
        { name: "Avatar URL", alias: "avatar_url" },
      ],
    });
    // Defense-in-depth dedupe: even with `mergeDuplicatePeople` running on
    // every sync, brand-new duplicates could appear briefly between an
    // incremental Gmail/Calendar write and the next merge tick. Picking
    // DISTINCT ON the lowercased email keeps the Team tab clean. Rows
    // without an email get their own bucket via COALESCE(entry_id) so we
    // don't accidentally collapse two anonymous people into one.
    const sql = `
      SELECT * FROM (
        SELECT DISTINCT ON (COALESCE(LOWER(TRIM(sub.email)), sub.entry_id)) sub.*
        FROM (${peopleProjection}) sub
        WHERE ${peoplePredicates.map((predicate) => `(${predicate})`).join("\n           OR ")}
        ORDER BY COALESCE(LOWER(TRIM(sub.email)), sub.entry_id),
                 TRY_CAST(sub.strength_score AS DOUBLE) DESC NULLS LAST,
                 sub.last_interaction_at DESC NULLS LAST
      ) deduped
      ORDER BY TRY_CAST(deduped.strength_score AS DOUBLE) DESC NULLS LAST,
               deduped.last_interaction_at DESC NULLS LAST
      LIMIT 100;
    `;
    const peopleRows = await safeQuery<PersonRow>(sql);
    people = peopleRows.map((row) => {
      const score = row.strength_score ? Number(row.strength_score) : 0;
      const personBucket = getConnectionStrengthBucket(score);
      return {
        id: String(row.entry_id),
        name: row.name,
        email: row.email,
        job_title: row.job_title,
        strength_score: Number.isFinite(score) ? score : null,
        strength_label: personBucket.label,
        strength_color: personBucket.color,
        last_interaction_at: row.last_interaction_at,
        avatar_url: row.avatar_url,
      };
    });
  }

  // ─── 3. Email threads where Company is in Companies relation ─────────
  // Returns the same enriched Thread shape as Person profile + Inbox, so
  // ProfileThreadList can render the inline conversation reader.
  const threadCompaniesFieldId = fieldMaps.email_thread["Companies"];
  let threads: Array<{
    id: string;
    subject: string | null;
    last_message_at: string | null;
    message_count: number | null;
    gmail_thread_id: string | null;
    snippet: string | null;
    primary_sender_type: string | null;
    primary_sender_id: string | null;
    primary_sender_name: string | null;
    primary_sender_email: string | null;
    primary_sender_avatar_url: string | null;
  }> = [];
  if (threadCompaniesFieldId) {
    const threadProjection = buildEntryProjection({
      objectId: ONBOARDING_OBJECT_IDS.email_thread,
      fieldMap: fieldMaps.email_thread,
      aliasedFields: [
        { name: "Subject", alias: "subject" },
        { name: "Last Message At", alias: "last_message_at" },
        { name: "Message Count", alias: "message_count" },
        { name: "Gmail Thread ID", alias: "gmail_thread_id" },
      ],
    });
    const safeCompanyForLike = company.id
      .replace(/"/g, '""')
      .replace(/'/g, "''");
    const safeCompaniesFieldId = threadCompaniesFieldId.replace(/'/g, "''");
    const candidateThreadsCte = `candidate_threads`;
    const latestMsg = buildLatestMessagePerThreadCte({
      emailMessageFieldMap: fieldMaps.email_message,
      candidateThreadIdsCte: candidateThreadsCte,
    });
    const sql = `
      WITH base AS (${threadProjection}),
      ${candidateThreadsCte} AS (
        SELECT entry_id FROM base
        WHERE EXISTS (
          SELECT 1 FROM entry_fields c
          WHERE c.entry_id = base.entry_id
            AND c.field_id = '${safeCompaniesFieldId}'
            AND c.value LIKE '%"${safeCompanyForLike}"%'
        )
        ORDER BY last_message_at DESC NULLS LAST
        LIMIT 50
      )${latestMsg ? `, ${latestMsg.cte}` : ""}
      SELECT
        base.*${latestMsg ? `,
        latest_msg.sender_type AS sender_type,
        latest_msg.snippet AS snippet,
        latest_msg.from_person_id AS from_person_id` : `,
        NULL AS sender_type, NULL AS snippet, NULL AS from_person_id`}
      FROM base
      ${latestMsg ? latestMsg.joinClause : ""}
      WHERE base.entry_id IN (SELECT entry_id FROM ${candidateThreadsCte})
      ORDER BY base.last_message_at DESC NULLS LAST;
    `;
    const rows = await safeQuery<Record<string, string | null>>(sql);

    // Hydrate the From-of-latest-message senders for the row chrome.
    const senderIds = new Set<string>();
    for (const row of rows) {
      if (row.from_person_id) {senderIds.add(row.from_person_id);}
    }
    const senderMap = await hydratePeopleByIds(
      Array.from(senderIds),
      fieldMaps.people,
    );

    threads = rows.map((row) => {
      const senderId = row.from_person_id ?? null;
      const sender = senderId ? senderMap.get(senderId) ?? null : null;
      return {
        id: String(row.entry_id),
        subject: row.subject,
        last_message_at: row.last_message_at,
        message_count: row.message_count ? Number(row.message_count) : null,
        gmail_thread_id: row.gmail_thread_id,
        snippet: row.snippet,
        primary_sender_type: row.sender_type,
        primary_sender_id: senderId,
        primary_sender_name: sender?.name ?? null,
        primary_sender_email: sender?.email ?? null,
        primary_sender_avatar_url: sender?.avatar_url ?? null,
      };
    });
  }

  // ─── 4. Calendar events where Company is in Companies relation ───────
  const eventCompaniesFieldId = fieldMaps.calendar_event["Companies"];
  let events: Array<{
    id: string;
    title: string | null;
    start_at: string | null;
    end_at: string | null;
    meeting_type: string | null;
  }> = [];
  if (eventCompaniesFieldId) {
    const eventProjection = buildEntryProjection({
      objectId: ONBOARDING_OBJECT_IDS.calendar_event,
      fieldMap: fieldMaps.calendar_event,
      aliasedFields: [
        { name: "Title", alias: "title" },
        { name: "Start At", alias: "start_at" },
        { name: "End At", alias: "end_at" },
        { name: "Meeting Type", alias: "meeting_type" },
      ],
    });
    const safeId = company.id.replace(/"/g, '""').replace(/'/g, "''");
    const sql = `
      SELECT * FROM (${eventProjection}) sub
      WHERE EXISTS (
        SELECT 1 FROM entry_fields c
        WHERE c.entry_id = sub.entry_id
          AND c.field_id = '${eventCompaniesFieldId.replace(/'/g, "''")}'
          AND c.value LIKE '%"${safeId}"%'
      )
      ORDER BY start_at DESC NULLS LAST
      LIMIT 50;
    `;
    const rows = await safeQuery<Record<string, string | null>>(sql);
    events = rows.map((row) => ({
      id: String(row.entry_id),
      title: row.title,
      start_at: row.start_at,
      end_at: row.end_at,
      meeting_type: row.meeting_type,
    }));
  }

  // ─── 5. Summary stats ────────────────────────────────────────────────
  const summary = {
    people_count: people.length,
    thread_count: threads.length,
    event_count: events.length,
    strongest_contact: people[0]?.name ?? people[0]?.email ?? null,
  };

  return Response.json({
    company,
    people,
    threads,
    events,
    summary,
  });
}
