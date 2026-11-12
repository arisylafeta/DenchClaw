import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHASE_LINES, chaseDraft, chaseKey, chaseSubject, verifyChase } from "./relay-chase-core";

const thread = "Leaf packs\nHi Alex, we have Nissan Leaf packs in Leeds. Dana\nHi Dana, how many packs, and what state of health?";

describe("chase drafts", () => {
  it("are fixed parts: a greeting from the thread, one line per chase, Alex's sign-off", () => {
    expect(chaseDraft(1, "Dana", "Re: RE: Leaf packs")).toEqual({
      subject: "Re: Leaf packs",
      body: `Hi Dana,\n\n${CHASE_LINES[1]}\n\nBest,\nAlex`,
    });
    expect(chaseDraft(3, null, "").body.startsWith("Hello,\n\nOne last nudge")).toBe(true);
    expect(chaseSubject(null)).toBe("Re:");
  });

  it("carry no number, no price and no name of either side in their fixed lines", () => {
    for (const line of Object.values(CHASE_LINES)) {
      expect(line).not.toMatch(/\d|[£€$]|\bper\b/);
      expect(verifyChase(`Hi Dana,\n\n${line}\n\nBest,\nAlex`, thread, ["Motorgreen Ltd"])).toEqual({ ok: true });
    }
  });

  it("refuse a chase with a number the thread and the deal do not have", () => {
    expect(verifyChase("Hi Dana,\n\nCould you confirm the 40 packs?\n\nBest,\nAlex", thread, [])).toEqual({ ok: false, reason: "a number that is not in the thread or the deal" });
    expect(verifyChase("Hi Dana,\n\nCould you confirm by Friday?\n\nBest,\nAlex", thread, [])).toMatchObject({ ok: false, reason: expect.stringMatching(/^a day or month/) });
  });

  it("refuse a price, a greeting name not in the thread, and any name of the other side", () => {
    expect(verifyChase("Hi Dana,\n\nWe can do EUR on this.\n\nBest,\nAlex", thread, [])).toMatchObject({ ok: false, reason: "a price or a sum of money" });
    expect(verifyChase("Hi Mark,\n\nAny news?\n\nBest,\nAlex", thread, [])).toMatchObject({ ok: false, reason: "a name that is not in the thread: Mark" });
    expect(verifyChase("Hi Dana,\n\nMotorgreen is keen.\n\nBest,\nAlex", thread, ["Motorgreen"])).toMatchObject({ ok: false, reason: "names the other side: Motorgreen" });
  });

  it("are keyed by chase and unanswered message, so the same chase is prepared once", () => {
    expect(chaseKey(2, "2026-11-02T09:00:00+00:00")).toBe("[chase:2 since 2026-11-02T09:00:00+00:00]");
  });

  it("have no path to sending: the chase module never queues, schedules or sends", () => {
    for (const file of ["relay-chase.ts", "relay-chase-core.ts", "chase-clock.ts"]) {
      const source = readFileSync(join(__dirname, file), "utf8");
      // No send call, no send runner, no setting of a send-later ('{scheduled_send}'), no process started.
      expect(source).not.toMatch(/queueSend|scheduleSend|pinSend|relay_send|SEND_RUNNER|\{scheduled_send\}|--send|spawn\(|execFile/);
    }
  });
});
