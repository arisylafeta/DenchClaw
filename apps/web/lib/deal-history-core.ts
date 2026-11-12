import { ownText } from "./relay-context-core";

/**
 * One readable history per deal (slice 3, B6), the pure part: an email or WhatsApp message as a person reads it. On the
 * 4 Nov call the offer emails in History were unreadable: HTML with "no link text". So the text is the email's own words
 * (no quoted thread under it), taken from the HTML when the plain part is missing or is itself markup, with every link
 * kept as its words and its address.
 */

export type HistoryMessage = {
  id: string;
  channel: "mail" | "whatsapp";
  direction: "inbound" | "outbound" | null;
  /** Who sent it, as a person reads it: "Alex", "Dana Field", "dana@acme.example". */
  from: string;
  at: string;
  subject: string | null;
  text: string;
  /** Where to read the whole thread or chat. */
  href: string | null;
};

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", "#39": "'", ndash: "-", mdash: "-", hellip: "...", pound: "£", euro: "€" };
const decode = (text: string) => text
  .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&([a-z0-9#]+);/gi, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole);

/** HTML to plain text a person can read: blocks on their own lines, links as "words (address)", no markup left. */
export function htmlToReadable(html: string): string {
  const linked = html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, inner: string) => {
      const words = decode(inner.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
      const address = decode(href).replace(/^mailto:/i, "");
      if (!words) return address;
      return words === address || words.replace(/^https?:\/\//, "") === address.replace(/^https?:\/\//, "") ? words : `${words} (${address})`;
    });
  return decode(linked
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, ""))
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
}

const LOOKS_LIKE_HTML = /<(?:html|body|div|p|br|table|a)\b/i;

/** An email's own words for History: plain part when it has real text, else the HTML made readable; quotes cut. */
export function readableMail(text: string | null | undefined, html: string | null | undefined, subject: string | null = null): string {
  const plain = (text ?? "").trim();
  const source = plain && !LOOKS_LIKE_HTML.test(plain) ? plain : html?.trim() ? htmlToReadable(html) : htmlToReadable(plain);
  return ownText(source, subject).slice(0, 6000);
}

/** Oldest first, one thread: email and WhatsApp together. Same instant keeps email before chat, then by id. */
export function sortHistory(messages: HistoryMessage[]): HistoryMessage[] {
  return [...messages].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.channel.localeCompare(b.channel) || a.id.localeCompare(b.id));
}
