import "server-only";
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SupabaseClient } from "@supabase/supabase-js";
import { visibleBody } from "./crm-postgres/whatsapp";
import { getSupabaseAdminClient } from "./platform-admin/supabase";
import { queryPg } from "./postgres";
import { isPersonalDomain } from "./relay-identity";
import { buildPack, callFromNote, callsWith, day, NO_PACK, othersOnThread, sentBy, type Pack, type PackCall, type PackChat, type PackDeal, type PackDismantler, type PackFile, type PackMarket, type PackMessage, type PackNote, type PackParties, type PackPerson } from "./relay-context-core";

const run = promisify(execFile);
const ATTACHMENT_READER = process.env.RELAY_ATTACHMENT_READER || "/root/denchclaw/scripts-live/scripts/rebattery/relay_attachments.py";
// The local copy of Alex's Granola notes, one JSON file per call, refreshed by the daily collection.
const GRANOLA_NOTES = process.env.RELAY_GRANOLA_NOTES || "/root/.local/share/rebattery/granola/raw";
const GRANOLA_RESCAN_MS = 60_000;
const GRANOLA_NOTE_BYTES = 8 << 20;
const MARKET_MS = 4000;
const READ_STATES = "('received','accepted','sent','delivered','opened','clicked','replied')";
const MESSAGE_COLUMNS = `id, rfc_message_id, direction, from_email, coalesce(to_emails,'{}') as to_emails, subject, left(body_text, 6000) as body_text,
  coalesce(sent_at, accepted_at, created_at)::text as at, (coalesce(purpose, '') in ('marketing','transactional') or campaign_id is not null) as automated`;

/** A thread message as the pack needs it. has_files: it may carry a real attachment (not only signature images). */
export type PackThreadMessage = PackParties & { id: string; rfc_message_id: string | null; direction: string; at: string; has_files: boolean };

/** SQL for has_files on mail_message: flagged as having attachments, and no stored list says they are all inline images. */
export const HAS_FILES_SQL = `(coalesce(has_attachments, false) and case when jsonb_typeof(personalization->'attachments') = 'array'
  then exists (select 1 from jsonb_array_elements(personalization->'attachments') a where a->>'inline' is distinct from 'true' and coalesce(a->>'filename', '') <> '')
  else true end)`;

const quiet = <T>(rows: Promise<T[]>) => rows.catch(() => [] as T[]);

/** The text of the files on the thread's newest messages, from relay_attachments.py (read-only Gmail), and whether it
 * missed any. Null when it failed. The reader stops itself inside a minute; the timeout here is the backstop. */
export async function threadFiles(messages: PackThreadMessage[]): Promise<{ files: PackFile[]; missed: boolean } | null> {
  const withFiles = messages.filter((m) => m.has_files).slice(0, 6);
  if (!withFiles.length) return { files: [], missed: false };
  try {
    const { stdout } = await run("/usr/bin/python3", [ATTACHMENT_READER, ...withFiles.map((m) => m.id)], { timeout: 75_000, maxBuffer: 8 << 20 });
    const answer = JSON.parse(stdout) as { files?: PackFile[]; missed?: boolean };
    if (!Array.isArray(answer.files)) return null;
    const byId = new Map(withFiles.map((m) => [m.id, m]));
    const files = answer.files.filter((f) => f && typeof f.filename === "string").map((f) => {
      const m = byId.get(f.message_id ?? "");
      return { ...f, sent: m ? `sent by ${sentBy(m)} on ${day(m.at)}` : undefined };
    });
    return { files, missed: answer.missed === true };
  } catch {
    return null;
  }
}

const granolaNotes = new Map<string, { stamp: string; call: PackCall | null }>();
let calls: PackCall[] = [];
let callsReadAt = 0;
let callsReading: Promise<PackCall[]> | null = null;

async function readCalls(): Promise<PackCall[]> {
  const names = (await readdir(GRANOLA_NOTES)).filter((name) => name.endsWith(".json"));
  const present = new Set(names);
  for (const name of granolaNotes.keys()) if (!present.has(name)) granolaNotes.delete(name);
  for (const name of names) {
    try {
      const path = join(GRANOLA_NOTES, name);
      const info = await stat(path);
      const stamp = `${info.mtimeMs}:${info.size}`;
      if (granolaNotes.get(name)?.stamp === stamp) continue;
      granolaNotes.set(name, { stamp, call: info.size > GRANOLA_NOTE_BYTES ? null : callFromNote(JSON.parse(await readFile(path, "utf8"))) });
    } catch { /* a note being rewritten is read on the next pass */ }
  }
  return [...granolaNotes.values()].flatMap((note) => (note.call ? [note.call] : []));
}

/** Every call with someone from outside, from the local Granola copy. Only a changed note is read again, and the folder
 * is looked at once a minute at most. Empty when the folder can't be read. */
async function granolaCalls(): Promise<PackCall[]> {
  if (Date.now() - callsReadAt < GRANOLA_RESCAN_MS) return calls;
  callsReading ??= readCalls().then((found) => { calls = found; callsReadAt = Date.now(); return found; }).catch(() => calls).finally(() => { callsReading = null; });
  return callsReading;
}

