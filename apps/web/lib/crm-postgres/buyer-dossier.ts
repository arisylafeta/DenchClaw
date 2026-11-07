import { queryPg, withPgTransaction, type PgTransaction } from "../postgres";
import { mergeDerivedProfile, parseDossier, stableStringify, validateDossier } from "../buyer-dossier";

/** A dated reason the dossier needs a human: intake found new evidence, so the text may be behind. */
export type DossierStaleReason = {
  date: string | null;
  reason: string;
  source_id: string | null;
};

export type SavedSearchAlert = {
  id: string;
  note: string;
  observed_on: string;
  source_kind: string;
  source_ref: string | null;
  source_url: string | null;
};

export type CompanyDossier = {
  company_id: string;
  /** The whole dossier, frontmatter included. */
  text: string | null;
  /** What the panel renders: the Markdown after the frontmatter. */
  body: string | null;
  frontmatter: Record<string, unknown> | null;
  version: number;
  updated_at: string | null;
  stale_since: string | null;
  stale_reasons: DossierStaleReason[];
  /** `last_verified` from the dossier frontmatter: when a person last confirmed the text. */
  last_verified: string | null;
  /** The buyer's own marketplace alerts, recorded by intake as dated context notes. */
  saved_searches: SavedSearchAlert[];
};

export type DossierSaveResult =
  | {
      kind: "saved";
      version: number;
      updated_at: string | null;
      /** The full profile to store and to show: pass-through keys plus the derived ones. */
      profile: Record<string, unknown>;
      derived: string[];
      passedThrough: string[];
      profileChanged: boolean;
    }
  | { kind: "conflict"; currentVersion: number; currentText: string | null }
  | { kind: "invalid"; errors: string[] }
  | { kind: "missing" };

type CompanyRow = {
  buyer_dossier: string | null;
  buyer_dossier_version: number | string;
  buyer_profile: Record<string, unknown> | null;
};

const ISO = (column: string) => `to_char(${column}, 'YYYY-MM-DD')`;

/**
 * Write a dossier: one transaction, the row locked, the version checked, the profile derived.
 *
 * `buyer_profile` and `buyer_dossier` are guarded by trg_crm_companies_guard_buyer_dossier, so the
 * transaction sets `crm.dossier_write = 'on'` for the length of the update and nothing else does.
 * A mismatch on `expectedVersion` returns a conflict and writes nothing; validation errors do the same.
 */
export async function saveDossier(
  companyId: string,
  text: string,
  expectedVersion: number | null = null,
): Promise<DossierSaveResult> {
  const trimmed = (text ?? "").trim();
  // An empty dossier would derive an empty buy box. That is a write-path guard, not a schema rule:
  // an empty frontmatter is valid to the deriver, so a caller clearing the box must say so explicitly.
  if (!trimmed) {return { kind: "invalid", errors: ["Dossier text is empty."] };}

  return withPgTransaction(async (tx: PgTransaction) => {
    const [current] = (
      await tx.query<CompanyRow>(
        `select buyer_dossier, buyer_dossier_version, buyer_profile
         from crm_companies where id = $1 for update`,
        [companyId],
      )
    ).rows;
    if (!current) {return { kind: "missing" } as const;}

    const currentVersion = Number(current.buyer_dossier_version ?? 0);
    if (expectedVersion !== null && Number(expectedVersion) !== currentVersion) {
      return { kind: "conflict", currentVersion, currentText: current.buyer_dossier } as const;
    }

    const { frontmatter } = parseDossier(text);
    const errors = validateDossier(frontmatter);
    if (errors.length) {return { kind: "invalid", errors } as const;}

    const merged = mergeDerivedProfile(current.buyer_profile, frontmatter);
    const profileChanged = stableStringify(current.buyer_profile ?? {}) !== stableStringify(merged.profile);

    await tx.query("select set_config('crm.dossier_write', 'on', true)");
    const [saved] = (
      await tx.query<{ buyer_dossier_version: number | string; buyer_dossier_updated_at: string | null }>(
        `update crm_companies
         set buyer_dossier = $2,
             buyer_dossier_version = buyer_dossier_version + 1,
             buyer_dossier_updated_at = now(),
             buyer_profile = case when $4 then $3::jsonb else buyer_profile end,
             updated_at = now()
         where id = $1
         returning buyer_dossier_version, buyer_dossier_updated_at::text`,
        [companyId, text, JSON.stringify(merged.profile), profileChanged],
      )
    ).rows;

    return {
      kind: "saved",
      version: Number(saved.buyer_dossier_version),
      updated_at: saved.buyer_dossier_updated_at,
      profile: merged.profile,
      derived: merged.derived,
      passedThrough: merged.passedThrough,
      profileChanged,
    } as const;
  });
}

