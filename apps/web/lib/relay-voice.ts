/** How Relay puts the owner's voice into a draft prompt. Pure, shared by the server and its tests; mirrors relay_voice_study.py. */

export type VoiceExample = { inbound: string; reply: string; contact_type: string | null; sent_at: string };

const WORD = /[a-z]{4,}/g;
const wordsOf = (text: string) => new Set((text ?? "").toLowerCase().match(WORD) ?? []);

/** His closest real replies: same kind of contact first, then most words shared with their email, then newest. */
export function pickExamples(pool: VoiceExample[], contactType: string | null, theirText: string, k = 3): VoiceExample[] {
  const wanted = wordsOf(theirText);
  const score = (e: VoiceExample) => {
    let shared = 0;
    for (const w of wordsOf(e.inbound)) if (wanted.has(w)) shared += 1;
    return [contactType != null && e.contact_type === contactType ? 1 : 0, shared, Date.parse(e.sent_at) || 0];
  };
  return [...pool].sort((a, b) => {
    const [x, y] = [score(a), score(b)];
    return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
  }).slice(0, k);
}

/** The guide goes into the system prompt; the card and examples go in front of the thread. */
export function voiceGuideBlock(guide: string | null | undefined): string {
  return guide ? `\nHow Alex writes (follow this closely; it is learned from thousands of his emails):\n${guide}\n` : "";
}

export function voiceExamplesBlock(card: string | null, examples: VoiceExample[]): string {
  if (!card && !examples.length) return "";
  const parts = card ? [`How Alex handles this kind of email:\n${card}`] : [];
  if (examples.length) {
    parts.push(`How Alex answered similar emails (style only: the facts, names and numbers in them are old and must not be reused):\n${
      examples.map((e) => `They wrote: ${e.inbound.slice(0, 400)}\nAlex replied:\n${e.reply}`).join("\n\n")}`);
  }
  return `${parts.join("\n\n")}\n\n`;
}

/** With a voice, the greeting and sign-off follow it instead of the fixed "Best, Alex". */
export const greetingRule = (hasVoice: boolean) => hasVoice
  ? `- Greet by first name ("Hi Mark,"). Sign off the way "How Alex writes" describes, with "Alex" on its own line. Do not add a signature block; it is added automatically.`
  : `- Greet by first name ("Hi Mark,"), sign off "Best,\\nAlex". Do not add a signature block; it is added automatically.`;