/** WhatsApp messages of the last 60 days in the direct chats linked to a CRM person with this address. Group chats never count. */
const whatsappWith = (counterpart: string) => quiet(queryPg<PackChat>(
  `select m.direction, coalesce(m.occurred_at, m.captured_at)::text as at, left(${visibleBody("m")}, 600) as body, m.attachment->>'type' as attachment
   from whatsapp_message m join whatsapp_thread t on t.id = m.thread_id
   where t.kind = 'direct' and m.deleted_at is null and coalesce(m.occurred_at, m.captured_at) > now() - interval '60 days'
     and exists (select 1 from whatsapp_identity_link l join crm_people p on p.id = l.person_id
       where l.account_id = t.account_id and l.identity_id = t.identity_id and l.valid_to is null and lower(p.email) = $1)
   order by coalesce(m.occurred_at, m.captured_at) desc limit 40`, [counterpart]));

type Answer<T> = PromiseLike<{ data: T[] | null; error: unknown }>;

/** The marketplace account under this address, read live (the CRM's copy of sign-ups can lag). Null when the read failed
 * or ran out of time: then nothing is said, rather than "no account". */
async function marketplace(counterpart: string): Promise<PackMarket | null> {
  try {
    // "*" is a wildcard to the API and can't be escaped: such an address is not looked up, and nothing is said.
    if (counterpart.includes("*")) return null;
    const db = getSupabaseAdminClient() as unknown as SupabaseClient;
    const signal = AbortSignal.timeout(MARKET_MS);
    const rows = async <T>(answer: Answer<T>) => {
      const { data, error } = await answer;
      if (error) throw error;
      return data ?? [];
    };
    const found = await rows<{ id: string; email: string; created_at: string }>(
      db.from("users").select("id,email,created_at").ilike("email", counterpart.replace(/[\\%_]/g, "\\$&")).order("created_at").limit(5).abortSignal(signal));
    // ilike has its own wildcards; only an exact address counts.
    const users = found.filter((u) => u.email.toLowerCase().trim() === counterpart);
    if (!users.length) return { registered: false, accounts: [] };
    const members = await rows<{ account_id: string }>(db.from("account_memberships").select("account_id").in("user_id", users.map((u) => u.id)).limit(6).abortSignal(signal));
    const ids = [...new Set(members.map((m) => m.account_id))].slice(0, 3);
    if (!ids.length) return { registered: true, signedUp: users[0].created_at, accounts: [] };
    const [accounts, deals] = await Promise.all([
      rows<{ id: string; name: string; role: string; status: string; account_type: string | null; created_at: string }>(
        db.from("accounts").select("id,name,role,status,account_type,created_at").in("id", ids).abortSignal(signal)),
      rows<{ status: string; supplier_account_id: string; counterparty_account_id: string }>(
        db.from("deals").select("status,supplier_account_id,counterparty_account_id").or(`supplier_account_id.in.(${ids.join(",")}),counterparty_account_id.in.(${ids.join(",")})`).limit(1000).abortSignal(signal)),
    ]);
    return {
      registered: true, signedUp: users[0].created_at,
      accounts: await Promise.all(accounts.map(async (a) => {
        // The newest few listings with the true total, and the number of offers, for each account.
        const [listings, offers] = await Promise.all([
          db.from("listings").select("title,listing_status,reference,created_at", { count: "exact" }).eq("supplier_account_id", a.id).order("created_at", { ascending: false }).limit(5).abortSignal(signal),
          db.from("purchase_offers").select("buyer_account_id", { count: "exact", head: true }).eq("buyer_account_id", a.id).abortSignal(signal),
        ]);
        if (listings.error || offers.error) throw listings.error ?? offers.error;
        const newest = (listings.data ?? []) as { title: string; listing_status: string; reference: string | null; created_at: string }[];
        const counts: Record<string, number> = {};
        for (const d of deals) if (d.supplier_account_id === a.id || d.counterparty_account_id === a.id) counts[d.status] = (counts[d.status] ?? 0) + 1;
        return { name: a.name, role: a.role, status: a.status, kind: a.account_type, since: a.created_at, listingCount: listings.count ?? newest.length,
          listings: newest.map((l) => ({ title: l.title, status: l.listing_status, reference: l.reference, at: l.created_at })), deals: counts, offers: offers.count ?? 0 };
      })),
    };
  } catch {
    return null;
  }
}

/**
 * Everything Relay looks up for a draft beyond the thread and the linked deal. Read-only, and it never fails a draft:
 * a part that cannot be read is left out. messages are the thread's shown messages, newest first.
 */
