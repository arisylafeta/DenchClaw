import "server-only";
import { marketplaceCandidates } from "./crm-postgres/demand-match-supply";
import { identitySignatures, splitCopy } from "./mail-draft-actions";
import { stripQuoted } from "./relay-context-core";
import { mailbox, mailboxSql, newestSlugs, stockTags, threadScore, type KnownCost } from "./relay-linked-core";
import { queryPg } from "./postgres";

/**
 * Emails to the other side of a deal, the reading part: the threads Alex has with the people an email depends on (the
 * supplier of the pack the buyer wants), with their newest email and any draft waiting there, and the recorded cost of the
 * pack. Nothing here writes; the desk writes through relay-desk.ts.
 */

/** One of Alex's Relay threads with someone else, as the desk and the page see it. Internal: never quoted to the other side. */
export type LinkedThread = {
  item_id: string; status: "open" | "review" | "done"; name: string | null; email: string; subject: string; at: string | null;
  /** Their newest email on it, in their words. */
  theirs: { at: string; message_id: string; text: string; has_files: boolean } | null;
  /** The reply waiting there, unsent: pass its version to change it. by_alex: Alex wrote the text as it is now. */
  draft: { draft_id: string; version: string; body: string; by_alex: boolean; waiting_to_send: boolean; linked_item_id: string | null } | null;
};

const LIVE = "('received','accepted','sent','delivered','opened','clicked','replied')";
const iso = (d: string | null) => (d ? new Date(d).toISOString() : null);

type ThreadRow = { item_id: string; status: LinkedThread["status"]; name: string | null; email: string; headline: string; subject: string | null; at: string | null;
  in_id: string | null; in_at: string | null; in_text: string | null; in_files: boolean | null;
  draft_id: string | null; draft_at: string | null; draft_body: string | null; draft_identity: string | null; last_by: string | null; scheduled: boolean | null; linked_item_id: string | null };

async function readThreads(where: string, values: unknown[], limit: number): Promise<LinkedThread[]> {
  const rows = await queryPg<ThreadRow>(
    `select i.id as item_id, i.status, i.counterpart_name as name, i.counterpart_email as email, i.headline,
            n.subject, coalesce(n.at, i.waiting_since::text, i.updated_at::text) as at,
            t.id as in_id, t.at as in_at, t.text as in_text, t.has_files as in_files,
            d.id as draft_id, d.mail_at as draft_at, d.body_text as draft_body, d.identity_key as draft_identity, d.last_by, d.scheduled, d.linked_item_id
       from relay_item i
       left join lateral (select m.subject, coalesce(m.sent_at, m.accepted_at, m.created_at)::text as at from mail_message m
         where m.thread_id = i.mail_thread_id and m.state in ${LIVE} order by coalesce(m.sent_at, m.accepted_at, m.created_at) desc limit 1) n on true
       left join lateral (select m.id, coalesce(m.sent_at, m.created_at)::text as at, left(m.body_text, 8000) as text, m.has_attachments as has_files from mail_message m
         where m.thread_id = i.mail_thread_id and m.direction = 'inbound' and m.state in ${LIVE} order by coalesce(m.sent_at, m.created_at) desc limit 1) t on true
       left join lateral (select r.id, m.updated_at::text as mail_at, m.body_text, m.identity_key, r.history->-1->>'by' as last_by,
           (m.personalization ? 'scheduled_send') as scheduled, r.linked_item_id
         from relay_draft r join mail_message m on m.id = r.mail_message_id
         where r.item_id = i.id and r.role = 'primary' and r.state in ('draft', 'gmail') and m.state = 'draft' order by r.created_at desc limit 1) d on true
      where i.mail_thread_id is not null and coalesce(i.counterpart_email, '') <> '' and (${where})
      order by coalesce(n.at::timestamptz, i.updated_at) desc limit ${limit}`, values);
  const signatures = rows.some((r) => r.draft_id) ? await identitySignatures() : new Map<string, never>();
  return rows.map((r) => ({
    item_id: r.item_id, status: r.status, name: r.name, email: r.email, subject: r.subject ?? r.headline, at: iso(r.at),
    theirs: r.in_id ? { at: iso(r.in_at)!, message_id: r.in_id, text: stripQuoted(r.in_text ?? "").slice(0, 2000), has_files: !!r.in_files } : null,
    draft: r.draft_id && r.draft_at ? {
      draft_id: r.draft_id, version: iso(r.draft_at)!, body: splitCopy(r.draft_body, signatures.get(r.draft_identity ?? "") ?? null).main,
      by_alex: r.last_by === "alex", waiting_to_send: !!r.scheduled, linked_item_id: r.linked_item_id,
    } : null,
  }));
}

