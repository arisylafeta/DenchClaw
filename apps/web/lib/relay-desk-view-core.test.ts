import { describe, expect, it } from "vitest";
import type { TalkTurn } from "./relay-talk";
import { chatPieces, clock, foundRun, keepPolling, openQuestion, pgTime, runState, workSummary, type DeskTalk, type Following } from "./relay-desk-view-core";

const read = { line: "", items: [] };
const alex = (id: string, text = "make it shorter"): TalkTurn => ({ id, role: "alex", text, target: "all", applied: null, created_at: "" });
const relay = (id: string, text = "Done."): TalkTurn => ({ id, role: "relay", text, target: "all", applied: null, created_at: "" });
const trace = (id: string, run: string, ms: number, text = "Searched your mail", more: { tool?: string; failed?: boolean } = {}): TalkTurn =>
  ({ id, role: "trace", text, target: "all", applied: { ms, read, notes: [], desk: { tool: more.tool ?? "mcp__claude_ai_Gmail__search_threads", run }, ...(more.failed ? { failed: true } : {}) }, created_at: "" });
const ask = (id: string, run: string | null, options = ["Sell at £5,040", "Pass"]): TalkTurn =>
  ({ id, role: "relay", text: "Sell the 62 kWh at Relay's price?", target: "all", applied: { ask: { question: "Sell the 62 kWh at Relay's price?", options, run } }, created_at: "" });
const talk = (turns: TalkTurn[], desk: DeskTalk["desk"] = null): DeskTalk => ({ turns, drafts: [], read, desk, claudeSession: null });
const following = (o: Partial<Following> = {}): Following => ({ runId: "r1", mode: "chat", text: "make it shorter", startedAt: 0, before: ["a0"], fromLoad: 3, ...o });
const active = (status: "queued" | "running" | "stopping" = "running") => ({ id: "r1", status, mode: "chat" as const, started_at: "2026-11-22 10:00:00+00" });

describe("where a desk turn stands", () => {
  it("counts as running until a load that began after the run comes back", () => {
    expect(runState(following(), talk([alex("a0")]), 3)).toEqual({ kind: "running", stopping: false });
    expect(runState(following(), null, 9)).toEqual({ kind: "running", stopping: false });
  });
  it("is running, or stopping, while the talk answer carries it", () => {
    expect(runState(following(), talk([alex("a0")], active("queued")), 4)).toEqual({ kind: "running", stopping: false });
    expect(runState(following(), talk([alex("a0")], active("stopping")), 4)).toEqual({ kind: "running", stopping: true });
  });
  it("reads how it ended from what it left in the chat", () => {
    const f = following();
    expect(runState(f, talk([alex("a0"), alex("a1"), trace("t1", "r1", 4000), relay("x1")]), 4)).toEqual({ kind: "done" });
    expect(runState(f, talk([alex("a0"), trace("t1", "r1", 4000), trace("t2", "r1", 9000, "Stopped.", { tool: "stop" })]), 4)).toEqual({ kind: "stopped" });
    expect(runState(f, talk([alex("a0"), trace("t2", "r1", 9000, "Something went wrong. Try again.", { tool: "error", failed: true })]), 4)).toEqual({ kind: "failed" });
    // A question with no other words is still the run's answer.
    expect(runState(f, talk([alex("a0"), ask("q1", "r1")]), 4)).toEqual({ kind: "done" });
    // The runner timed out: it says so in a relay turn, with no trace line.
    expect(runState(f, talk([alex("a0"), relay("x1", "I ran out of time")]), 4)).toEqual({ kind: "done" });
  });
  it("fails a run that left nothing (its runner never started), and ignores another run's lines", () => {
    expect(runState(following(), talk([alex("a0"), alex("a1")]), 4)).toEqual({ kind: "failed" });
    expect(runState(following({ before: ["a0", "x0"] }), talk([alex("a0"), relay("x0"), trace("t9", "r0", 1000, "Stopped.", { tool: "stop" })]), 4)).toEqual({ kind: "failed" });
  });
  it("a different active run doesn't keep the followed one alive", () => {
    expect(runState(following(), talk([alex("a0"), trace("t1", "r1", 1000)], { ...active(), id: "r2" }), 4)).toEqual({ kind: "done" });
  });
});

