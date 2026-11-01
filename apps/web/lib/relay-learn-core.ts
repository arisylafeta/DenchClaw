/** How Relay learns writing rules from what Alex sends. Pure: shared by the server and its tests. */

export type LearnPair = { id: string; situation: string | null; before: string; after: string };
export type LearnRule = { id: string; text: string };
export type Evidence = { draft_id?: string; before?: string; after?: string; request?: string };
export type Proposal = { action: "add" | "remove"; text: string; target_id: string | null; why: string; evidence: Evidence[] };

export const MAX_LEARNED = 15;
const MAX_ADDS = 3;
const MAX_REMOVES = 2;

const tokens = (text: string) => (text ?? "").toLowerCase().replace(/[’']/g, "'").match(/[a-z0-9£€$']+/g) ?? [];

/** Word-level similarity, 0..1: twice the longest common subsequence over both lengths. */
export function similarity(a: string, b: string): number {
  const x = tokens(a), y = tokens(b);
  if (!x.length && !y.length) return 1;
  if (!x.length || !y.length) return 0;
  let prev = new Array<number>(y.length + 1).fill(0);
  for (const word of x) {
    const row = new Array<number>(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j += 1) row[j] = word === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
    prev = row;
  }
  return (2 * prev[y.length]) / (x.length + y.length);
}

/** Sent as Relay wrote it (bar spacing or a word or two): an approval, not a lesson. */
export const unchanged = (before: string, after: string) => similarity(before, after) >= 0.95;

/** Two rules say the same thing when most of their words match (quotes, case and punctuation aside). */
export function sameRule(a: string, b: string): boolean {
  const x = new Set(tokens(a).filter((w) => w.length > 2)), y = new Set(tokens(b).filter((w) => w.length > 2));
  if (!x.size || !y.size) return false;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / Math.min(x.size, y.size) >= 0.8;
}

export function learnPrompt(input: { own: string[]; learned: LearnRule[]; rejected: string[]; pairs: LearnPair[]; requests: { draft_id: string; text: string }[]; unchanged: number }): string {
  return `You maintain the drafting rules Relay follows when it writes emails as Alex Polglase (founder of ReBattery, a UK marketplace and broker
for used EV and storage batteries). Relay already follows a long writing guide learned from his sent mail; these rules are the corrections
on top, learned from how he edits Relay's drafts before sending.

Below: his own rules (never touch them), the learned rules in force (with ids), rules he rejected (never propose these or anything like
them), drafts he edited before sending (what Relay wrote, what he sent), and what he asked Relay's editor to change. ${input.unchanged} other
drafts went out unchanged this period.

Propose changes only where his edits show a clear, repeated pattern: a new rule needs at least two drafts or a repeated request as
evidence. A rule is one imperative line of at most 25 words about how he writes, general enough for any email: no names, companies,
prices, products or one-off facts. Never restate a rule that is already in force, his own or learned. Propose removing a learned rule when
his sends contradict it. At most ${MAX_ADDS} additions and ${MAX_REMOVES} removals. ${input.learned.length >= MAX_LEARNED ? `There are already ${MAX_LEARNED} learned rules: every addition needs a removal.` : ""}
Empty lists are the right answer when the edits show no pattern. British English, no em dashes.

Reply with ONLY JSON:
{"add": [{"rule": "...", "why": "<one line: what he kept changing>", "evidence": ["<draft ids>"]}],
 "remove": [{"rule_id": "...", "why": "<one line>", "evidence": ["<draft ids>"]}]}

## His own rules
${input.own.map((r) => `- ${r}`).join("\n") || "(none)"}

## Learned rules in force
${input.learned.map((r) => `- [${r.id}] ${r.text}`).join("\n") || "(none)"}

## Rules he rejected
${input.rejected.map((r) => `- ${r}`).join("\n") || "(none)"}

## Drafts he edited
${JSON.stringify(input.pairs.map((p) => ({ id: p.id, situation: p.situation, relay_wrote: p.before.slice(0, 1200), alex_sent: p.after.slice(0, 1200) })))}

## What he asked the editor to change
${JSON.stringify(input.requests)}`;
}

/** Checks the model's proposals against the evidence and the rules there are, and drops anything unsupported or repeated. */
export function parseProposals(content: string, ctx: { pairs: LearnPair[]; requests: { draft_id: string; text: string }[]; learned: LearnRule[]; known: string[] }): Proposal[] {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return [];
  let parsed: { add?: unknown; remove?: unknown };
  try { parsed = JSON.parse(match[0]); } catch { return []; }
  const pairs = new Map(ctx.pairs.map((p) => [p.id, p]));
  const requestsBy = new Map<string, string[]>();
  for (const r of ctx.requests) requestsBy.set(r.draft_id, [...(requestsBy.get(r.draft_id) ?? []), r.text]);
  const evidenceOf = (ids: unknown): Evidence[] => (Array.isArray(ids) ? ids : []).filter((id): id is string => typeof id === "string").flatMap((id): Evidence[] => {
    const pair = pairs.get(id);
    if (pair) return [{ draft_id: id, before: pair.before.slice(0, 400), after: pair.after.slice(0, 400) }];
    return (requestsBy.get(id) ?? []).map((request) => ({ draft_id: id, request }));
  });
  const out: Proposal[] = [];
  const seen = [...ctx.known];
  for (const raw of (Array.isArray(parsed.add) ? parsed.add : []).slice(0, MAX_ADDS) as Record<string, unknown>[]) {
    const text = String(raw?.rule ?? "").replace(/—/g, ",").trim().slice(0, 240);
    const evidence = evidenceOf(raw?.evidence);
    if (!text || !evidence.length || seen.some((k) => sameRule(k, text))) continue;
    seen.push(text);
    out.push({ action: "add", text, target_id: null, why: String(raw?.why ?? "").slice(0, 240), evidence });
  }
  const learned = new Map(ctx.learned.map((r) => [r.id, r]));
  for (const raw of (Array.isArray(parsed.remove) ? parsed.remove : []).slice(0, MAX_REMOVES) as Record<string, unknown>[]) {
    const target = learned.get(String(raw?.rule_id ?? ""));
    if (!target || out.some((p) => p.target_id === target.id)) continue;
    out.push({ action: "remove", text: target.text, target_id: target.id, why: String(raw?.why ?? "").slice(0, 240), evidence: evidenceOf(raw?.evidence) });
  }
  return out;
}
