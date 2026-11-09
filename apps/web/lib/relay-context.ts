import "server-only";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { queryPg } from "./postgres";
import { isPersonalDomain } from "./relay-identity";
import { buildPack, day, NO_PACK, othersOnThread, sentBy, type Pack, type PackDeal, type PackDismantler, type PackFile, type PackMessage, type PackNote, type PackParties, type PackPerson } from "./relay-context-core";

const run = promisify(execFile);
const ATTACHMENT_READER = process.env.RELAY_ATTACHMENT_READER || "/root/denchclaw/scripts-live/scripts/rebattery/relay_attachments.py";
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
async function threadFiles(messages: PackThreadMessage[]): Promise<{ files: PackFile[]; missed: boolean } | null> {
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
    return buildPack({ counterpart, domain, shown: messages, withPerson: await withPerson, withCompany: await withCompany, person: person ?? null, company: company ?? null,
      notes, dismantler: dismantlers[0] ?? null, deals, files: found?.files ?? null, filesMissed: found?.missed, others: othersOnThread(counterpart, companyHost, messages) });
  } catch {
    return NO_PACK;
  }
}
