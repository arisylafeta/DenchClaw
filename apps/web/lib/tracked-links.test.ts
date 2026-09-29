import { afterEach, describe, expect, it } from "vitest";
import { isAutomatedVisit, linksIn, replaceLinks, trackedLinkBase } from "./tracked-links";

describe("tracked links", () => {
  afterEach(() => { delete process.env.BULK_TRADES_LINK_BASE; });

  it("is off until an https public base is configured", () => {
    expect(trackedLinkBase()).toBeNull();
    process.env.BULK_TRADES_LINK_BASE = "http://crm.example.test";
    expect(trackedLinkBase()).toBeNull();
    process.env.BULK_TRADES_LINK_BASE = "https://crm.example.test/some/path";
    expect(trackedLinkBase()).toBe("https://crm.example.test");
  });

  it("finds each link once, without trailing punctuation", () => {
    const body = "Auction: https://rebattery.io/a/ebs37. Specs (https://rebattery.io/a/ebs37/specs), again https://rebattery.io/a/ebs37";
    expect(linksIn(body)).toEqual(["https://rebattery.io/a/ebs37", "https://rebattery.io/a/ebs37/specs"]);
  });

  it("replaces links without breaking one that extends another", () => {
    const body = "See https://x.test/a and https://x.test/a/b.";
    const out = replaceLinks(body, new Map([["https://x.test/a", "T1"], ["https://x.test/a/b", "T2"]]));
    expect(out).toBe("See T1 and T2.");
  });

  it("does not count scanners, previews or HEAD requests as clicks", () => {
    const chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128.0 Safari/537.36";
    expect(isAutomatedVisit("GET", chrome)).toBe(false);
    expect(isAutomatedVisit("HEAD", chrome)).toBe(true);
    expect(isAutomatedVisit("GET", null)).toBe(true);
    expect(isAutomatedVisit("GET", "Mozilla/5.0 (compatible; Proofpoint URL Defense)")).toBe(true);
    expect(isAutomatedVisit("GET", "Mozilla/5.0 (Windows NT 10.0) GoogleImageProxy")).toBe(true);
  });
});