type Item = { id: string; mail_thread_id: string | null; counterpart_email: string | null; contact_type: string | null };

/** The stock an email is about: the tags in its supplier emails, else the listings in the newest email that links any. */
type Stock = { person_email: string | null; supplier: string | null; title: string; make: string | null; model: string | null; year: string | null; supplier_ref: string | null; listed: number | null; listed_currency: string | null;
  buy: { amount?: unknown; currency?: unknown; source?: unknown } | null };

async function stockInPlay(item: Item): Promise<{ rows: Stock[]; asked: string[] }> {
  const linked = await queryPg<{ subject: string | null; body_text: string | null }>(
    `select m.subject, m.body_text from relay_draft d join mail_message m on m.id = d.mail_message_id
      where (d.item_id = $1 and d.role = 'follow' or d.linked_item_id = $1) and d.state <> 'skipped' order by d.created_at desc limit 6`, [item.id]);
  const asked = linked.map((l) => `${l.subject ?? ""}\n${l.body_text ?? ""}`);
  const tags = asked.map(stockTags).find((t) => t.length) ?? [];
  const SELECT = `select lower(p.email) as person_email, coalesce(c.name, p.full_name) as supplier, s.title, s.details->>'make' as make, s.details->>'model' as model, s.details->>'year' as year,
      s.supplier_ref, s.price::float8 as listed, upper(s.currency) as listed_currency, s.details->'extra'->'buy_price' as buy
    from crm_stock_opportunities s left join crm_companies c on c.id = s.company_id left join crm_people p on p.id = s.person_id`;
  if (tags.length) {
    const rows = await queryPg<Stock>(`${SELECT} where s.supplier_ref is not null and split_part(s.supplier_ref, ':', 2) = any($1) limit 10`, [tags]);
    if (rows.length) return { rows, asked };
  }
  if (!item.mail_thread_id) return { rows: [], asked };
  const mails = await queryPg<{ text: string }>(
    `select coalesce(body_text, '') as text from mail_message where thread_id = $1 and state in ${LIVE} order by coalesce(sent_at, accepted_at, created_at) desc limit 20`, [item.mail_thread_id]);
  const slugs = newestSlugs(mails.map((m) => stripQuoted(m.text)));
  if (!slugs.length) return { rows: [], asked };
  const candidates = await marketplaceCandidates().catch(() => []);
  const ids = candidates.filter((c) => slugs.some((s) => c.href?.toLowerCase().endsWith(`/${s}`) || c.key === `listing:${s}`)).map((c) => c.key.replace(/^listing:/, ""));
  return { rows: await queryPg<Stock>(`${SELECT} where s.marketplace_listing_id = any($1) or s.details->'marketplace'->>'slug' = any($2) limit 10`, [ids, slugs]), asked };
}

const CURRENCIES = new Set(["GBP", "EUR", "USD"]);

/** What is recorded as the cost of the stock an email is about (what the supplier asked), for the check against our price. */
export async function knownCosts(item: Item): Promise<KnownCost[]> {
  const { rows } = await stockInPlay(item);
  return rows.flatMap((r): KnownCost[] => {
    const amount = Number(r.buy?.amount);
    const currency = String(r.buy?.currency ?? "").toUpperCase();
    if (!Number.isFinite(amount) || amount <= 0 || !CURRENCIES.has(currency)) return [];
    const label = [r.make && r.make === r.make.toUpperCase() && r.make.length > 3 ? r.make[0] + r.make.slice(1).toLowerCase() : r.make, r.model, r.year].filter(Boolean).join(" ") || r.title;
    const source = typeof r.buy?.source === "string" ? r.buy.source.slice(0, 120) : null;
    return [{ label, supplier: r.supplier, amount, currency: currency as KnownCost["currency"], source, listed: r.listed_currency === currency ? r.listed : null }];
  });
}

