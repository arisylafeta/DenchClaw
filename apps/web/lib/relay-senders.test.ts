import { describe, expect, it } from "vitest";
import { isSenderKey, isTeamSender, senderRefusal, SENDERS, swapSignOff } from "./relay-senders";

describe("Relay senders", () => {
  it("offers alex@, supply@, buy@ and hello@ and nothing else", () => {
    expect(SENDERS.map((sender) => sender.address)).toEqual(["alex@rebattery.io", "supply@rebattery.io", "buy@rebattery.io", "hello@rebattery.io"]);
    expect(isSenderKey("hello")).toBe(true);
    expect(isSenderKey("sean")).toBe(false);
    expect(isSenderKey(null)).toBe(false);
  });
  it("says what to do when Gmail cannot send as the address, and leaves unknown refusals alone", () => {
    expect(senderRefusal("gmail_send_as_missing", "buy@rebattery.io")).toContain('Gmail can\'t send as buy@rebattery.io yet');
    expect(senderRefusal("content_policy", "buy@rebattery.io")).toBeNull();
  });
  it("treats supply@ and buy@ as team inboxes, Alex's own addresses as his", () => {
    expect(isTeamSender("supply")).toBe(true);
    expect(isTeamSender("buy")).toBe(true);
    expect(isTeamSender("alex")).toBe(false);
    expect(isTeamSender("hello")).toBe(false);
    expect(isTeamSender(null)).toBe(false);
  });
  it("swaps the name under the closing line between Alex and the team, and nothing else", () => {
    expect(swapSignOff("Hi Tom,\n\nThanks.\n\nBest,\nAlex", true)).toBe("Hi Tom,\n\nThanks.\n\nBest,\nThe ReBattery team");
    expect(swapSignOff("Hi Tom,\n\nThanks.\n\nKind regards,\nThe ReBattery team\n", false)).toBe("Hi Tom,\n\nThanks.\n\nKind regards,\nAlex");
    expect(swapSignOff("Hi Tom,\n\nBest,\nSam", true)).toBe("Hi Tom,\n\nBest,\nSam");
    expect(swapSignOff("Hi Tom,\n\nThanks, Alex", true)).toBe("Hi Tom,\n\nThanks, Alex");
    expect(swapSignOff("Best,\nAlex", true)).toBe("Best,\nThe ReBattery team");
  });
});
