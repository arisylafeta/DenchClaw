/**
 * Strongest-connection scoring — Attio-derived weighted formula.
 *
 *   score(person) = Σ over interactions i:
 *     weight(type_i) × recency_decay(age_days_i) × directness(role_i) × thread_bonus_i
 *
 * Per-interaction `Score Contribution` is computed during ingestion (cheap,
 * pure function) and stored on the `interaction` row. The aggregated
 * `Strength Score` on `people` and `company` is recomputed by the
 * `recomputeAllScores` helper after importing or merging interactions and
 * whenever a caller needs to apply time-based decay.
 *
 * The whole model is intentionally tweakable in one place — change the
 * constants here, re-run `recomputeAllScores`, the People view re-sorts.
 */

import {
  duckdbExecOnFileAsync,
  duckdbPathAsync,
  duckdbQueryAsync,
} from "./workspace";
import { ONBOARDING_OBJECT_IDS } from "./workspace-schema-migrations";

// ---------------------------------------------------------------------------
// Constants — tweak here.
// ---------------------------------------------------------------------------

export const SCORE_WEIGHTS = {
  email: 1.0,
  oneOnOneMeeting: 8.0,
  smallGroupMeeting: 3.0, // 3–5 attendees
  largeGroupMeeting: 0.5, // > 5 attendees
} as const;

export const DIRECTNESS = {
  to: 1.0,
  cc: 0.3,
  bcc: 0.1,
  from: 1.0,
  meetingOrganizer: 1.5,
  meetingAttendeeAccepted: 1.0,
  meetingAttendeeTentative: 0.5,
  meetingAttendeeDeclined: 0.0,
} as const;

export const THREAD_BONUS = {
  twoWayMultiplier: 1.2, // both directions seen → +20%
  threadInitiatorMultiplier: 1.1, // user sent first message → +10%
  fastReplyMultiplier: 1.1, // counterparty replied within 24h → +10%
} as const;

/** ~60-day half-life: exp(-age_days / 90) → 0.5 at ~62 days. */
export const RECENCY_DECAY_TAU_DAYS = 90;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function recencyDecay(ageDays: number): number {
  if (!Number.isFinite(ageDays) || ageDays < 0) {return 1;}
  return Math.exp(-ageDays / RECENCY_DECAY_TAU_DAYS);
}

export type EmailRole = "from" | "to" | "cc" | "bcc";
export type MeetingResponse = "accepted" | "tentative" | "declined" | "needsAction";

export function emailDirectness(role: EmailRole): number {
  switch (role) {
    case "from":
      return DIRECTNESS.from;
    case "to":
      return DIRECTNESS.to;
    case "cc":
      return DIRECTNESS.cc;
    case "bcc":
      return DIRECTNESS.bcc;
  }
}

export function meetingDirectness(role: "organizer" | "attendee", response: MeetingResponse): number {
  if (role === "organizer") {return DIRECTNESS.meetingOrganizer;}
  switch (response) {
    case "accepted":
    case "needsAction":
      return DIRECTNESS.meetingAttendeeAccepted;
    case "tentative":
      return DIRECTNESS.meetingAttendeeTentative;
    case "declined":
      return DIRECTNESS.meetingAttendeeDeclined;
  }
}

export function meetingTypeWeight(attendeeCount: number): number {
  if (attendeeCount <= 2) {return SCORE_WEIGHTS.oneOnOneMeeting;}
  if (attendeeCount <= 5) {return SCORE_WEIGHTS.smallGroupMeeting;}
  return SCORE_WEIGHTS.largeGroupMeeting;
}

export type EmailScoreInput = {
  /** Days since the email was sent. Non-negative. */
  ageDays: number;
  /** The counterparty's role on this message relative to "self". */
  role: EmailRole;
  /** Set if "self" both sent and received within the same thread. */
  twoWayThread?: boolean;
  /** Set if "self" sent the first message of the thread. */
  threadInitiator?: boolean;
  /** Set if the counterparty replied to "self" within 24h on this thread. */
  fastReply?: boolean;
};

export function scoreEmailInteraction(input: EmailScoreInput): number {
  const base = SCORE_WEIGHTS.email * recencyDecay(input.ageDays) * emailDirectness(input.role);
  let multiplier = 1;
  if (input.twoWayThread) {multiplier *= THREAD_BONUS.twoWayMultiplier;}
  if (input.threadInitiator) {multiplier *= THREAD_BONUS.threadInitiatorMultiplier;}
  if (input.fastReply) {multiplier *= THREAD_BONUS.fastReplyMultiplier;}
  return base * multiplier;
}

export type MeetingScoreInput = {
  ageDays: number;
  attendeeCount: number;
  role: "organizer" | "attendee";
  response: MeetingResponse;
};

export function scoreMeetingInteraction(input: MeetingScoreInput): number {
  return (
    meetingTypeWeight(input.attendeeCount) *
    recencyDecay(input.ageDays) *
    meetingDirectness(input.role, input.response)
  );
}