export async function contextPack(counterpartEmail: string | null, messages: PackThreadMessage[], linkedDealId: string | null): Promise<Pack> {
  try {
    const counterpart = (counterpartEmail ?? "").toLowerCase().trim();
    const host = counterpart.split("@")[1] ?? "";
    // A colleague's thread has no outside person to look up; its attachments still count.
    const outside = !!host && host !== "rebattery.io";
    const filesReady = threadFiles(messages);
    if (!outside) {
      const found = await filesReady;
      return buildPack({ counterpart, domain: null, shown: messages, withPerson: [], withCompany: [], person: null, company: null, notes: [], dismantler: null, deals: [], files: found?.files ?? null, filesMissed: found?.missed });
    }

    // Mail from, to or copied to an address that passes the test.
    const addressed = (test: (address: string) => string) => `(${test("lower(from_email)")} or exists (select 1 from unnest(coalesce(to_emails,'{}') || coalesce(cc_emails,'{}')) a where ${test("lower(a)")}))`;
    const isThem = addressed((address) => `${address} = $1`);
    const calling = granolaCalls();
    const chats = whatsappWith(counterpart);
    const market = marketplace(counterpart);
    const withPerson = quiet(queryPg<PackMessage>(
      `select ${MESSAGE_COLUMNS} from mail_message where state in ${READ_STATES} and ${isThem}
       order by coalesce(sent_at, accepted_at, created_at) desc limit 60`, [counterpart]));
    const companyHost = isPersonalDomain(host) ? null : host;
    const [[person], owners] = await Promise.all([
      quiet(queryPg<PackPerson & { company_id: string | null }>(
        "select full_name, job_title, notes, tags, company_id from crm_people where lower(email) = $1 order by (company_id is not null) desc, updated_at desc limit 1", [counterpart])),
      companyHost ? quiet(queryPg<{ id: string }>("select id from crm_companies where lower(domain) in ($1, 'www.' || $1) limit 2", [companyHost])) : [],
    ]);
    // A mail domain stands for one company only when the CRM has a company on it. Others (abv.bg, members.ebay.co.uk, a
    // mail relay) are shared by strangers, so nothing is looked up by domain for them.
    const domain = owners.length ? companyHost : null;
    const withCompany = domain ? quiet(queryPg<PackMessage>(
      `select ${MESSAGE_COLUMNS} from mail_message where state in ${READ_STATES} and ${addressed((address) => `split_part(${address}, '@', 2) = $2`)} and not ${isThem}
       order by coalesce(sent_at, accepted_at, created_at) desc limit 30`, [counterpart, domain])) : Promise.resolve([]);
    // Their company: the one on their CRM person, else the one company on their mail domain (two rows on a domain: unclear which).
    const companyId = person?.company_id ?? (owners.length === 1 ? owners[0].id : null);
    const [company] = companyId ? await quiet(queryPg<Record<string, unknown> & { id: string }>(
      `select id, name, city, country, about, segment, roles, purpose, specialisms, relationship_stage, buyer_stage, buyer_tier, notes, buyer_outreach_notes, buyer_past_issues,
         buyer_collection, buyer_projects, buyer_next_step, buyer_profile, buyer_dossier
       from crm_companies where id = $1`, [companyId])) : [];
    const [notes, dismantlers, deals] = await Promise.all([
      company ? quiet(queryPg<PackNote>("select note, category, source_kind, observed_on::text from crm_company_context_notes where company_id = $1 order by coalesce(observed_on, created_at::date) desc limit 6", [company.id])) : [],
      company ? quiet(queryPg<PackDismantler>("select stage, stock_phase, next_step, next_step_due::text, park_reason, notes from crm_dismantlers where company_id = $1 order by updated_at desc limit 1", [company.id])) : [],
      // Deals that are theirs: their address, their company's domain or their CRM company. Open ones first; closed ones only from the last year.
      quiet(queryPg<PackDeal>(
        `select b.kind, coalesce(b.context->>'listing_title', b.spec->>'listing_title') as title, b.summary, b.quantity, b.location, b.status, b.closed_reason, b.observed_on::text
         from crm_bulk_listings b left join crm_people p on p.id = b.person_id
         where b.id <> $4 and (lower(coalesce(b.email, p.email)) = $1 or ($2 <> '' and split_part(lower(coalesce(b.email, p.email)), '@', 2) = $2) or ($3 <> '' and b.company_id = $3))
           and (b.status in ('open','qualifying') or coalesce(b.observed_on, b.created_at::date) > current_date - 365)
         order by (b.status in ('open','qualifying')) desc, coalesce(b.observed_on, b.created_at::date) desc limit 5`, [counterpart, domain ?? "", company?.id ?? "", linkedDealId ?? ""])),
    ]);
    const found = await filesReady;
    const called = callsWith(await calling, counterpart, domain);
    return buildPack({ counterpart, domain, shown: messages, withPerson: await withPerson, withCompany: await withCompany, person: person ?? null, company: company ?? null,
      notes, dismantler: dismantlers[0] ?? null, deals, files: found?.files ?? null, filesMissed: found?.missed, others: othersOnThread(counterpart, companyHost, messages),
      calls: called.person, companyCalls: called.company, chats: await chats, market: await market, lastShownAt: messages[0]?.at ?? null });
  } catch {
    return NO_PACK;
  }
}
