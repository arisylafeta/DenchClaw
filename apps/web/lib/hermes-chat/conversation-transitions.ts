export type ConversationSeen = { working: boolean; blocked: boolean };
export type TransitionKind = "input" | "done";

/**
 * The notification a listing refresh earns for one chat, or null. Shared by the in-page hook and the
 * server push watcher so both agree on what "finished" and "waiting for input" mean.
 */
export function conversationTransition(
  was: ConversationSeen | undefined,
  row: { working?: unknown; blocked?: unknown; source?: unknown },
): TransitionKind | null {
  if (!was || row.source === "cron") { return null; }
  const now = { working: row.working === true, blocked: row.blocked === true };
  if (!was.blocked && now.blocked) { return "input"; }
  if (was.working && !now.working && !now.blocked && row.working === false) { return "done"; }
  return null;
}
