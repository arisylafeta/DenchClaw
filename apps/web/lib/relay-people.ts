import "server-only";
import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import { queryPg } from "./postgres";
import { RelayError } from "./relay";

/**
 * One person, one record: the addresses Relay knows belong to one person (relay_person_address, written by the scan's
 * relay_people.py when someone says so in their own email, or by Alex), and the open "same person?" questions
 * (relay_person_suggestion). The waiting list, the desk and the leak guard read a person through here, not an address.
 */

export type PersonAddress = { address: string; how: "stated" | "alex"; evidence: string | null };
export type PersonSuggestion = { id: string; address: string; other_address: string; why: string; evidence: string | null };

const lower = (a: string | null | undefined) => (a ?? "").trim().toLowerCase();

/** Before migration 137 is applied the tables are missing: then nobody is linked. */
async function read<T extends QueryResultRow>(sql: string, values: unknown[]): Promise<T[]> {
  try {
    return await queryPg<T>(sql, values);
  } catch (error) {
    if ((error as { code?: string }).code === "42P01") return [];
    throw error;
  }
}

/** Each linked address among these, to its person's key. Addresses nobody linked are left out. */
export async function personKeys(ownerId: string, addresses: string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(addresses.map(lower).filter(Boolean))];
  if (!wanted.length) return new Map();
  const rows = await read<{ address: string; person_key: string }>(
    "select address, person_key from relay_person_address where owner_id = $1::uuid and address = any($2)", [ownerId, wanted]);
  return new Map(rows.map((r) => [r.address, r.person_key]));
}

/** The person's other addresses, with why each is theirs. Empty when the address is linked to nobody. */
export async function otherAddresses(ownerId: string, address: string | null | undefined): Promise<PersonAddress[]> {
  const a = lower(address);
  if (!a) return [];
  return read<PersonAddress>(
    `select o.address, o.how, o.evidence from relay_person_address p join relay_person_address o on o.owner_id = p.owner_id and o.person_key = p.person_key
      where p.owner_id = $1::uuid and p.address = $2 and o.address <> $2 order by o.created_at`, [ownerId, a]);
}

/** The address and the person's others, lower-case: what "this person" means in a query. */
export async function addressesOf(ownerId: string, address: string | null | undefined): Promise<string[]> {
  const a = lower(address);
  return a ? [a, ...(await otherAddresses(ownerId, a)).map((o) => o.address)] : [];
}

/** The open "same person?" questions about this address, for Alex to answer Yes or No. */
export async function openSuggestions(ownerId: string, address: string | null | undefined): Promise<PersonSuggestion[]> {
  const a = lower(address);
  if (!a) return [];
  return read<PersonSuggestion>(
    `select id, address, other_address, why, evidence from relay_person_suggestion
      where owner_id = $1::uuid and status = 'open' and $2 in (address, other_address) order by created_at`, [ownerId, a]);
}

/** Alex says two addresses are one person: both join one key (one they already have, else a new one). */
async function link(ownerId: string, a: string, b: string, by: string, evidence: string): Promise<void> {
  const keys = await personKeys(ownerId, [a, b]);
  const key = keys.get(a) ?? keys.get(b) ?? randomUUID();
  const join = [keys.get(a), keys.get(b)].filter((k): k is string => !!k && k !== key);
  if (join.length) await queryPg("update relay_person_address set person_key = $2 where owner_id = $1::uuid and person_key = any($3)", [ownerId, key, join]);
  for (const address of [a, b]) {
    if (keys.has(address)) continue;
    await queryPg(
      `insert into relay_person_address (owner_id, address, person_key, how, evidence, confirmed_by) values ($1::uuid, $2, $3, 'alex', $4, $5)
        on conflict (owner_id, address) do nothing`, [ownerId, address, key, evidence, by]);
  }
}

/** Yes or No to a "same person?" question. Yes links the two; No is kept, so the scan never asks again. */
export async function decideSuggestion(ownerId: string, id: string, yes: boolean, by: string): Promise<void> {
  const [s] = await queryPg<PersonSuggestion & { status: string }>(
    "select id, address, other_address, why, evidence, status from relay_person_suggestion where id = $1 and owner_id = $2::uuid", [id, ownerId]);
  if (!s) throw new RelayError(404, "No such question");
  if (s.status !== "open") return;
  if (yes) await link(ownerId, s.address, s.other_address, by, `Alex said yes: ${s.evidence ?? s.why}`.slice(0, 500));
  await queryPg("update relay_person_suggestion set status = $3, decided_by = $4, decided_at = now() where id = $1 and owner_id = $2::uuid",
    [id, ownerId, yes ? "yes" : "no", by]);
}

/**
 * Unlink: the address stands alone again, and a "no" is kept against each of its old partners so neither the scan
 * nor a suggestion puts them back together.
 */
export async function unlinkAddress(ownerId: string, address: string, by: string): Promise<void> {
  const a = lower(address);
  const others = await otherAddresses(ownerId, a);
  await queryPg("delete from relay_person_address where owner_id = $1::uuid and address = $2", [ownerId, a]);
  for (const o of others) {
    const [x, y] = [a, o.address].sort();
    await queryPg(
      `insert into relay_person_suggestion (owner_id, address, other_address, why, status, decided_by, decided_at)
        values ($1::uuid, $2, $3, 'unlinked', 'no', $4, now())
        on conflict (owner_id, address, other_address) do update set status = 'no', decided_by = excluded.decided_by, decided_at = now()`,
      [ownerId, x, y, by]);
  }
}
