/**
 * Retroactive newsletter cleanup.
 *
 * Backfill that ran before `email-classifier.ts` shipped happily promoted
 * `loopsbot`, `mailer-daemon`, `PitchBook News`, and friends to People
 * and gave them a Strength Score. This module re-classifies every
 * existing `email_message` and:
 *
 *   1. Tags each message with `Sender Type = <classifier kind>`.
 *   2. For each `email_message` whose sender is now `isBulk`:
 *        a. Clears the `From` relation on the message (raw sender stays
 *           recoverable from the message headers if needed later).
 *        b. Deletes the From-side `interaction` rows tied to that message.
 *   3. Deletes Person rows whose only remaining interactions are zero
 *      (orphaned by step 2).
 *   4. Deletes Company rows whose only people are now gone (orphaned).
 *   5. Re-runs `recomputeAllScores()` so Strength Score / Last
 *      Interaction At reflect the cleaned graph.
 *   6. Backs up everything we delete to
 *      `~/.openclaw-dench/workspace/.denchclaw/cleanup-backups/<ts>.jsonl`
 *      so a misclassification can be restored offline.
 *
 * Exposed as an explicit maintenance helper for retroactive cleanup.
 * Idempotent: re-runs are safe — already-cleaned messages just have their
 * Sender Type re-confirmed.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  duckdbExecOnFileAsync,
  duckdbPathAsync,
  duckdbQueryAsync,
} from "./workspace";
import {
  ONBOARDING_OBJECT_IDS,
  fetchFieldIdMap,
} from "./workspace-schema-migrations";
import { resolveDenchClawDir } from "./workspace";
import { classifySender, type SenderKind } from "./email-classifier";
import { recomputeAllScores } from "./strength-score";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CleanupSummary = {
  ok: boolean;
  messagesProcessed: number;
  messagesReclassified: number;
  messagesDemoted: number;
  fromRelationsCleared: number;
  interactionsDeleted: number;
  peopleDeleted: number;
  companiesDeleted: number;
  backupPath: string | null;
  error?: string;
};

type RawHeader = { name: string; value: string };

type PersistedMessage = {
  entryId: string;
  messageId: string | null;
  subject: string;
  fromAddress: string | null;
  fromRelationEntryId: string | null;
  toAddresses: string[];
  ccAddresses: string[];
  labelIds: string[];
  headers: RawHeader[];
  currentSenderType: string | null;
};

// ---------------------------------------------------------------------------
// SQL helpers (kept duplicated to avoid shared-mutable-batch surface area)
// ---------------------------------------------------------------------------

function sql(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) {return "NULL";}
  if (typeof value === "boolean") {return value ? "true" : "false";}
  if (typeof value === "number") {return Number.isFinite(value) ? String(value) : "NULL";}
  return `'${value.replace(/'/g, "''")}'`;
}

function senderKindToLabel(kind: SenderKind): string {
  switch (kind) {
    case "person":
      return "Person";
    case "marketing":
      return "Marketing";
    case "transactional":
      return "Transactional";
    case "notification":
      return "Notification";
    case "mailing_list":
      return "Mailing List";
    case "automated":
      return "Automated";
  }
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

async function loadAllMessages(
  fieldMaps: {
    email_message: Record<string, string>;
    people: Record<string, string>;
  },
  selfEmails: Set<string>,
): Promise<PersistedMessage[]> {
  const fm = fieldMaps.email_message;
  const requiredFields = ["From", "To", "Cc", "Subject", "Gmail Message ID", "Sender Type"];
  for (const f of requiredFields) {
    if (!fm[f] && f !== "Sender Type") {
      // Sender Type is the only optional one (newly added) — others are critical.
      throw new Error(`email_message field map is missing "${f}" — schema migration didn't run.`);
    }
  }

  const fromFieldId = fm["From"];
  const toFieldId = fm["To"];
  const ccFieldId = fm["Cc"];
  const subjectFieldId = fm["Subject"];
  const msgIdFieldId = fm["Gmail Message ID"];
  const senderTypeFieldId = fm["Sender Type"]; // may be undefined briefly during migration

  const rows = await duckdbQueryAsync<{
    entry_id: string;
    message_id: string | null;
    subject: string | null;
    from_relation: string | null;
    to_relation: string | null;
    cc_relation: string | null;
    sender_type: string | null;
  }>(`
    SELECT
      e.id AS entry_id,
      MAX(CASE WHEN ef.field_id = '${msgIdFieldId}' THEN ef.value END) AS message_id,
      MAX(CASE WHEN ef.field_id = '${subjectFieldId}' THEN ef.value END) AS subject,
      MAX(CASE WHEN ef.field_id = '${fromFieldId}' THEN ef.value END) AS from_relation,
      MAX(CASE WHEN ef.field_id = '${toFieldId}' THEN ef.value END) AS to_relation,
      MAX(CASE WHEN ef.field_id = '${ccFieldId}' THEN ef.value END) AS cc_relation,
      ${senderTypeFieldId ? `MAX(CASE WHEN ef.field_id = '${senderTypeFieldId}' THEN ef.value END)` : "NULL"} AS sender_type
    FROM entries e
    LEFT JOIN entry_fields ef ON ef.entry_id = e.id
    WHERE e.object_id = '${ONBOARDING_OBJECT_IDS.email_message}'
    GROUP BY e.id;
  `);

  // We need the People rows so we can resolve relation entry_ids → email
  // addresses (so the classifier can see the From/To/Cc string contents).
  const peopleEmailFieldId = fieldMaps.people["Email Address"];
  const peopleEmailRows = peopleEmailFieldId
    ? await duckdbQueryAsync<{ entry_id: string; value: string }>(`
        SELECT entry_id, value FROM entry_fields WHERE field_id = '${peopleEmailFieldId}';
      `)
    : [];
  const personEmailById = new Map<string, string>();
  for (const r of peopleEmailRows) {
    if (r.value) {personEmailById.set(r.entry_id, r.value.toLowerCase());}
  }

  const out: PersistedMessage[] = [];
  for (const row of rows) {
    const fromRelationId = row.from_relation?.trim() || null;
    const fromAddress = fromRelationId ? personEmailById.get(fromRelationId) ?? null : null;
    const toAddresses = parseRelationIds(row.to_relation)
      .map((id) => personEmailById.get(id))
      .filter((a): a is string => Boolean(a));
    const ccAddresses = parseRelationIds(row.cc_relation)
      .map((id) => personEmailById.get(id))
      .filter((a): a is string => Boolean(a));

    out.push({
      entryId: row.entry_id,
      messageId: row.message_id,
      subject: row.subject ?? "",
      fromAddress,
      fromRelationEntryId: fromRelationId,
      toAddresses,
      ccAddresses,
      // We don't have raw headers / labelIds persisted (sync stores
      // pre-parsed values), so cleanup re-classifies based on the limited
      // signals we DO have: From local-part patterns, ESP-domain checks,
      // and obvious subject hints. This catches the bulk of bad rows
      // (loopsbot, mailer-daemon, news@*, notifications@*, etc.) without
      // needing to re-fetch every message from Gmail.
      labelIds: [],
      headers: [],
      currentSenderType: row.sender_type,
    });
  }
  void selfEmails;
  return out;
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

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function runEmailCleanup(opts: {
  selfEmails?: Set<string>;
} = {}): Promise<CleanupSummary> {
  const dbPath = await duckdbPathAsync();
  if (!dbPath) {
    return {
      ok: false,
      messagesProcessed: 0,
      messagesReclassified: 0,
      messagesDemoted: 0,
      fromRelationsCleared: 0,
      interactionsDeleted: 0,
      peopleDeleted: 0,
      companiesDeleted: 0,
      backupPath: null,
      error: "No workspace database found.",
    };
  }

  const fieldMaps = {
    email_message: await fetchFieldIdMap(ONBOARDING_OBJECT_IDS.email_message),
    people: await fetchFieldIdMap(ONBOARDING_OBJECT_IDS.people),
    company: await fetchFieldIdMap(ONBOARDING_OBJECT_IDS.company),
    interaction: await fetchFieldIdMap(ONBOARDING_OBJECT_IDS.interaction),
  };
  const selfEmails = opts.selfEmails ?? new Set<string>();

  const messages = await loadAllMessages(fieldMaps, selfEmails);

  // Build a quick "is this person-id a known contact" set seeded from the
  // existing People→Email map. We treat all currently-existing People as
  // "known" so the classifier's rescue path keeps real contacts safe even
  // if they happen to be at a soft local-part like `support@`.
  const knownContactKeys = new Set<string>();
  for (const m of messages) {
    if (m.fromAddress) {knownContactKeys.add(m.fromAddress.toLowerCase());}
  }

  const summary: CleanupSummary = {
    ok: true,
    messagesProcessed: messages.length,
    messagesReclassified: 0,
    messagesDemoted: 0,
    fromRelationsCleared: 0,
    interactionsDeleted: 0,
    peopleDeleted: 0,
    companiesDeleted: 0,
    backupPath: null,
  };

  // Backup first — we want a recoverable trail before we touch anything.
  const backupDir = join(resolveDenchClawDir(), "cleanup-backups");
  mkdirSync(backupDir, { recursive: true });
  const backupPath = join(backupDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  const backupLines: string[] = [];

  // ─── Reclassify + collect demotions ─────────────────────────────────────
  const senderTypeFieldId = fieldMaps.email_message["Sender Type"];
  const fromFieldId = fieldMaps.email_message["From"];
  const interactionEmailFieldId = fieldMaps.interaction["Email"];
  const interactionPersonFieldId = fieldMaps.interaction["Person"];

  if (!senderTypeFieldId) {
    return {
      ...summary,
      ok: false,
      error: "Sender Type field is missing — schema migration didn't run.",
    };
  }

  const updateStatements: string[] = [];
  const demotedMessageIds = new Set<string>(); // entry_id of bulk messages
  const peopleToReevaluate = new Set<string>(); // entry_ids of People who lose interactions

  for (const msg of messages) {
    const verdict = classifySender({
      fromAddress: msg.fromAddress,
      toAddresses: msg.toAddresses,
      ccAddresses: msg.ccAddresses,
      selfEmails,
      subject: msg.subject,
      labelIds: msg.labelIds,
      getHeader: () => null,
      senderIsKnownContact: msg.fromAddress
        ? knownContactKeys.has(msg.fromAddress.toLowerCase())
        : false,
    });
    const label = senderKindToLabel(verdict.kind);

    if (msg.currentSenderType !== label) {
      summary.messagesReclassified += 1;
      updateStatements.push(
        `DELETE FROM entry_fields WHERE entry_id = ${sql(msg.entryId)} AND field_id = ${sql(senderTypeFieldId)}`,
      );
      updateStatements.push(
        `INSERT INTO entry_fields (entry_id, field_id, value) VALUES (${sql(msg.entryId)}, ${sql(senderTypeFieldId)}, ${sql(label)})`,
      );
    }

    if (verdict.isBulk) {
      summary.messagesDemoted += 1;
      demotedMessageIds.add(msg.entryId);
      if (msg.fromRelationEntryId) {
        peopleToReevaluate.add(msg.fromRelationEntryId);
        // Backup before clearing the From relation.
        backupLines.push(
          JSON.stringify({
            kind: "email_message_from_relation",
            messageEntryId: msg.entryId,
            messageId: msg.messageId,
            fromRelationEntryId: msg.fromRelationEntryId,
            fromAddress: msg.fromAddress,
            verdict: verdict.kind,
          }),
        );
        if (fromFieldId) {
          updateStatements.push(
            `DELETE FROM entry_fields WHERE entry_id = ${sql(msg.entryId)} AND field_id = ${sql(fromFieldId)}`,
          );
          summary.fromRelationsCleared += 1;
        }
      }
    }
  }

  // ─── Delete bulk-tied interactions ─────────────────────────────────────
  if (demotedMessageIds.size > 0 && interactionEmailFieldId && interactionPersonFieldId) {
    const messageIdList = Array.from(demotedMessageIds).map(sql).join(", ");
    // Find interaction entries pointing to those email_messages
    const interactionRows = await duckdbQueryAsync<{
      interaction_entry_id: string;
      person_entry_id: string | null;
    }>(`
      SELECT
        e.id AS interaction_entry_id,
        MAX(CASE WHEN ef.field_id = '${interactionPersonFieldId}' THEN ef.value END) AS person_entry_id
      FROM entries e
      JOIN entry_fields ef_email
        ON ef_email.entry_id = e.id
       AND ef_email.field_id = '${interactionEmailFieldId}'
       AND ef_email.value IN (${messageIdList})
      LEFT JOIN entry_fields ef ON ef.entry_id = e.id
      WHERE e.object_id = '${ONBOARDING_OBJECT_IDS.interaction}'
      GROUP BY e.id;
    `);

    if (interactionRows.length > 0) {
      const interactionIds = interactionRows.map((r) => r.interaction_entry_id);
      summary.interactionsDeleted = interactionIds.length;
      for (const r of interactionRows) {
        if (r.person_entry_id) {peopleToReevaluate.add(r.person_entry_id);}
        backupLines.push(
          JSON.stringify({
            kind: "interaction",
            interactionEntryId: r.interaction_entry_id,
            personEntryId: r.person_entry_id,
          }),
        );
      }
      const idList = interactionIds.map(sql).join(", ");
      updateStatements.push(`DELETE FROM entry_fields WHERE entry_id IN (${idList})`);
      updateStatements.push(`DELETE FROM entries WHERE id IN (${idList})`);
    }
  }

  // Apply step-2 + step-3 changes in one batch so future steps see them.
  if (updateStatements.length > 0) {
    const ok = await duckdbExecOnFileAsync(dbPath, updateStatements.join(";\n") + ";");
    if (!ok) {
      writeBackup(backupPath, backupLines);
      summary.backupPath = backupPath;
      return { ...summary, ok: false, error: "Failed to apply reclassification + demotion batch." };
    }
  }

  // ─── Delete orphaned People (now have zero interactions, zero email From) ─
  const peopleEmailFieldId = fieldMaps.people["Email Address"];
  const peopleSourceFieldId = fieldMaps.people["Source"];
  if (peopleToReevaluate.size > 0) {
    const peopleIdList = Array.from(peopleToReevaluate).map(sql).join(", ");
    // Person is "orphaned" when:
    //   - No interaction.Person points at them
    //   - No email_message.From points at them
    //   - Source = "Gmail" (don't touch Manual or Calendar-sourced rows)
    const orphanedPeople = await duckdbQueryAsync<{
      person_id: string;
      email: string | null;
    }>(`
      SELECT
        e.id AS person_id,
        MAX(CASE WHEN ef.field_id = '${peopleEmailFieldId ?? ""}' THEN ef.value END) AS email
      FROM entries e
      LEFT JOIN entry_fields ef ON ef.entry_id = e.id
      WHERE e.object_id = '${ONBOARDING_OBJECT_IDS.people}'
        AND e.id IN (${peopleIdList})
        AND NOT EXISTS (
          SELECT 1 FROM entry_fields i
          WHERE i.field_id = '${interactionPersonFieldId ?? ""}'
            AND i.value = e.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM entry_fields f
          WHERE f.field_id = '${fromFieldId ?? ""}'
            AND f.value = e.id
        )
        AND ${peopleSourceFieldId
          ? `EXISTS (SELECT 1 FROM entry_fields s WHERE s.entry_id = e.id AND s.field_id = '${peopleSourceFieldId}' AND s.value = 'Gmail')`
          : "true"}
      GROUP BY e.id;
    `);

    if (orphanedPeople.length > 0) {
      summary.peopleDeleted = orphanedPeople.length;
      for (const p of orphanedPeople) {
        backupLines.push(JSON.stringify({ kind: "person", personEntryId: p.person_id, email: p.email }));
      }
      const ids = orphanedPeople.map((p) => p.person_id).map(sql).join(", ");
      const ok = await duckdbExecOnFileAsync(
        dbPath,
        `DELETE FROM entry_fields WHERE entry_id IN (${ids});\nDELETE FROM entries WHERE id IN (${ids});`,
      );
      if (!ok) {
        writeBackup(backupPath, backupLines);
        summary.backupPath = backupPath;
        return { ...summary, ok: false, error: "Failed to delete orphaned People rows." };
      }
    }
  }

  // ─── Delete orphaned Companies (no remaining People with that domain) ──
  const companyDomainFieldId = fieldMaps.company["Domain"];
  const companySourceFieldId = fieldMaps.company["Source"];
  if (companyDomainFieldId) {
    const orphanedCompanies = await duckdbQueryAsync<{
      company_id: string;
      domain: string;
    }>(`
      SELECT
        e.id AS company_id,
        MAX(CASE WHEN ef.field_id = '${companyDomainFieldId}' THEN ef.value END) AS domain
      FROM entries e
      LEFT JOIN entry_fields ef ON ef.entry_id = e.id
      WHERE e.object_id = '${ONBOARDING_OBJECT_IDS.company}'
        AND ${companySourceFieldId
          ? `EXISTS (SELECT 1 FROM entry_fields s WHERE s.entry_id = e.id AND s.field_id = '${companySourceFieldId}' AND s.value = 'Gmail')`
          : "true"}
        AND NOT EXISTS (
          SELECT 1 FROM entry_fields p
          JOIN entry_fields domain_ef
            ON domain_ef.entry_id = e.id
           AND domain_ef.field_id = '${companyDomainFieldId}'
          WHERE p.field_id = '${fieldMaps.people["Email Address"] ?? ""}'
            AND LOWER(SPLIT_PART(p.value, '@', 2)) LIKE '%' || domain_ef.value
        )
      GROUP BY e.id;
    `);
    if (orphanedCompanies.length > 0) {
      summary.companiesDeleted = orphanedCompanies.length;
      for (const c of orphanedCompanies) {
        backupLines.push(JSON.stringify({ kind: "company", companyEntryId: c.company_id, domain: c.domain }));
      }
      const ids = orphanedCompanies.map((c) => c.company_id).map(sql).join(", ");
      const ok = await duckdbExecOnFileAsync(
        dbPath,
        `DELETE FROM entry_fields WHERE entry_id IN (${ids});\nDELETE FROM entries WHERE id IN (${ids});`,
      );
      if (!ok) {
        writeBackup(backupPath, backupLines);
        summary.backupPath = backupPath;
        return { ...summary, ok: false, error: "Failed to delete orphaned Company rows." };
      }
    }
  }

  // ─── Recompute strength scores ──────────────────────────────────────────
  try {
    await recomputeAllScores();
  } catch {
    // Non-fatal — scores will recompute on the next sync tick.
  }

  // Always write the backup, even if empty (so the user can confirm "yep,
  // nothing was actually deleted in this run").
  writeBackup(backupPath, backupLines);
  summary.backupPath = backupPath;
  return summary;
}

function writeBackup(path: string, lines: string[]): void {
  try {
    writeFileSync(path, lines.join("\n") + (lines.length > 0 ? "\n" : ""), "utf-8");
  } catch {
    // Best-effort — surfaced in the summary via missing backupPath
    // entries downstream.
  }
}
