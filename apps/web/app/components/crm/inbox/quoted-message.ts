/** Fold conventional reply history/footer markers without discarding any message text. */
export function splitQuotedText(input: string): { visible: string; hidden: string } {
  const text = input.replace(/\r\n?/g, "\n").replace(/\n(?:[\t ]*\n){2,}/g, "\n\n").trim();
  const lines = text.split("\n");
  let boundary = lines.length;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const rest = lines.slice(index, index + 7).join("\n");
    const quote = /^\s*>/.test(line)
      || (/^On\s/i.test(line) && /^On\s[\s\S]{0,700}?wrote:\s*(?:\n|$)/i.test(rest))
      || (/^From:\s*\S/i.test(line) && /^From:[^\n]+\n(?:[^\n]*\n){0,4}Sent:/i.test(rest));
    const signature = /^-- ?$/.test(line) || /^(?:Sent from my (?:iPhone|iPad|Android)|Get Outlook for)/i.test(line);
    const signoff = /^(?:best(?: regards)?|kind regards|regards|sincerely|cheers)[,!]?\s*$/i.test(line)
      && lines.slice(index + 1).filter((value) => value.trim()).length >= 3
      && /@|https?:|www\.|\b(?:founder|CEO|director)\b/i.test(lines.slice(index + 1).join("\n"));
    if (quote || signature || signoff) { boundary = index; break; }
    // A repeated corporate footer without a delimiter: real name, role, then contact details.
    if (index > 0 && /^(?:founder\s*(?:&|and)\s*)?(?:CEO|CTO|COO|founder|director)\b/i.test(line)
      && /^[\p{L} .'-]{3,80}$/u.test(lines[index - 1]) && /@|https?:|www\./i.test(rest)) {
      boundary = index - 1; break;
    }
  }
  return { visible: lines.slice(0, boundary).join("\n").trim(), hidden: lines.slice(boundary).join("\n").trim() };
}
