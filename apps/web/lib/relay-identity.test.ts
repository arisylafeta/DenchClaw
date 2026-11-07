import { describe, expect, it } from "vitest";
import { dealSummaryText, ownsDeal, replyIdentity } from "./relay-identity";

const inbound = (to: string[], cc: string[] = [], identity_key: string | null = null) => ({ direction: "inbound", to_emails: to, cc_emails: cc, identity_key });
const outbound = (identity_key: string | null) => ({ direction: "outbound", to_emails: ["x@seller.com"], cc_emails: [], identity_key });

describe("replyIdentity", () => {
  it("replies as supply@ when the seller wrote to supply@", () => {
    expect(replyIdentity([inbound(["supply@rebattery.io"])])).toBe("supply");
  });
  it("replies as buy@ when the buyer wrote to buy@, in To or Cc", () => {
    expect(replyIdentity([inbound(["Buy@ReBattery.io"])])).toBe("buy");
    expect(replyIdentity([inbound(["alex@rebattery.io"], ["buy@rebattery.io"])])).toBe("buy");
  });
  it("uses the contact's side when both inboxes are on the thread", () => {
    const both = [inbound(["supply@rebattery.io"], ["buy@rebattery.io"])];
    expect(replyIdentity(both, "buyer")).toBe("buy");
    expect(replyIdentity(both, "supplier")).toBe("supply");
    expect(replyIdentity(both, null)).toBe("supply");
  });
  it("keeps the inbox we last wrote from when the latest reply drops it", () => {
    expect(replyIdentity([inbound(["alex@rebattery.io"]), outbound("buy")])).toBe("buy");
    expect(replyIdentity([inbound(["alex@rebattery.io"]), outbound("supply")])).toBe("supply");
  });
  it("is Alex when neither shared inbox is involved", () => {
    expect(replyIdentity([inbound(["alex@rebattery.io"]), outbound("alex")])).toBe("alex");
    expect(replyIdentity([])).toBe("alex");
  });
});

describe("ownsDeal", () => {
  it("matches the address or a company domain, never a free-mail domain", () => {
    expect(ownsDeal("thomas@colvert.eu", "Thomas@colvert.eu")).toBe(true);
    expect(ownsDeal("thomas@colvert.eu", "ops@colvert.eu")).toBe(true);
    expect(ownsDeal("dave@gmail.com", "sam@gmail.com")).toBe(false);
    expect(ownsDeal("thomas@colvert.eu", "gintas@gtvgroup.lt")).toBe(false);
    expect(ownsDeal(null, "gintas@gtvgroup.lt")).toBe(false);
  });
});

describe("dealSummaryText", () => {
  const colvert = {
    id: "btd_1", kind: "demand", party: "Colvert", email: "thomas@colvert.eu", owner_email: "thomas@colvert.eu",
    summary: "15x Renault Zoe 41-52kWh for Colvert", quantity: "15 packs", location: "Montpellier, France", note: "Max EUR 25/kWh",
    max_price: 25, context: { listing_title: "15x Renault Zoe 41-52kWh" }, created_at: "2026-11-04",
  };
  it("gives the deal's owner the whole record", () => {
    const text = dealSummaryText(colvert, "thomas@colvert.eu");
    expect(text).toContain("max_price: 25");
    expect(text).toContain("party: Colvert");
    expect(text).not.toContain("owner_email");
  });
  it("gives a supplier on the deal only what it is, with no buyer, price, note or site", () => {
    const text = dealSummaryText({ ...colvert, context: {} }, "gintas@gtvgroup.lt");
    expect(text).toContain("15x Renault Zoe 41-52kWh for [the other side]");
    expect(text).toContain("quantity: 15 packs");
    for (const secret of ["Colvert", "colvert.eu", "25", "Montpellier", "Max EUR"]) expect(text).not.toContain(secret);
  });
});