/**
 * "Mark reviewed": the stale flag and its dated reasons are cleared, the text is not touched.
 * The guard trigger only covers buyer_profile and buyer_dossier, so no setting is needed.
 */
export async function markDossierReviewed(companyId: string): Promise<{ ok: boolean }> {
  const rows = await queryPg<{ id: string }>(
    `update crm_companies
     set buyer_dossier_stale_since = null, buyer_dossier_stale_reasons = '[]'::jsonb, updated_at = now()
     where id = $1 and (buyer_dossier_stale_since is not null or buyer_dossier_stale_reasons <> '[]'::jsonb)
     returning id`,
    [companyId],
  );
  return { ok: rows.length > 0 };
}

/** The dossier panel's read: the text, its version, the stale flag and the buyer's saved searches. */
export async function getCompanyDossier(companyId: string): Promise<CompanyDossier | null> {
  const [row] = await queryPg<{
    id: string;
    buyer_dossier: string | null;
    buyer_dossier_version: number | string;
    buyer_dossier_updated_at: string | null;
    stale_since: string | null;
    stale_reasons: DossierStaleReason[] | null;
  }>(
    `select id, buyer_dossier, buyer_dossier_version, buyer_dossier_updated_at::text,
       ${ISO("buyer_dossier_stale_since")} as stale_since,
       buyer_dossier_stale_reasons as stale_reasons
     from crm_companies where id = $1`,
    [companyId],
  );
  if (!row) {return null;}

  const savedSearches = await listSavedSearchAlerts(companyId);
  const parsed = row.buyer_dossier ? parseDossier(row.buyer_dossier) : null;
  const lastVerified = parsed?.frontmatter.last_verified ?? null;
  return {
    company_id: row.id,
    text: row.buyer_dossier,
    body: parsed ? parsed.body : null,
    frontmatter: parsed ? parsed.frontmatter : null,
    version: Number(row.buyer_dossier_version ?? 0),
    updated_at: row.buyer_dossier_updated_at,
    stale_since: row.stale_since,
    stale_reasons: Array.isArray(row.stale_reasons) ? row.stale_reasons : [],
    last_verified: typeof lastVerified === "string" ? lastVerified : null,
    saved_searches: savedSearches,
  };
}

export type DossierToReview = {
  company_id: string;
  name: string;
  stale_since: string;
  reasons: DossierStaleReason[];
  version: number;
};

/**
 * Every company whose dossier intake has flagged since it was last reviewed, oldest flag first: the
 * "Dossiers to review" list on the Trades Preview home. A dossier is only stale once it exists, so
 * companies still on the derived-profile path are not listed.
 */
export async function listDossiersToReview(limit = 50): Promise<DossierToReview[]> {
  return queryPg<DossierToReview>(
    `select id as company_id, name, ${ISO("buyer_dossier_stale_since")} as stale_since,
       buyer_dossier_stale_reasons as reasons, buyer_dossier_version::int as version
     from crm_companies
     where buyer_dossier is not null and buyer_dossier_stale_since is not null
     order by buyer_dossier_stale_since, name
     limit $1`,
    [limit],
  );
}

/** Saved searches intake recorded for the company (category saved_search), newest first. */
export async function listSavedSearchAlerts(companyId: string): Promise<SavedSearchAlert[]> {
  return queryPg<SavedSearchAlert>(
    `select id, note, ${ISO("observed_on")} as observed_on, source_kind, source_ref, source_url
     from crm_company_context_notes
     where company_id = $1 and category = 'saved_search'
     order by observed_on desc, created_at desc, id`,
    [companyId],
  );
}
