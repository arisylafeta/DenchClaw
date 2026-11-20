/** What Alex reads of an email in Relay: the message itself, without quoted replies, the signature block under the
 * sign-off, legal disclaimers or "Sent from my iPhone". Pure, so the page and the server clean alike. The original is
 * untouched; Relay links to it. */

import { stripQuoted } from "./relay-context-core";

/** One email of a thread as stored (GET /api/relay/items/[id]/thread): the page cleans it and links to the original. */
export type ThreadEmail = { id: string; direction: string; from_email: string | null; at: string; text: string };

/** A line that is only a sign-off: "Kind regards,", "Best", "Thanks!", "Mit freundlichen Grüßen". */
const SIGN_OFF = /^(?:(?:kind(?:est)?|best|warm(?:est)?|many|with)\s+(?:regards|wishes|thanks)|regards|best(?:\s+wishes)?|thanks(?:\s+again)?|many thanks|thank you|cheers|sincerely|yours(?:\s+(?:sincerely|faithfully|truly))?|all the best|speak soon|met vriendelijke groet(?:en)?|vriendelijke groet(?:en)?|groeten|mit freundlichen gr(?:ü|ue)(?:ß|ss)en|viele gr(?:ü|ue)(?:ß|ss)e|beste gr(?:ü|ue)(?:ß|ss)e|lg|cordialement|bien (?:à|a) vous|saluti|cordiali saluti|distinti saluti|un saluto|pozdrawiam|z powa(?:ż|z)aniem|s pozdravem|saludos|un saludo|atentamente|med v(?:ä|a)nliga h(?:ä|a)lsningar|mvh)[\s,.!]*$/i;

/** Where the boilerplate starts: everything from this line down goes. */
const BOILERPLATE = /^\s*(?:confidential(?:ity)?(?:\s+notice)?\s*:?|disclaimer\s*:?|this (?:e-?mail|message|communication)\b.{0,60}\b(?:confidential|privileged|intended)|we proudly represent\b|sent from my (?:iphone|ipad|android|samsung|mobile|galaxy)|sent from (?:outlook|mail) for|get outlook for|please consider the environment|think before you print|--\s*$|_{5,}\s*$)/i;

const IMAGE_LINE = /^\s*\[(?:image|cid:[^\]]*|image:[^\]]*)\]\s*$/i;

/** A name under the sign-off: short, no address, link or phone number. */
const looksLikeName = (line: string) => line.length <= 40 && !/[@:/]|\d{3}/.test(line);

export function cleanEmail(raw: string): string {
  // Inline pictures (logos, banners) come through as "[image]" or "[cid:…]" lines: nothing to read.
  const lines = stripQuoted(raw.replace(/\r\n?/g, "\n")).split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => !IMAGE_LINE.test(l));
  let end = lines.length;
  const boiler = lines.findIndex((l) => BOILERPLATE.test(l));
  if (boiler >= 0) end = boiler;
  // The first sign-off after some message keeps itself and the name under it; the signature block below goes.
  const firstText = lines.findIndex((l) => l.trim());
  const sign = lines.findIndex((l, i) => i > firstText && i < end && SIGN_OFF.test(l.trim()));
  if (sign >= 0) {
    let next = sign + 1;
    while (next < end && !lines[next].trim()) next++;
    end = next < end && looksLikeName(lines[next].trim()) ? next + 1 : sign + 1;
  }
  return lines.slice(0, end).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The cleaned email as paragraphs, for tight spacing: a blank line starts a new one, single line breaks stay. */
export const emailParagraphs = (raw: string) => cleanEmail(raw).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

const GREETING = /^(?:hi|hello|hey|dear|good (?:morning|afternoon|evening)|hallo|guten tag|bonjour|ciao|buongiorno|dzie(?:ń|n) dobry|hola)\b[^\n]{0,40}$/i;

/** One line for an email nobody summarised: its first sentence after the greeting. */
export function firstLine(raw: string): string {
  const body = emailParagraphs(raw).flatMap((p) => p.split("\n")).map((l) => l.trim()).filter((l) => l && !GREETING.test(l));
  const line = body[0] ?? "";
  return line.length > 160 ? `${line.slice(0, 159).trimEnd()}…` : line;
}