/** Round to 4 decimal places to keep DB rows readable. */
export function roundScore(score: number): number {
  if (!Number.isFinite(score)) {return 0;}
  return Math.round(score * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// Aggregate recompute (writes to people/company strength fields)
// ---------------------------------------------------------------------------

/**
 * Re-aggregate `Strength Score` on every `people` and `company` row from
 * the current set of `interaction` rows. Idempotent: writes the score in
 * place via DELETE + INSERT into `entry_fields` for the strength field.
 *
 * Apply nightly so recency decay updates without re-ingesting anything.
 */
export async function recomputeAllScores(): Promise<{
  peopleUpdated: number;
  companiesUpdated: number;
}> {
  const dbPath = await duckdbPathAsync();
  if (!dbPath) {
    return { peopleUpdated: 0, companiesUpdated: 0 };
  }

  const interactionPersonRel = "seed_fld_inter_person_000000000";
  const interactionCompanyRel = "seed_fld_inter_company_00000000";
  const interactionScoreFld = "seed_fld_inter_score_0000000000";
  const peopleStrengthFld = "seed_fld_people_strength_000000";
  const companyStrengthFld = "seed_fld_company_strength_00000";

  // 1) Sum interaction.Score Contribution per person
  const peopleRows = await duckdbQueryAsync<{ person_id: string; score: number }>(
    `
WITH person_scores AS (
  SELECT person_ef.value AS person_id,
         COALESCE(SUM(TRY_CAST(score_ef.value AS DOUBLE)), 0) AS score
  FROM entries i
  JOIN entry_fields person_ef
    ON person_ef.entry_id = i.id AND person_ef.field_id = '${interactionPersonRel}'
  LEFT JOIN entry_fields score_ef
    ON score_ef.entry_id = i.id AND score_ef.field_id = '${interactionScoreFld}'
  WHERE i.object_id = '${ONBOARDING_OBJECT_IDS.interaction}'
    AND person_ef.value IS NOT NULL AND person_ef.value <> ''
  GROUP BY person_ef.value
)
SELECT person_id, score FROM person_scores;`,
  );

  // 2) Sum to a per-company score = MAX over the company's people, falling
  // back to direct interaction.company links so companies whose people row
  // doesn't exist yet still get scored.
  const companyRows = await duckdbQueryAsync<{ company_id: string; score: number }>(
    `
WITH company_scores AS (
  SELECT company_ef.value AS company_id,
         COALESCE(SUM(TRY_CAST(score_ef.value AS DOUBLE)), 0) AS score
  FROM entries i
  JOIN entry_fields company_ef
    ON company_ef.entry_id = i.id AND company_ef.field_id = '${interactionCompanyRel}'
  LEFT JOIN entry_fields score_ef
    ON score_ef.entry_id = i.id AND score_ef.field_id = '${interactionScoreFld}'
  WHERE i.object_id = '${ONBOARDING_OBJECT_IDS.interaction}'
    AND company_ef.value IS NOT NULL AND company_ef.value <> ''
  GROUP BY company_ef.value
)
SELECT company_id, score FROM company_scores;`,
  );

  // Write back. We do bulk DELETE then bulk INSERT to keep transactions
  // small; per-row UPDATE would round-trip the duckdb CLI per person.
  if (peopleRows.length > 0) {
    const inList = peopleRows.map((r) => `'${r.person_id.replace(/'/g, "''")}'`).join(", ");
    const insertValues = peopleRows
      .filter((r) => Number.isFinite(r.score))
      .map(
        (r) =>
          `('${randomEntryFieldId()}', '${r.person_id.replace(/'/g, "''")}', '${peopleStrengthFld}', '${roundScore(
            r.score,
          )}')`,
      )
      .join(", ");
    const sql = `
DELETE FROM entry_fields WHERE field_id = '${peopleStrengthFld}' AND entry_id IN (${inList});
${insertValues ? `INSERT INTO entry_fields (id, entry_id, field_id, value) VALUES ${insertValues};` : ""}
`.trim();
    await duckdbExecOnFileAsync(dbPath, sql);
  }

  if (companyRows.length > 0) {
    const inList = companyRows.map((r) => `'${r.company_id.replace(/'/g, "''")}'`).join(", ");
    const insertValues = companyRows
      .filter((r) => Number.isFinite(r.score))
      .map(
        (r) =>
          `('${randomEntryFieldId()}', '${r.company_id.replace(/'/g, "''")}', '${companyStrengthFld}', '${roundScore(
            r.score,
          )}')`,
      )
      .join(", ");
    const sql = `
DELETE FROM entry_fields WHERE field_id = '${companyStrengthFld}' AND entry_id IN (${inList});
${insertValues ? `INSERT INTO entry_fields (id, entry_id, field_id, value) VALUES ${insertValues};` : ""}
`.trim();
    await duckdbExecOnFileAsync(dbPath, sql);
  }

  return { peopleUpdated: peopleRows.length, companiesUpdated: companyRows.length };
}

// ---------------------------------------------------------------------------
// ID helpers
// ---------------------------------------------------------------------------

/** entry_fields.id default is gen_random_uuid(); we mirror that in app code. */
function randomEntryFieldId(): string {
  // duckdb has gen_random_uuid() but our INSERTs are constructed in app code,
  // not via DEFAULT, so we generate one client-side.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}
