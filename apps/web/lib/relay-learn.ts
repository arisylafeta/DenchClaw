import "server-only";
import { readFileSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { queryPg } from "./postgres";
import { askAgent, settleSentDrafts } from "./relay";
import { identitySignatures, splitCopy } from "./mail-draft-actions";
import { learnPrompt, MAX_LEARNED, parseProposals, unchanged, type LearnPair } from "./relay-learn-core";

/** Server-to-server calls (the weekly learning run, later pre-drafting) carry this secret; it lives in a 0600 file. */
const SECRET_FILE = "/root/.hermes/workspace/secrets/relay-internal.secret";

export function internalAuthorised(request: Request): boolean {
  let expected: string;
  try { expected = readFileSync(process.env.RELAY_INTERNAL_SECRET_FILE || SECRET_FILE, "utf8").trim(); } catch { return false; }
  if (expected.length < 32) return false;
  const given = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const digest = (v: string) => createHash("sha256").update(v).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

export type LearnResult = { sent: number; unchanged: number; edited: number; requests: number; proposed: number; note: string };

/**
 * The weekly learning run: records what was sent, compares it with what Relay wrote, and proposes rule changes for Alex to
 * approve on the Rules page. Covers sends since the last run (two weeks the first time). Fewer than two edited drafts and
 * no repeated request: nothing to learn, no model call.
 */
export async function learnFromSends(ownerId: string): Promise<LearnResult> {
  const startedAt = new Date().toISOString();  // the next run starts here, so a send during this run's model call is not missed
  await settleSentDrafts(ownerId);
  const [last] = await queryPg<{ ran_at: string }>("select ran_at::text from relay_learn_run where owner_id = $1::uuid order by ran_at desc limit 1", [ownerId]);
  const since = last?.ran_at ?? new Date(Date.now() - 14 * 86_400_000).toISOString();
  // Timestamps are compared in SQL (window flags and requests in the window), never as strings here.
  const drafts = await queryPg<{ id: string; situation: string | null; original_body: string | null; sent_body: string | null; sent_in_window: boolean; identity_key: string | null; requests: string[] }>(
    `select d.id, i.situation, d.original_body, d.sent_body, coalesce(d.state = 'sent' and d.sent_at > $2::timestamptz, false) as sent_in_window, m.identity_key,
       array(select r->>'text' from jsonb_array_elements(d.edit_requests) r where coalesce((r->>'at')::timestamptz > $2::timestamptz, true)) as requests
     from relay_draft d join relay_item i on i.id = d.item_id left join mail_message m on m.id = d.mail_message_id
     where i.owner_id = $1::uuid and ((d.state = 'sent' and d.sent_at > $2::timestamptz)
       or exists (select 1 from jsonb_array_elements(d.edit_requests) r where (r->>'at')::timestamptz > $2::timestamptz))
     order by coalesce(d.sent_at, d.updated_at)`, [ownerId, since]);
  // Both sides split with today's signature, so a signature that slipped into one copy never reads as an edit.
  const signatures = await identitySignatures();
  const main = (text: string, identity: string | null) => splitCopy(text, signatures.get(identity ?? "") ?? null).main;
  const sent = drafts.filter((d) => d.sent_in_window && d.sent_body != null && d.original_body != null);
  const edited = sent.map((d) => ({ id: d.id, situation: d.situation, before: main(d.original_body!, d.identity_key), after: main(d.sent_body!, d.identity_key) }))
    .filter((p) => !unchanged(p.before, p.after));
  const pairs: LearnPair[] = edited.slice(-15);
  const requests = drafts.flatMap((d) => (d.requests ?? []).map((text) => ({ draft_id: d.id, text: String(text ?? "") }))).filter((r) => r.text);
  const counts = new Map<string, number>();
  for (const r of requests) counts.set(r.text.toLowerCase(), (counts.get(r.text.toLowerCase()) ?? 0) + 1);
  const result: LearnResult = { sent: sent.length, unchanged: sent.length - edited.length, edited: edited.length, requests: requests.length, proposed: 0, note: "" };

  if (pairs.length < 2 && ![...counts.values()].some((n) => n >= 2)) {
    result.note = "Too few edits to learn from";
  } else {
    const rules = await queryPg<{ id: string; text: string; source: string; state: string; action: string; target_id: string | null }>(
      "select id, text, source, state, action, target_id from relay_rule where owner_id = $1::uuid", [ownerId]);
    const own = rules.filter((r) => r.source === "alex" && r.state === "active").map((r) => r.text);
    const learned = rules.filter((r) => r.source === "learned" && r.state === "active").map((r) => ({ id: r.id, text: r.text }));
    // A turned-down removal names a rule still in force: it is not a rejected rule.
    const rejected = rules.filter((r) => r.state === "rejected" && r.action === "add").map((r) => r.text);
    const blockedTargets = rules.filter((r) => r.action === "remove" && r.target_id).map((r) => r.target_id!);
    const content = await askAgent("You maintain an email assistant's drafting rules. Reply with JSON only.",
      learnPrompt({ own, learned, rejected, pairs, requests, unchanged: result.unchanged }), 180_000);
    const proposals = parseProposals(content, { pairs, requests, learned, known: rules.filter((r) => r.action === "add").map((r) => r.text), blockedTargets });
    for (const p of proposals) {
      // The unique index on waiting proposals makes an overlapping run a no-op.
      const inserted = await queryPg(`insert into relay_rule (owner_id, text, position, source, state, action, target_id, why, evidence)
        values ($1::uuid, $2, (select coalesce(max(position), 0) + 1 from relay_rule where owner_id = $1::uuid), 'learned', 'proposed', $3, $4, $5, $6::jsonb)
        on conflict do nothing returning id`,
        [ownerId, p.text, p.action, p.target_id, p.why, JSON.stringify(p.evidence)]);
      result.proposed += inserted.length;
    }
    result.note = result.proposed ? "" : "No clear pattern in the edits";
    if (learned.length >= MAX_LEARNED && proposals.some((p) => p.action === "add") && !proposals.some((p) => p.action === "remove")) {
      result.note = `At ${MAX_LEARNED} learned rules: approve a removal before adding more`;
    }
  }
  await queryPg(`insert into relay_learn_run (owner_id, ran_at, sent, unchanged, edited, proposed, note) values ($1::uuid, $2::timestamptz, $3, $4, $5, $6, $7)`,
    [ownerId, startedAt, result.sent, result.unchanged, result.edited, result.proposed, result.note]);
  return result;
}
