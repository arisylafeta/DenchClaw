/** "Before you send": plain checks on a Relay draft, shared by the page and its tests. No AI, no network. */

const MONEY = /[£€$]\s?\d[\d,]*(?:\.\d+)?\s?k?\b/gi;

/** "£1,500.00" and "£1500" compare equal; "€30k" is €30000. A trailing comma or full stop is not part of the number. */
export function normaliseAmount(raw: string): string {
  const text = raw.trim().replace(/[,.]+$/, "");
  const thousands = /k$/i.test(text);
  const value = Number(text.replace(/[^\d.]/g, "")) * (thousands ? 1000 : 1);
  return `${text[0]}${Number.isFinite(value) ? Math.round(value * 100) / 100 : text}`;
}

export const amountsIn = (text: string) => [...new Set((text.match(MONEY) ?? []).map(normaliseAmount))];

export type CheckFacts = { amounts: string[]; participants: string[]; unit: "cell" | "kwh" | null };
export type CheckDraft = { to: string[]; body: string; attachments: number };
export type Issue = { level: "block" | "check"; text: string; fix?: { label: string; to: string } };
export type Verdict = { state: "ok" | "check" | "stop"; issues: Issue[]; good: string[] };

const display = (amount: string) => `${amount[0]}${Number(amount.slice(1)).toLocaleString("en-GB")}`;

export function beforeYouSend(draft: CheckDraft, facts: CheckFacts): Verdict {
  const issues: Issue[] = [];
  const good: string[] = [];
  const to = draft.to.map((a) => a.trim().toLowerCase()).filter(Boolean);
  const known = new Set(facts.participants.map((a) => a.toLowerCase()));
  const domains = new Set([...known].map((a) => a.split("@")[1]));
  if (!to.length) issues.push({ level: "block", text: "No recipient yet. Add who this goes to." });
  else {
    const stranger = to.find((a) => !known.has(a) && !domains.has(a.split("@")[1]));
    if (stranger && known.size) issues.push({ level: "block", text: `${stranger} isn't on this thread.`, fix: facts.participants[0] ? { label: `Use ${facts.participants[0]}`, to: facts.participants[0] } : undefined });
    else good.push("it's going to the right person");
  }
  const seen = new Set(facts.amounts);
  const unknown = amountsIn(draft.body).filter((a) => !seen.has(a));
  for (const amount of unknown) issues.push({ level: "check", text: `${display(amount)} isn't in the thread or the deal. Check the number.` });
  if (!unknown.length && amountsIn(draft.body).length) good.push("the numbers match the thread and deal");
  if (facts.unit === "cell" && /kwh/i.test(draft.body)) issues.push({ level: "check", text: "Units: this deal is priced per cell, the draft mentions kWh." });
  if (facts.unit === "kwh" && /per cell|\/\s?cell/i.test(draft.body)) issues.push({ level: "check", text: "Units: this deal is priced per kWh, the draft says per cell." });
  if (/\b(attached|enclosed|attaching)\b/i.test(draft.body) && !draft.attachments) issues.push({ level: "block", text: "Says 'attached' but nothing is attached. Attach the file or change the wording." });
  else if (draft.attachments) good.push(draft.attachments === 1 ? "the attachment is there" : "the attachments are there");
  if (/\[BLANK\]|\[[A-Z ]{3,}\]/.test(draft.body)) issues.push({ level: "block", text: "There's a blank to fill in." });
  const state = issues.some((i) => i.level === "block") ? "stop" : issues.length ? "check" : "ok";
  return { state, issues, good };
}

/** Commitments in Alex's own words ("I'll send the stock list") that should become to-dos. */
export function promisesIn(body: string): string[] {
  const out: string[] = [];
  for (const match of body.matchAll(/\b(?:I'll|I will|we'll|we will)\s+([^.\n?!]*\b(?:come back|send|confirm|have|test|book|share|check|revert|follow up|call|arrange)\b[^.\n?!]*)/gi)) {
    const text = match[1].trim().replace(/^./, (c) => c.toUpperCase()).slice(0, 90);
    if (text && !out.includes(text)) out.push(text);
  }
  return out.slice(0, 3);
}