/** What Alex last wrote on the thread: a price he offered there stands even when the reply doesn't repeat it. */
export async function lastWritten(item: Pick<Item, "mail_thread_id">): Promise<string> {
  if (!item.mail_thread_id) return "";
  const [row] = await queryPg<{ text: string | null }>(
    `select body_text as text from mail_message where thread_id = $1 and direction = 'outbound' and state in ${LIVE} order by coalesce(sent_at, accepted_at, created_at) desc limit 1`, [item.mail_thread_id]);
  return stripQuoted(row?.text ?? "");
}

/**
 * Alex's threads with the people this email depends on: those already written to from here, and the supplier of the pack
 * in play. The thread about the same thing first. Empty when nobody is known.
 */
export async function relatedThreads(item: Item, ownerId: string, limit = 4): Promise<LinkedThread[]> {
  const [{ rows, asked }, sent] = await Promise.all([
    stockInPlay(item),
    queryPg<{ a: string }>(
      `select distinct lower(a) as a from relay_draft d join mail_message m on m.id = d.mail_message_id, unnest(coalesce(m.to_emails, '{}')) a
        where (d.item_id = $1 and d.role = 'follow' or d.linked_item_id = $1) and d.state <> 'skipped' and coalesce(d.to_kind, 'supplier') <> 'buyer'`, [item.id]),
  ]);
  const own = item.counterpart_email ? mailbox(item.counterpart_email) : "";
  const people = [...new Set([...sent.map((s) => s.a), ...rows.map((r) => r.person_email ?? "")].filter((a) => a.includes("@") && !a.endsWith("@rebattery.io")).map(mailbox))].filter((m) => m !== own);
  if (!people.length) return [];
  const threads = await readThreads(`i.owner_id = $1::uuid and i.id <> $2 and ${mailboxSql("i.counterpart_email")} = any($3) and (i.status <> 'done' or i.updated_at > now() - interval '45 days')`, [ownerId, item.id, people], 20);
  const about = [...asked, ...rows.map((r) => `${r.title} ${r.make ?? ""} ${r.model ?? ""} ${r.supplier_ref?.split(":")[1] ?? ""}`)].join("\n");
  const ranked = threads.map((t) => ({ t, score: threadScore(about, `${t.subject}\n${t.theirs?.text ?? ""}`) }));
  return ranked.sort((a, b) => b.score - a.score || (b.t.at ?? "").localeCompare(a.t.at ?? "")).slice(0, limit).map((x) => x.t);
}

/** Alex's threads with a person (an address, name or company), about some words if given: the desk's look-up. */
export async function findThreads(ownerId: string, itemId: string, person: string, words: string, limit = 6): Promise<LinkedThread[]> {
  const who = person.trim().toLowerCase();
  const match = who.includes("@") ? `${mailboxSql("i.counterpart_email")} = $3` : `(lower(coalesce(i.counterpart_name, '') || ' ' || coalesce(i.company, '') || ' ' || i.counterpart_email) like $3)`;
  const threads = await readThreads(`i.owner_id = $1::uuid and i.id <> $2 and ${match}`, [ownerId, itemId, who.includes("@") ? mailbox(who) : `%${who.replace(/[%_\\]/g, "\\$&")}%`], 30);
  if (!words.trim()) return threads.slice(0, limit);
  return threads.map((t) => ({ t, score: threadScore(words, `${t.subject}\n${t.theirs?.text ?? ""}`) })).sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.t);
}

/** One thread by its Relay item, when it is Alex's. */
export async function linkedThread(ownerId: string, itemId: string): Promise<LinkedThread | null> {
  return (await readThreads("i.owner_id = $1::uuid and i.id = $2", [ownerId, itemId], 1))[0] ?? null;
}
