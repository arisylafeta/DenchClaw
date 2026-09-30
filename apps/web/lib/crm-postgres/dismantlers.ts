import { randomUUID } from "node:crypto";
import { pgPool, queryPg, withPgTransaction, type PgTransaction } from "../postgres";
import { todayInLondon, type TradeOwner } from "../bulk-trades";
import type { Dismantler, DismantlerPatch, ImportRow, Stage } from "../dismantlers";

/** A dismantler as saved, plus what the ReBattery match needs (never sent to the browser). */
export type DismantlerRow = Omit<Dismantler, "saved_stage" | "platform"> & {
  match_emails: string[] | null;
  match_domain: string | null;
};

type Queryable = Pick<PgTransaction, "query">;

const COLUMNS = `
  d.id, d.company_id, company.name, d.stage, to_char(d.stage_since, 'YYYY-MM-DD') as stage_since,
  d.parked_from, d.park_reason, to_char(d.revisit_on, 'YYYY-MM-DD') as revisit_on,
  d.next_step, to_char(d.next_step_due, 'YYYY-MM-DD') as next_step_due, d.next_step_person_id,
  coalesce(nullif(person.full_name, ''), nullif(concat_ws(' ', person.first_name, person.last_name), ''), person.email) as next_step_person_name,
  d.owner_user_id, owner.display_name as owner_name, d.goal, d.country, d.ebay_username,
  d.ebay_listings, d.platform_account_id, d.source, d.notes,
  coalesce(nullif(company.domain, ''), company.website) as match_domain,
  (select array_agg(distinct lower(p.email)) from crm_people p
    where p.company_id = d.company_id and p.email like '%@%') as match_emails,
  -- Latest email or meeting with anyone at the company, as the CRM sync keeps it on each person.
  (select to_char(max(p.last_interaction_at) at time zone 'Europe/London', 'YYYY-MM-DD')
     from crm_people p where p.company_id = d.company_id) as last_contact,
  d.updated_at`;

const FROM = `
  crm_dismantlers d
  join crm_companies company on company.id = d.company_id
  left join crm_users owner on owner.id = d.owner_user_id
  left join crm_people person on person.id = d.next_step_person_id`;

const select = (where: string) => `select ${COLUMNS} from ${FROM} ${where}`;

export async function listDismantlers(): Promise<{ dismantlers: DismantlerRow[]; owners: TradeOwner[] }> {
  const [dismantlers, owners] = await Promise.all([
    queryPg<DismantlerRow>(select("order by company.name")),
    queryPg<TradeOwner>("select id, display_name as name from crm_users where is_active order by display_name"),
  ]);
  return { dismantlers, owners };
}

/** What the ReBattery match needs for every dismantler, so one account is never given to two. */
export async function listMatchInputs(): Promise<Array<Pick<DismantlerRow, "id" | "platform_account_id" | "match_emails" | "match_domain">>> {
  return queryPg(
    `select d.id, d.platform_account_id, coalesce(nullif(company.domain, ''), company.website) as match_domain,
            (select array_agg(distinct lower(p.email)) from crm_people p
              where p.company_id = d.company_id and p.email like '%@%') as match_emails
       from crm_dismantlers d join crm_companies company on company.id = d.company_id`,
  );
}

async function readOne(client: Queryable, id: string): Promise<DismantlerRow | null> {
  const { rows } = await client.query(select("where d.id = $1"), [id]);
  return (rows[0] as DismantlerRow | undefined) ?? null;
}

export async function getDismantler(id: string): Promise<DismantlerRow | null> {
  return readOne(pgPool, id);
}

export type CompanyPerson = { id: string; name: string; email: string | null; job_title: string | null };
export type Activity =
  | { kind: "email"; at: string; subject: string | null; from: string | null; outgoing: boolean }
  | { kind: "event"; at: string; event: string; changes: Record<string, unknown>; actor: string | null };

export type DismantlerDetail = { dismantler: Dismantler; people: CompanyPerson[]; activity: Activity[]; platform_error?: string | null };
type DetailRow = Omit<DismantlerDetail, "dismantler"> & { dismantler: DismantlerRow };

