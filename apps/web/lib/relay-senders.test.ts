import { describe, expect, it } from "vitest";
import { isSenderKey, senderRefusal, SENDERS } from "./relay-senders";

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
});