describe("the polling decision", () => {
  it("polls while the followed run is running and stops when it has ended", () => {
    expect(keepPolling(following(), talk([alex("a0")]), 3)).toBe(true);
    expect(keepPolling(following(), talk([alex("a0")], active()), 4)).toBe(true);
    expect(keepPolling(following(), talk([alex("a0"), trace("t1", "r1", 1000), relay("x1")]), 4)).toBe(false);
  });
  it("with nothing followed, polls only when the server shows a turn in progress", () => {
    expect(keepPolling(null, talk([]), 1)).toBe(false);
    expect(keepPolling(null, talk([], active()), 1)).toBe(true);
    expect(keepPolling(null, null, 0)).toBe(false);
  });
  it("picks up a run found on opening, timed from the server's start", () => {
    const now = Date.parse("2026-11-22T10:00:42Z");
    const f = foundRun(talk([alex("a0")], active()), 5, now)!;
    expect(f).toMatchObject({ runId: "r1", mode: "chat", text: "make it shorter", before: ["a0"], fromLoad: 4 });
    expect(now - f.startedAt).toBe(42_000);
    expect(runState(f, talk([alex("a0")], active()), 5).kind).toBe("running");
    expect(foundRun(talk([]), 5)).toBeNull();
    // A start in the future (clock skew) or a queued run with none counts from now.
    expect(foundRun(talk([], { ...active("queued"), started_at: null }), 5, now)!.startedAt).toBe(now);
  });
});

describe("times", () => {
  it("reads Postgres timestamptz text", () => {
    expect(pgTime("2026-11-22 10:15:02.123456+00")).toBe(Date.parse("2026-11-22T10:15:02.123Z"));
    expect(pgTime("2026-11-22 11:15:02+01")).toBe(Date.parse("2026-11-22T10:15:02Z"));
    expect(pgTime("2026-11-22 15:45:02+05:30")).toBe(Date.parse("2026-11-22T10:15:02Z"));
    expect(pgTime("not a time")).toBeNull();
    expect(pgTime(null)).toBeNull();
  });
  it("counts minutes and seconds", () => {
    expect(clock(42_400)).toBe("0:42");
    expect(clock(725_000)).toBe("12:05");
    expect(clock(-5)).toBe("0:00");
  });
});

describe("the question to dock", () => {
  it("is the newest question Alex hasn't answered", () => {
    expect(openQuestion([alex("a0"), ask("q1", "r1"), relay("x1", "Prices are in the reply.")])?.id).toBe("q1");
    expect(openQuestion([ask("q0", "r0"), alex("a1"), ask("q1", "r1")])?.id).toBe("q1");
  });
  it("is none once Alex has written, or when there is no question", () => {
    expect(openQuestion([ask("q1", "r1"), alex("a1", "Sell at £5,040")])).toBeNull();
    expect(openQuestion([alex("a0"), relay("x1")])).toBeNull();
    expect(openQuestion([])).toBeNull();
  });
});

describe("laying out the chat", () => {
  it("keeps one run's work lines together and leaves other turns alone", () => {
    const turns = [alex("a0"), trace("t1", "r1", 1000), trace("t2", "r1", 2000), relay("x1"), trace("t3", "r2", 500), { ...relay("old"), role: "trace" as const, applied: { ms: 900, read, notes: [] } }];
    const pieces = chatPieces(turns);
    expect(pieces.map((p) => (p.kind === "work" ? `work:${p.run}:${p.lines.length}` : p.turn.id))).toEqual(["a0", "work:r1:2", "x1", "work:r2:1", "old"]);
  });
  it("folds finished work to its time and steps", () => {
    expect(workSummary([trace("t1", "r1", 4000) as never, trace("t2", "r1", 102_000) as never])).toEqual({ text: "Worked for 1:42, 2 steps", failed: false });
    expect(workSummary([trace("t1", "r1", 4000) as never, trace("t2", "r1", 9000, "Stopped.", { tool: "stop" }) as never])).toEqual({ text: "Stopped after 0:09, 1 step", failed: false });
    expect(workSummary([trace("t2", "r1", 3000, "Something went wrong. Try again.", { tool: "error", failed: true }) as never])).toEqual({ text: "Went wrong after 0:03", failed: true });
  });
});