export async function getDismantlerDetail(id: string, viewerId: string): Promise<DetailRow | null> {
  const dismantler = await getDismantler(id);
  if (!dismantler) return null;
  const [people, emails, events] = await Promise.all([
    queryPg<CompanyPerson>(
      `select id, coalesce(nullif(full_name, ''), nullif(concat_ws(' ', first_name, last_name), ''), email, id) as name,
              email, job_title
         from crm_people where company_id = $1
        order by last_interaction_at desc nulls last, name limit 25`,
      [dismantler.company_id],
    ),
    queryPg<{ at: string; subject: string | null; from: string | null; outgoing: boolean }>(
      `select m.sent_at as at, m.subject, m.from_email as from,
              not exists (select 1 from crm_people p where p.id = m.from_person_id and p.company_id = $2) as outgoing
         from crm_email_messages m
        where m.mailbox_owner_id = $1::uuid
          and exists (
            select 1 from crm_people p
             where p.company_id = $2
               and (p.id = m.from_person_id
                 or exists (select 1 from crm_email_message_recipients r where r.message_id = m.id and r.person_id = p.id)))
        order by m.sent_at desc nulls last limit 20`,
      [viewerId, dismantler.company_id],
    ),
    queryPg<{ at: string; event: string; changes: Record<string, unknown>; actor: string | null }>(
      `select e.created_at as at, e.kind as event, e.changes, u.display_name as actor
         from crm_dismantler_events e left join crm_users u on u.id = e.actor_user_id
        where e.dismantler_id = $1
          -- A Gmail draft is private to the person who made it.
          and (e.kind <> 'email_draft' or e.actor_user_id = $2::uuid)
        order by e.id desc limit 40`,
      [id, viewerId],
    ),
  ]);
  const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value));
  const activity: Activity[] = [
    ...emails.map((email) => ({ kind: "email" as const, ...email, at: iso(email.at) })),
    ...events.map((event) => ({ kind: "event" as const, ...event, at: iso(event.at) })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  return { dismantler, people, activity };
}

async function logEvent(client: Queryable, id: string, kind: string, changes: object, userId: string | null) {
  await client.query(
    "insert into crm_dismantler_events (dismantler_id, kind, changes, actor_user_id) values ($1, $2, $3, $4)",
    [id, kind, JSON.stringify(changes), userId],
  );
}

async function tagCompany(client: Queryable, companyId: string) {
  await client.query(
    `update crm_companies set tags = array_append(coalesce(tags, '{}'), 'dismantler'), updated_at = now()
      where id = $1 and not ('dismantler' = any(coalesce(tags, '{}')))`,
    [companyId],
  );
}

export class DismantlerError extends Error {}

/**
 * The CRM company for a new dismantler: the one picked, else the one company with this exact
 * name, else a new company. Refuses a name several companies share, and a company that is
 * already a dismantler.
 */
async function resolveCompany(client: Queryable, input: { company_id?: string | null; name?: string | null }): Promise<string> {
  let companyId = input.company_id ?? null;
  if (companyId) {
    const { rows } = await client.query("select 1 from crm_companies where id = $1", [companyId]);
    if (!rows.length) throw new DismantlerError("That CRM company no longer exists.");
  } else {
    const name = input.name?.trim();
    if (!name) throw new DismantlerError("Pick a company or type a name.");
    // Serialises adds of the same name, so two at once cannot both create the company.
    await client.query("select pg_advisory_xact_lock(hashtext('crm_dismantlers:' || lower($1)))", [name]);
    const { rows } = await client.query("select id from crm_companies where lower(btrim(name)) = lower($1)", [name]);
    if (rows.length > 1) throw new DismantlerError(`Several CRM companies are called "${name}". Pick one from the list.`);
    companyId = (rows[0]?.id as string | undefined) ?? null;
    if (!companyId) {
      companyId = randomUUID();
      await client.query("insert into crm_companies (id, name) values ($1, $2)", [companyId, name]);
    }
  }
  const { rows } = await client.query("select id from crm_dismantlers where company_id = $1", [companyId]);
  if (rows.length) throw Object.assign(new DismantlerError("This company is already a dismantler."), { existingId: rows[0].id as string });
  return companyId;
}

// Column names come only from validated DismantlerPatch keys.
function assignments(fields: Record<string, unknown>, firstParam: number) {
  const keys = Object.keys(fields);
  return {
    sql: keys.map((key, index) => `${key} = $${firstParam + index}`).join(", "),
    values: keys.map((key) => fields[key]),
  };
}

async function insertDismantler(
  client: Queryable,
  companyId: string,
  patch: DismantlerPatch,
  userId: string,
  kind = "created",
): Promise<string> {
  const id = `dm_${randomUUID()}`;
  const fields: Record<string, unknown> = { ...patch };
  const keys = Object.keys(fields);
  await client.query(
    `insert into crm_dismantlers (id, company_id, stage_since${keys.map((key) => `, ${key}`).join("")})
     values ($1, $2, $3${keys.map((_, index) => `, $${index + 4}`).join("")})`,
    [id, companyId, todayInLondon(), ...keys.map((key) => fields[key])],
  );
  await tagCompany(client, companyId);
  await logEvent(client, id, kind, fields, userId);
  return id;
}

export async function createDismantler(
  input: { company_id?: string | null; name?: string | null; patch: DismantlerPatch },
  userId: string,
): Promise<DismantlerRow> {
  return withPgTransaction(async (client) => {
    const companyId = await resolveCompany(client, input);
    await assertPersonAtCompany(client, input.patch.next_step_person_id, companyId);
    const id = await insertDismantler(client, companyId, input.patch, userId);
    return (await readOne(client, id))!;
  });
}

async function assertPersonAtCompany(client: Queryable, personId: string | null | undefined, companyId: string) {
  if (!personId) return;
  const { rows } = await client.query("select 1 from crm_people where id = $1 and company_id = $2", [personId, companyId]);
  if (!rows.length) throw new DismantlerError("That person is not at this company in the CRM.");
}

async function applyPatch(client: Queryable, before: DismantlerRow, patch: DismantlerPatch, userId: string, kind = "updated") {
  const today = todayInLondon();
  await assertPersonAtCompany(client, patch.next_step_person_id, before.company_id);
  const fields: Record<string, unknown> = {};
  const changes: Record<string, [unknown, unknown]> = {};
  for (const [key, value] of Object.entries(patch)) {
    const old = before[key as keyof DismantlerRow] ?? null;
    if (old !== value) {
      fields[key] = value;
      changes[key] = [old, value];
    }
  }
  if ("stage" in fields) {
    fields.stage_since = today;
    if (fields.stage === "Parked") {
      fields.parked_from = before.stage === "Parked" ? before.parked_from : before.stage;
    } else if (before.stage === "Parked") {
      Object.assign(fields, { parked_from: null, park_reason: null, revisit_on: null });
    }
  }
  if (!Object.keys(changes).length) return;

  const set = assignments(fields, 2);
  await client.query(`update crm_dismantlers set ${set.sql}, updated_at = now() where id = $1`, [before.id, ...set.values]);
  await logEvent(client, before.id, kind, changes, userId);
}

export async function updateDismantler(id: string, patch: DismantlerPatch, userId: string): Promise<DismantlerRow | null> {
  return withPgTransaction(async (client) => {
    await client.query("select 1 from crm_dismantlers where id = $1 for update", [id]);
    const before = await readOne(client, id);
    if (!before) return null;
    await applyPatch(client, before, patch, userId);
    return readOne(client, id);
  });
}

/**
 * Start outreach on a batch: each moves to Talking with a follow-up step.
 * Dismantlers already past Found keep their stage and only get the follow-up.
 */
export async function startOutreach(
  ids: string[],
  followUp: { next_step: string; next_step_due: string },
  userId: string,
): Promise<DismantlerRow[]> {
  return withPgTransaction(async (client) => {
    const saved: DismantlerRow[] = [];
    for (const id of ids) {
      await client.query("select 1 from crm_dismantlers where id = $1 for update", [id]);
      const before = await readOne(client, id);
      if (!before) throw new DismantlerError("A dismantler in this batch no longer exists. Refresh and try again.");
      const stage: Stage = before.stage === "Found" || before.stage === "Parked" ? "Talking" : before.stage;
      await applyPatch(client, before, { stage, ...followUp }, userId, "outreach");
      saved.push((await readOne(client, id))!);
    }
    return saved;
  });
}

export type ImportPlan = { name: string; action: "new company" | "existing company" | "already a dismantler"; error?: string };

/** Plans an import, and with apply adds the new ones in one transaction. Nothing is overwritten. */
export async function importDismantlers(rows: ImportRow[], apply: boolean, userId: string): Promise<ImportPlan[]> {
  return withPgTransaction(async (client) => {
    const plan: ImportPlan[] = [];
    for (const row of rows) {
      const { rows: companies } = await client.query(
        `select c.id, d.id as dismantler_id from crm_companies c left join crm_dismantlers d on d.company_id = c.id
          where lower(btrim(c.name)) = lower($1)`,
        [row.name],
      );
      if (companies.length > 1) {
        plan.push({ name: row.name, action: "existing company", error: "Several CRM companies have this name. Add it by hand." });
        continue;
      }
      if (companies[0]?.dismantler_id) {
        plan.push({ name: row.name, action: "already a dismantler" });
        continue;
      }
      plan.push({ name: row.name, action: companies.length ? "existing company" : "new company" });
    }
    if (!apply) return plan;
    if (plan.some((item) => item.error)) throw new DismantlerError("Fix the lines marked in the preview first.");
    for (const row of rows) {
      if (plan.find((item) => item.name === row.name)?.action === "already a dismantler") continue;
      const companyId = await resolveCompany(client, { name: row.name });
      await insertDismantler(client, companyId, {
        country: row.country, ebay_username: row.ebay_username, ebay_listings: row.ebay_listings, source: "Imported list",
      }, userId, "imported");
    }
    return plan;
  });
}

export async function logEmailDraft(id: string, draft: { to: string[]; subject: string; draft_id: string | null }, userId: string) {
  await logEvent(pgPool, id, "email_draft", draft, userId);
}
