/**
 * Chat artifacts: a fenced ```artifact block names a durable object that the
 * workspace opens in a content tab. Mail drafts live in `mail_message`
 * (state 'draft'); mail messages (`mail_message`) are any logged email, either
 * direction. The block only carries the reference, never the copy.
 */

export type ArtifactRef = { kind: "mail_draft"; id: string; title?: string } | { kind: "mail_message"; id: string; title?: string };

export type ArtifactSegment =
  | { type: "text"; text: string }
  | { type: "artifact"; artifact: ArtifactRef };

const FENCE = /```artifact\s*\n([\s\S]*?)```/g;
const ID = /^[A-Za-z0-9_-]{1,80}$/;
export const MAIL_DRAFT_PATH_PREFIX = "~mail/draft/";
export const MAIL_MESSAGE_PATH_PREFIX = "~mail/message/";

export function hasArtifactBlocks(text: string): boolean {
  return text.includes("```artifact");
}

export function parseArtifactRef(raw: string): ArtifactRef | null {
  try {
    const value = JSON.parse(raw) as { kind?: unknown; id?: unknown; title?: unknown };
    if ((value.kind !== "mail_draft" && value.kind !== "mail_message") || typeof value.id !== "string" || !ID.test(value.id)) {return null;}
    const title = typeof value.title === "string" ? value.title.trim().slice(0, 120) : "";
    return { kind: value.kind, id: value.id, ...(title ? { title } : {}) };
  } catch {
    return null;
  }
}

/** Split text into prose and artifact references. Invalid blocks stay as text. */
export function splitArtifactBlocks(text: string): ArtifactSegment[] {
  const segments: ArtifactSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(FENCE)) {
    const before = text.slice(last, match.index);
    if (before.trim()) {segments.push({ type: "text", text: before });}
    const artifact = parseArtifactRef(match[1]);
    segments.push(artifact ? { type: "artifact", artifact } : { type: "text", text: match[0] });
    last = (match.index ?? 0) + match[0].length;
  }
  const rest = text.slice(last);
  if (rest.trim()) {segments.push({ type: "text", text: rest });}
  return segments;
}

export function mailDraftPath(id: string): string {
  return `${MAIL_DRAFT_PATH_PREFIX}${id}`;
}

export function parseMailDraftPath(path: string): string | null {
  if (!path.startsWith(MAIL_DRAFT_PATH_PREFIX)) {return null;}
  const id = path.slice(MAIL_DRAFT_PATH_PREFIX.length);
  return ID.test(id) ? id : null;
}

export function mailMessagePath(id: string): string {
  return `${MAIL_MESSAGE_PATH_PREFIX}${id}`;
}

export function parseMailMessagePath(path: string): string | null {
  if (!path.startsWith(MAIL_MESSAGE_PATH_PREFIX)) {return null;}
  const id = path.slice(MAIL_MESSAGE_PATH_PREFIX.length);
  return ID.test(id) ? id : null;
}
