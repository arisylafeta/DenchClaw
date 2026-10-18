import { expect, it } from "vitest";
import { applyChatView, conversationKey, DEFAULT_VIEW, filterConversations, parseChatView, type HermesConversation } from "./hermes-conversations";
const row = (source: string, profile = "alpha"): HermesConversation => ({ key: conversationKey("solo", source, profile), id: source, kind: "solo", profile, source, title: source, updatedAt: 100, participants: [{ profile, name: profile }], working: false });
it("orders source sections, keeps native groups distinct and emits each composite key once", () => {
  const rows = [row("cron"), row("whatsapp"), row("discord"), row("web"), row("discord", "beta"), row("telegram"), { ...row("group"), kind: "group" as const }];
  const view = { ...DEFAULT_VIEW, pins: [rows[2].key] };
  const result = applyChatView([...rows, rows[2]], view, "");
  expect(result.sections.map((s) => s.label)).toEqual(["Pinned", "Chats", "Groups", "Discord", "WhatsApp", "Telegram", "Automation"]);
  const keys = result.sections.flatMap((s) => s.rows.map((r) => r.key));
  expect(new Set(keys).size).toBe(rows.length); expect(keys).toHaveLength(rows.length);
  expect(result.sections.find((s) => s.key === "discord")?.rows[0].profile).toBe("beta");
  expect(applyChatView(filterConversations(rows, "beta"), view, "").sections.map((s) => s.label)).toEqual(["Discord"]);
  expect(applyChatView(rows, { ...view, hidden: ["discord"] }, "").sections.some((s) => s.key === "pinned")).toBe(false);
  expect(applyChatView(rows, { ...view, pins: [] }, "").sections.find((s) => s.key === "discord")?.rows).toHaveLength(2);
});
it("preserves legacy explicit hiding and migrates only the old ungrouped default", () => {
  expect(parseChatView({ hidden: ["discord", "cron", "webhook"], groupBy: "none" })).toEqual({ ...DEFAULT_VIEW, hidden: ["discord", "cron", "webhook"] });
  expect(parseChatView({ hidden: [], groupBy: "day" }).groupBy).toBe("day");
  expect(parseChatView({ hidden: "cron", groupBy: "invalid" })).toEqual(DEFAULT_VIEW);
  expect(parseChatView(null)).toEqual(DEFAULT_VIEW);
});
