export type ConversationSeen = { working: boolean; blocked: boolean; background: boolean };
/** done: the chat's own work is complete. subagents: it had handed off and its background subagents have now finished. */
export type TransitionKind = "input" | "done" | "subagents";

export const seenOf = (row: { working?: unknown; blocked?: unknown; background?: unknown }): ConversationSeen =>
  ({ working: row.working === true, blocked: row.blocked === true, background: row.background === true });

/**
 * The notification a listing refresh earns for one chat, or null. Shared by the in-page hook and the
 * server push watcher so both agree on what "finished" and "waiting for input" mean.
 * A turn that ends while subagents are still working is a handoff, not a finish: it stays silent and the
 * chat earns "subagents" once they are done (unless the parent resumes, which then ends as a normal "done").
 */
export function conversationTransition(
  was: ConversationSeen | undefined,
  row: { working?: unknown; blocked?: unknown; background?: unknown; source?: unknown },
): TransitionKind | null {
  if (!was || row.source === "cron") { return null; }
  const now = seenOf(row);
  if (!was.blocked && now.blocked) { return "input"; }
  if (now.working || now.blocked || now.background) { return null; }
  if (was.working && row.working === false) { return "done"; }
  if (was.background && row.background === false) { return "subagents"; }
  return null;
}
