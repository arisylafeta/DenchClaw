import { canViewConversation, sourceSection, type HermesConversation } from "./hermes-conversations";

/**
 * single: one main session per bot (personal: one per user; shared: one for the team). Opening the bot continues it.
 * multi: ordinary chats; opening the bot starts a new one.
 */
export type BotMode = "single" | "multi";
export type BotScope = "personal" | "shared";
export type BotConfig = { mode: BotMode; scope: BotScope };

const BOTS: Record<string, BotConfig> = {
  sorcerer: { mode: "single", scope: "personal" },
  papajules: { mode: "single", scope: "personal" },
};
const MULTI: BotConfig = { mode: "multi", scope: "personal" };

export function botConfig(profile: string): BotConfig {
  return Object.hasOwn(BOTS, profile) ? BOTS[profile] : MULTI;
}

/**
 * The bot's main session: its newest ordinary chat in the bot's scope. Compression continues a session under a newer id,
 * so the newest chat is also the tip of the main session's chain. Scheduled, messaging and group sessions never qualify.
 */
export function mainSession(rows: HermesConversation[], profile: string, userId: string | null | undefined): HermesConversation | null {
  const { mode, scope } = botConfig(profile);
  if (mode !== "single") return null;
  let main: HermesConversation | null = null;
  for (const row of rows) {
    if (row.kind !== "solo" || row.profile !== profile || sourceSection(row).key !== "chats" || !canViewConversation(row, userId)) continue;
    const inScope = scope === "shared" ? row.access?.visibility === "team" : row.access?.visibility === "private" && !!userId && row.access.ownerId === userId;
    if (inScope && (!main || row.updatedAt > main.updatedAt)) main = row;
  }
  return main;
}

export type BotEntry = { profile: string; config: BotConfig; main: HermesConversation | null };

/** Every bot the user can talk to: single bots first, then multi, each alphabetical. */
export function botEntries(profiles: string[], rows: HermesConversation[], userId: string | null | undefined): BotEntry[] {
  return [...new Set(profiles)]
    .map((profile) => ({ profile, config: botConfig(profile), main: mainSession(rows, profile, userId) }))
    .sort((a, b) => Number(a.config.mode !== "single") - Number(b.config.mode !== "single") || a.profile.localeCompare(b.profile));
}
