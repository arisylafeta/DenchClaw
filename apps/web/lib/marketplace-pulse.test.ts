import { describe, expect, it } from "vitest";
import { opener, type FollowUpSignal } from "./marketplace-pulse";

const signal = (kind: FollowUpSignal["kind"], status: string): FollowUpSignal =>
  ({ kind, status, text: "", listing_title: null, listing_url: null, at: "2026-10-01T00:00:00Z" });

describe("opener", () => {
  it("says what actually happened to the offer or deal", () => {
    expect(opener(signal("offer", "rejected"), "Kia packs")).toBe("I saw your offer on the Kia packs on ReBattery wasn't accepted.");
    expect(opener(signal("offer", "countered"), "Kia packs")).toBe("I saw the seller came back with a counter-offer on the Kia packs on ReBattery.");
    expect(opener(signal("offer", "expired"), "Kia packs")).toBe("I saw your offer on the Kia packs on ReBattery expired before you got an answer.");
    expect(opener(signal("deal", "payment_pending"), "Kia packs")).toBe("I saw your order for the Kia packs on ReBattery is still waiting on payment.");
    expect(opener(signal("deal", "cancelled"), "Kia packs")).toBe("I saw your order for the Kia packs on ReBattery was cancelled before payment.");
  });
});
