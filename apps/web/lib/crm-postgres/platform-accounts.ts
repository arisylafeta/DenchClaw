import { queryPg } from "../postgres";

export type PlatformAccountReviewStatus = "auto" | "needs_review" | "confirmed" | "rejected";
export type PlatformAccount = {
  auth_user_id: string;
  person_id: string | null;
  account_id: string | null;
  account_role: string | null;
  account_status: string | null;
  email: string | null;
  match_method: "email_exact" | "manual" | "unmatched";
  review_status: PlatformAccountReviewStatus;
  auth_created_at: string | null;
  last_sign_in_at: string | null;
  linked_at: string;
  updated_at: string;
};

const REVIEW_STATUSES: Record<string, true> = { auto: true, needs_review: true, confirmed: true, rejected: true };

function assertReviewStatus(status: string): asserts status is PlatformAccountReviewStatus {
  if (!Object.hasOwn(REVIEW_STATUSES, status)) throw new Error("Invalid platform account review status");
}

/** CRM-internal only: includes email. Callers must enforce authentication. */
export async function listPlatformAccounts(params: {
  reviewStatus?: PlatformAccountReviewStatus;
  role?: string;
  q?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{ rows: PlatformAccount[]; total: number }> {
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(offset) || offset < 0) {
    throw new Error("Invalid platform account pagination");
  }
  if (params.reviewStatus) assertReviewStatus(params.reviewStatus);
  const values: unknown[] = [];
  const filters: string[] = [];
  if (params.reviewStatus) {
    values.push(params.reviewStatus);
    filters.push(`review_status = $${values.length}`);
  }
  if (params.role) {
    values.push(params.role);
    filters.push(`account_role = $${values.length}`);
  }
  if (params.q?.trim()) {
    // Literal substring search: wildcard characters supplied by the user are not operators.
    values.push(`%${params.q.trim().replace(/[\\%_]/g, "\\$&")}%`);
    filters.push(`email ilike $${values.length}`);
  }
  const where = filters.length ? `where ${filters.join(" and ")}` : "";
  const totals = await queryPg<{ total: string }>(
    `select count(*)::text as total from crm_platform_accounts ${where}`, values,
  );
  const rows = await queryPg<PlatformAccount>(
    `select * from crm_platform_accounts ${where}
     order by updated_at desc, auth_user_id
     limit $${values.length + 1} offset $${values.length + 2}`,
    [...values, limit, offset],
  );
  return { rows, total: Number(totals[0]?.total ?? 0) };
}

export async function getPlatformAccount(authUserId: string): Promise<PlatformAccount | null> {
  const rows = await queryPg<PlatformAccount>(
    "select * from crm_platform_accounts where auth_user_id = $1::uuid", [authUserId],
  );
  return rows[0] ?? null;
}

export async function updatePlatformAccountReviewStatus(
  authUserId: string, reviewStatus: PlatformAccountReviewStatus,
): Promise<PlatformAccount | null> {
  assertReviewStatus(reviewStatus);
  const rows = await queryPg<PlatformAccount>(
    `update crm_platform_accounts set review_status = $2, updated_at = now()
     where auth_user_id = $1::uuid
       and ($2 <> 'confirmed' or person_id is not null)
     returning *`, [authUserId, reviewStatus],
  );
  return rows[0] ?? null;
}

/** FK validation rejects nonexistent people. Manual links remain protected on subsequent syncs. */
export async function linkPlatformAccount(
  authUserId: string, personId: string,
): Promise<PlatformAccount | null> {
  if (!personId.trim()) throw new Error("A CRM person is required");
  const rows = await queryPg<PlatformAccount>(
    `update crm_platform_accounts set person_id = $2, match_method = 'manual',
       review_status = 'confirmed', linked_at = now(), updated_at = now()
     where auth_user_id = $1::uuid returning *`, [authUserId, personId],
  );
  return rows[0] ?? null;
}

/** Explicit rejection prevents the email matcher from restoring an unwanted link. */
export async function unlinkPlatformAccount(authUserId: string): Promise<PlatformAccount | null> {
  const rows = await queryPg<PlatformAccount>(
    `update crm_platform_accounts set person_id = null, match_method = 'manual',
       review_status = 'rejected', updated_at = now()
     where auth_user_id = $1::uuid returning *`, [authUserId],
  );
  return rows[0] ?? null;
}
