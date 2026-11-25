import { canViewConversation, sourceSection, type HermesConversation } from "./hermes-conversations";

/**
 * single: one main session per bot (personal: one per user; shared: one for the team). Opening the bot continues it.
 * multi: ordinary chats; opening the bot starts a new one.
 */
export type BotMode = "single" | "multi";
export type BotScope = "personal" | "shared";
export type BotConfig = { mode: BotMode; scope: BotScope; name?: string };

const BOTS: Record<string, BotConfig> = {
  sorcerer: { mode: "single", scope: "personal", name: "Sourcing Requests" },
  papajules: { mode: "single", scope: "personal", name: "Jules Watcher" },
  dismantlercampaigns: { mode: "single", scope: "personal", name: "Dismantler Campaigns" },
  auctions: { mode: "single", scope: "personal", name: "Auctions" },
  // Ordinary chats (New chat starts a fresh one); the name keeps its display label.
  enricho: { mode: "multi", scope: "personal", name: "Enricho" },
  recyclops: { mode: "single", scope: "personal", name: "Recycling Requests" },
};
const MULTI: BotConfig = { mode: "multi", scope: "personal" };

/** Display name for a bot; the Hermes profile id (and its sessions) stays the same. */
export function botName(profile: string): string {
  return botConfig(profile).name ?? profile;
}

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

/** The Bots section: single-session bots only, alphabetical. Multi bots are started from New chat. */
export function botEntries(profiles: string[], rows: HermesConversation[], userId: string | null | undefined): BotEntry[] {
  return [...new Set(profiles)]
    .filter((profile) => botConfig(profile).mode === "single")
    .map((profile) => ({ profile, config: botConfig(profile), main: mainSession(rows, profile, userId) }))
    .sort((a, b) => botName(a.profile).localeCompare(botName(b.profile)));
}
