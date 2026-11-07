import { describe, expect, it } from "vitest";
import { dealResultFits, dealSummaryText, ownsDeal, replyIdentity, suggestDealAction, threadInbox } from "./relay-identity";

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
    const text = dealSummaryText({ ...colvert, context: { listing_title: "15x Renault Zoe for Colvert SAS" } }, "gintas@gtvgroup.lt");
    expect(text).toContain("title: 15x Renault Zoe for [the other side] SAS");
    expect(text).toContain("quantity: 15 packs");
    for (const secret of ["Colvert", "colvert.eu", "25", "Montpellier", "Max EUR"]) expect(text).not.toContain(secret);
  });
  it("never falls back to the summary, which can carry the buyer's budget and site", () => {
    const row = { ...colvert, context: {}, summary: "Battery Partners, Leeds: automotive packs at €10-15/kWh, up to €20/kWh" };
    const text = dealSummaryText(row, "gintas@gtvgroup.lt");
    for (const secret of ["Leeds", "€", "20/kWh", "Battery Partners"]) expect(text).not.toContain(secret);
  });
  it("drops a hand-written title that names a price", () => {
    const text = dealSummaryText({ ...colvert, context: { listing_title: "15x Zoe up to EUR 2,000 a pack" } }, "gintas@gtvgroup.lt");
    expect(text).not.toContain("2,000");
  });
  it("tells the draft to keep the owner's facts out of other emails", () => {
    expect(dealSummaryText(colvert, "thomas@colvert.eu")).toMatch(/^Private to this deal's owner/);
  });
});

describe("ownsDeal with personal and ISP mail", () => {
  it("never matches two people on the same personal or ISP domain", () => {
    for (const d of ["btinternet.com", "sky.com", "wp.pl", "gmail.com"]) expect(ownsDeal(`buyer@${d}`, `seller@${d}`)).toBe(false);
  });
});

describe("threadInbox and suggestDealAction", () => {
  it("picks the inbox on the thread, and the contact's side when both are", () => {
    expect(threadInbox(true, false)).toBe("supply");
    expect(threadInbox(false, true)).toBe("buy");
    expect(threadInbox(true, true, "buyer")).toBe("buy");
    expect(threadInbox(true, true, "supplier")).toBe("supply");
    expect(threadInbox(false, false)).toBeNull();
  });
  const email = (bulk_listing_id: string | null, contact_type: string | null, direction: string | null) => ({ bulk_listing_id, contact_type, last_message: { direction } });
  it("offers Create deal on a seller or buyer email with no deal", () => {
    expect(suggestDealAction(email(null, null, "inbound"), "supply")).toBe("create");
    expect(suggestDealAction(email(null, "buyer", "inbound"), null)).toBe("create");
    expect(suggestDealAction(email(null, "logistics", "inbound"), null)).toBeNull();
  });
  it("offers Update deal only when their reply is the newest message", () => {
    expect(suggestDealAction(email("btd_1", "supplier", "inbound"), "supply")).toBe("update");
    expect(suggestDealAction(email("btd_1", "supplier", "outbound"), "supply")).toBeNull();
  });
});

describe("deal buttons after Matcha has run", () => {
  const email = { bulk_listing_id: "btd_1", contact_type: "supplier", last_message: { direction: "inbound", at: "2026-11-07T10:00:00Z" } };
  it("hides the button while Matcha works, and after a run newer than their last message", () => {
    expect(suggestDealAction(email, "supply", { status: "running", created_at: "2026-11-07T10:05:00Z" })).toBeNull();
    expect(suggestDealAction(email, "supply", { status: "done", created_at: "2026-11-07T10:05:00Z" })).toBeNull();
  });
  it("offers it again when they write after Matcha's last run, or after a failure", () => {
    expect(suggestDealAction(email, "supply", { status: "done", created_at: "2026-11-07T09:00:00Z" })).toBe("update");
    expect(suggestDealAction(email, "supply", { status: "failed", created_at: "2026-11-07T10:05:00Z" })).toBe("update");
  });
});

describe("dealResultFits", () => {
  const base = { listingId: "btd_9", currentListingId: null, threadLinked: false, ownerEmail: null, counterpartEmail: "sam@breakers.co.uk" };
  it("refuses a listing that isn't this email's", () => {
    expect(dealResultFits(base)).toBe(false);
    expect(dealResultFits({ ...base, ownerEmail: "thomas@colvert.eu" })).toBe(false);
  });
  it("accepts the current deal, a thread-tagged one, or one the sender owns", () => {
    expect(dealResultFits({ ...base, currentListingId: "btd_9" })).toBe(true);
    expect(dealResultFits({ ...base, threadLinked: true })).toBe(true);
    expect(dealResultFits({ ...base, ownerEmail: "sam@breakers.co.uk" })).toBe(true);
  });
});

describe("isPersonalDomain", () => {
  it("treats personal and UK ISP mail as never a company", async () => {
    const { isPersonalDomain } = await import("./relay-identity");
    for (const d of ["gmail.com", "btinternet.com", "sky.com", "virginmedia.com", "BTINTERNET.COM"]) expect(isPersonalDomain(d)).toBe(true);
    expect(isPersonalDomain("donkersvagparts.nl")).toBe(false);
  });
});
