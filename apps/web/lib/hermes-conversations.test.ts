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
it("keeps Day and Agent section order when project order differs from recency", () => {
  const now = new Date(2026, 9, 18, 12);
  const rows = [
    { ...row("web", "recent-agent"), project: "Zulu", updatedAt: now.getTime() },
    { ...row("web", "old-agent"), project: "Alpha", updatedAt: new Date(2026, 0, 1).getTime() },
  ];
  for (const groupBy of ["day", "agent"] as const) {
    const view = { ...DEFAULT_VIEW, groupBy };
    const recent = applyChatView(rows, view, "", now);
    const project = applyChatView(rows, { ...view, sortBy: "project" }, "", now);
    expect(project.sections.map(section => section.label)).toEqual(recent.sections.map(section => section.label));
    expect(project.sections[0].rows[0].profile).toBe("recent-agent");
  }
});
it("preserves legacy explicit hiding and migrates only the old ungrouped default", () => {
  expect(parseChatView({ hidden: ["discord", "cron", "webhook"], groupBy: "none" })).toEqual({ ...DEFAULT_VIEW, hidden: ["discord", "cron", "webhook"] });
  expect(parseChatView({ hidden: [], groupBy: "day" }).groupBy).toBe("day");
  expect(parseChatView({ hidden: "cron", groupBy: "invalid" })).toEqual(DEFAULT_VIEW);
  expect(parseChatView(null)).toEqual(DEFAULT_VIEW);
});
it("sorts inside existing sections, keeping pins first and missing projects last without text inference", () => {
  const rows = [
    { ...row("web"), key: "unknown", updatedAt: 500, title: "Beacon project" },
    { ...row("web"), key: "beacon-old", project: "Beacon", updatedAt: 100 },
    { ...row("web"), key: "harbour", project: "Harbour", updatedAt: 400 },
    { ...row("web"), key: "beacon-new", project: "Beacon", updatedAt: 200 },
    { ...row("discord"), project: "Beacon", updatedAt: 600 },
    { ...row("cron"), project: "Beacon", updatedAt: 700 },
  ];
  const view = { ...DEFAULT_VIEW, pins: ["harbour"] };
  const recent = applyChatView(rows, view, "");
  expect(recent.sections.map((s) => s.label)).toEqual(["Pinned", "Chats", "Discord", "Automation"]);
  expect(recent.sections[1].rows.map((r) => r.key)).toEqual(["unknown", "beacon-new", "beacon-old"]);
  const project = applyChatView([...rows, rows[2]], { ...view, sortBy: "project" }, "");
  expect(project.sections.map((s) => s.label)).toEqual(recent.sections.map((s) => s.label));
  expect(project.sections[1].rows.map((r) => r.key)).toEqual(["beacon-new", "beacon-old", "unknown"]);
  expect(project.sections.flatMap((s) => s.rows)).toHaveLength(rows.length);
  expect(applyChatView(rows, { ...view, sortBy: "project", pins: [] }, "").sections[0].rows.map((r) => r.key)).toEqual(["beacon-new", "beacon-old", "harbour", "unknown"]);
  expect(parseChatView({ ...view, sortBy: "project" }).sortBy).toBe("project");
  expect(parseChatView({ ...view, sortBy: "broken" }).sortBy).toBe("recent");
});
