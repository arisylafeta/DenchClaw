/** Relay's own draft before Alex writes a note: what the model returns, and when a stored one is still good. Pure. */

export type NeedsInput = { question: string; options: string[] };
export type SuggestionTodo = { title: string; detail: string; kind: "suggested" | "promise" };
export type Suggestion = {
  body: string; subject: string | null; needs_input: NeedsInput | null; todos: SuggestionTodo[];
  for_message_id: string | null; voice_version: number | null; at: string;
};
export type FailedSuggestion = { failed_for: string | null; error: string; at: string };
export type StoredSuggestion = Suggestion | FailedSuggestion;

export const isDraft = (s: StoredSuggestion | null | undefined): s is Suggestion => !!s && "body" in s;

/** Follow-up chases are re-drafted after three days even with no new message: the reason to chase moves on. */
export const CHASE_MAX_AGE_DAYS = 3;

/** A stored draft is shown only while it was written for the newest message Relay has seen (and, for a chase, is recent). */
export function isFresh(s: StoredSuggestion | null | undefined, lastSeenMessageId: string | null, tab: string, now = Date.now()): s is Suggestion {
  if (!isDraft(s) || s.for_message_id !== lastSeenMessageId) return false;
  return tab !== "follow" || now - Date.parse(s.at) < CHASE_MAX_AGE_DAYS * 86_400_000;
}

/** Reads the model's reply. A draft needs a body; a question for Alex needs the question and two or three options. */
export function parseSuggestion(content: string): Omit<Suggestion, "for_message_id" | "voice_version" | "at"> {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("no JSON in the reply");
  const raw = JSON.parse(match[0]) as Record<string, unknown>;
  const ask = raw.needs_input as Record<string, unknown> | null | undefined;
  const options = Array.isArray(ask?.options) ? (ask!.options as unknown[]).filter((o): o is string => typeof o === "string" && !!o.trim()).map((o) => o.trim().slice(0, 80)).slice(0, 3) : [];
  const needs_input = ask && typeof ask.question === "string" && ask.question.trim() && options.length >= 2
    ? { question: ask.question.trim().replace(/—/g, ",").slice(0, 200), options } : null;
  const body = needs_input ? "" : String(raw.body ?? "").trim();
  if (!needs_input && !body) throw new Error("neither a draft nor a question");
  const todos = (Array.isArray(raw.todos) ? raw.todos : []).slice(0, 3).flatMap((t): SuggestionTodo[] => {
    const r = t as Record<string, unknown>;
    const title = String(r?.title ?? "").trim().slice(0, 160);
    return title ? [{ title, detail: String(r?.detail ?? "").slice(0, 200), kind: r?.kind === "promise" ? "promise" : "suggested" }] : [];
  });
  return { body, subject: typeof raw.subject === "string" && raw.subject.trim() ? raw.subject.trim().slice(0, 300) : null, needs_input, todos };
}
