import "server-only";

// Reads what ReBattery knows about each dismantler: its supplier account, listings and sales.
// Read only. Accounts and their members' emails are cached for five minutes; listings and sales
// are read fresh for the matched accounts only.
import { getSupabaseAdminClient } from "./platform-admin/supabase";
import { readAllRows, readAllRowsInBatches } from "./platform-admin/queries";
import { effectiveStage, platformStageSince, type Dismantler, type PlatformFacts } from "./dismantlers";
import { matchAccounts, type AccountForMatch } from "./dismantlers-match";
import { listMatchInputs, type DismantlerRow } from "./crm-postgres/dismantlers";

type SupplierAccount = AccountForMatch & { created_at: string };

const CACHE_MS = 5 * 60_000;
let cache: { at: number; accounts: Promise<SupplierAccount[]> } | null = null;

async function readSupplierAccounts(): Promise<SupplierAccount[]> {
  const supabase = getSupabaseAdminClient();
  const accounts = await readAllRows<{ id: string; name: string; created_at: string }>((from, to) =>
    supabase.from("accounts").select("id, name, created_at").eq("role", "supplier").order("created_at").range(from, to));
  const ids = accounts.map((account) => account.id);
  const memberships = await readAllRowsInBatches<{ account_id: string; user_id: string }>(ids, (batch, from, to) =>
    supabase.from("account_memberships").select("account_id, user_id").in("account_id", batch).order("id").range(from, to));
  const users = await readAllRowsInBatches<{ id: string; email: string }>(memberships.map((m) => m.user_id), (batch, from, to) =>
    supabase.from("users").select("id, email").in("id", batch).order("id").range(from, to));
  const email = new Map(users.map((user) => [user.id, user.email]));
  return accounts.map((account) => ({
    ...account,
    emails: memberships.filter((m) => m.account_id === account.id).map((m) => email.get(m.user_id)).filter((e): e is string => !!e),
  }));
}

/** Supplier accounts with their members' emails, from the cache when fresh. */
export function supplierAccounts(): Promise<SupplierAccount[]> {
  if (!cache || Date.now() - cache.at > CACHE_MS) {
    const accounts = readSupplierAccounts();
    cache = { at: Date.now(), accounts };
    // A failed read is not cached, so the next request tries again.
    accounts.catch(() => { if (cache?.accounts === accounts) cache = null; });
  }
  return cache.accounts;
}

type Activity = { listed: number; listed_ever: number; sold: number; first_listed_on: string | null; last_listed_on: string | null };

async function readActivity(accountIds: string[]): Promise<Map<string, Activity>> {
  const supabase = getSupabaseAdminClient();
  const [listings, deals] = await Promise.all([
    readAllRowsInBatches<{ supplier_account_id: string; listing_status: string; created_at: string }>(accountIds, (batch, from, to) =>
      supabase.from("listings").select("supplier_account_id, listing_status, created_at").in("supplier_account_id", batch).order("id").range(from, to)),
    readAllRowsInBatches<{ supplier_account_id: string }>(accountIds, (batch, from, to) =>
      supabase.from("deals").select("supplier_account_id").eq("status", "completed").in("supplier_account_id", batch).order("id").range(from, to)),
  ]);
  const activity = new Map<string, Activity>(accountIds.map((id) => [id, { listed: 0, listed_ever: 0, sold: 0, first_listed_on: null, last_listed_on: null }]));
  for (const listing of listings) {
    const entry = activity.get(listing.supplier_account_id);
    // A draft was never on show, so it proves nothing.
    if (!entry || listing.listing_status === "draft") continue;
    entry.listed_ever += 1;
    if (listing.listing_status === "published") entry.listed += 1;
    const day = listing.created_at.slice(0, 10);
    if (!entry.last_listed_on || day > entry.last_listed_on) entry.last_listed_on = day;
    if (!entry.first_listed_on || day < entry.first_listed_on) entry.first_listed_on = day;
  }
  for (const deal of deals) {
    const entry = activity.get(deal.supplier_account_id);
    if (entry) entry.sold += 1;
  }
  return activity;
}

/** The stage shown, without ReBattery: what was saved. */
export function withoutPlatform(row: DismantlerRow): Dismantler {
  const { match_emails: _emails, match_domain: _domain, ...rest } = row;
  return { ...rest, saved_stage: row.stage, platform: null };
}

/** One dismantler with its ReBattery facts. */
export async function withPlatformOne(row: DismantlerRow): Promise<Dismantler> {
  return (await withPlatform([row])).dismantlers[0];
}

/**
 * Adds ReBattery facts to each dismantler and lifts its stage when they prove more. When
 * ReBattery cannot be read, stages stay as saved and the error says why.
 */
export async function withPlatform(rows: DismantlerRow[]): Promise<{ dismantlers: Dismantler[]; platform_error: string | null }> {
  try {
    // Match across every dismantler, not just these rows, so an account two could claim goes to neither.
    const [accounts, everyone] = await Promise.all([supplierAccounts(), listMatchInputs()]);
    const inputs = new Map(everyone.map((row) => [row.id, row]));
    for (const row of rows) inputs.set(row.id, row);
    const matches = matchAccounts(
      [...inputs.values()].map((row) => ({ id: row.id, platform_account_id: row.platform_account_id, emails: row.match_emails ?? [], domain: row.match_domain })),
      accounts,
    );
    const wanted = new Set(rows.map((row) => row.id));
    const matched = [...new Set([...matches].filter(([id]) => wanted.has(id)).map(([, match]) => match.account.id))];
    const activity = matched.length ? await readActivity(matched) : new Map<string, Activity>();
    const created = new Map(accounts.map((account) => [account.id, account.created_at.slice(0, 10)]));
    const dismantlers = rows.map((row) => {
      const base = withoutPlatform(row);
      const match = matches.get(row.id);
      if (!match) return base;
      const platform: PlatformFacts = {
        account_id: match.account.id,
        account_name: match.account.name,
        matched_by: match.matched_by,
        signed_up_on: created.get(match.account.id) ?? "",
        ...(activity.get(match.account.id) ?? { listed: 0, listed_ever: 0, sold: 0, first_listed_on: null, last_listed_on: null }),
      };
      const stage = effectiveStage(row.stage, platform);
      return stage === row.stage ? { ...base, platform } : { ...base, platform, stage, stage_since: platformStageSince(stage, platform) };
    });
    return { dismantlers, platform_error: null };
  } catch (err) {
    console.error("[dismantlers] ReBattery read failed", err);
    return { dismantlers: rows.map(withoutPlatform), platform_error: "Could not read ReBattery just now, so stages show as saved." };
  }
}
