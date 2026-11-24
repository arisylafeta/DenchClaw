import { expect, it } from "vitest";
import { applyChatView as applyView, conversationKey, DEFAULT_VIEW, filterConversations, parseChatView, type HermesConversation } from "./hermes-conversations";
const applyChatView = (...args: Parameters<typeof applyView>) => applyView(args[0], args[1], args[2], args[3], "user-a");
const row = (source: string, profile = "alpha"): HermesConversation => ({ access: { visibility: source === "web" ? "private" : "team", ownerId: source === "web" ? "user-a" : null, canShare: source === "web", canDelete: source === "web", canWrite: true, canApprove: true }, key: conversationKey("solo", source, profile), id: source, kind: "solo", profile, source, title: source, updatedAt: 100, participants: [{ profile, name: profile }], working: false });
it("shows only Pinned, My chats, Groups and Shared, keeps group chats in their own section and emits each key once", () => {
  const rows = [row("cron"), row("whatsapp"), row("discord"), row("web"), row("crm", "beta"), row("telegram"), row("gmail-triage"), { ...row("group"), kind: "group" as const }];
  const view = { ...DEFAULT_VIEW, pins: [rows[4].key] };
  const result = applyChatView([...rows, rows[3]], view, "");
  expect(result.sections.map((s) => s.label)).toEqual(["Pinned", "My chats", "Groups"]);
  expect(result.sections.map((s) => s.rows.map((r) => r.source))).toEqual([["crm"], ["web"], ["group"]]);
  expect(applyChatView(filterConversations(rows, "beta"), { ...view, pins: [] }, "").sections.map((s) => s.label)).toEqual(["Shared"]);
});
it("finds scheduled, messaging and integration sessions only through search", () => {
  const rows = [row("cron"), row("discord"), row("oneshot"), row("web")];
  expect(applyChatView(rows, DEFAULT_VIEW, "").shown).toBe(1);
  const found = applyChatView(rows, DEFAULT_VIEW, "discord");
  expect(found.sections.map((s) => [s.label, s.rows.map((r) => r.source)])).toEqual([["Shared", ["discord"]]]);
});
it("keeps readable stored views and falls back on malformed ones", () => {
  expect(parseChatView({ hidden: ["discord"], groupBy: "none" })).toEqual({ ...DEFAULT_VIEW, hidden: ["discord"] });
  expect(parseChatView({ hidden: "cron", groupBy: "invalid" })).toEqual(DEFAULT_VIEW);
  expect(parseChatView(null)).toEqual(DEFAULT_VIEW);
});
it("sorts inside sections, keeping pins first and missing projects last without text inference", () => {
  const rows = [
    { ...row("web"), key: "unknown", updatedAt: 500, title: "Beacon project" },
    { ...row("web"), key: "beacon-old", project: "Beacon", updatedAt: 100 },
    { ...row("web"), key: "harbour", project: "Harbour", updatedAt: 400 },
    { ...row("web"), key: "beacon-new", project: "Beacon", updatedAt: 200 },
  ];
  const view = { ...DEFAULT_VIEW, pins: ["harbour"] };
  const recent = applyChatView(rows, view, "");
  expect(recent.sections.map((s) => s.label)).toEqual(["Pinned", "My chats"]);
  expect(recent.sections[1].rows.map((r) => r.key)).toEqual(["unknown", "beacon-new", "beacon-old"]);
  const project = applyChatView([...rows, rows[2]], { ...view, sortBy: "project" }, "");
  expect(project.sections[1].rows.map((r) => r.key)).toEqual(["beacon-new", "beacon-old", "unknown"]);
  expect(project.sections.flatMap((s) => s.rows)).toHaveLength(rows.length);
  expect(applyChatView(rows, { ...view, sortBy: "project", pins: [] }, "").sections[0].rows.map((r) => r.key)).toEqual(["beacon-new", "beacon-old", "harbour", "unknown"]);
  expect(parseChatView({ ...view, sortBy: "project" }).sortBy).toBe("project");
  expect(parseChatView({ ...view, sortBy: "broken" }).sortBy).toBe("recent");
});
