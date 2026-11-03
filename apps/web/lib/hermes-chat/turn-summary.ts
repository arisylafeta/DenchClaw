/** One short plain-text line from the end of an assistant reply, for a notification body. */
export function summarizeTurn(text: string, max = 160): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|[-*+>]|\d+[.)])\s+/gm, "")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) { return ""; }
  if (plain.length <= max) { return plain; }
  const head = plain.slice(0, max);
  const stop = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  if (stop > max * 0.5) { return head.slice(0, stop + 1); }
  const space = head.lastIndexOf(" ");
  return `${head.slice(0, space > max * 0.5 ? space : max - 1)}…`;
}
