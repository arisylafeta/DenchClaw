import { describe, expect, it } from "vitest";
import {
  activeBulkTradesTab, buildBulkTradesUrl, carryBulkTradesParams, isBulkTradesHref, isTradesPreviewHref, parseBulkTradesRoute,
  parseTradeListingPath, tradeListingPath,
} from "./bulk-trades-url";

describe("bulk trades URLs", () => {
  it("uses listing links in Preview and resolves legacy record links without changing the original page", () => {
    for (const key of ["trade", "demand", "supply"]) {
      expect(parseBulkTradesRoute(`path=~trades-preview&${key}=bulk-1`).listing).toBe("bulk-1");
      expect(parseBulkTradesRoute(`path=bulk_trade&${key}=bulk-1`).listing).toBeNull();
    }
    expect(parseBulkTradesRoute("path=~trades-preview&listing=new&trade=old").listing).toBe("new");
    const url = buildBulkTradesUrl({ listing: "bulk-1" }, undefined, "~trades-preview");
    expect(isTradesPreviewHref(url)).toBe(true);
    expect(parseBulkTradesRoute(new URL(url, "https://x.test").searchParams).listing).toBe("bulk-1");
    expect(carryBulkTradesParams("path=%7Etrades-preview", "path=~trades-preview&listing=bulk-1"))
      .toBe("path=%7Etrades-preview&listing=bulk-1");
    expect(carryBulkTradesParams("path=bulk_trade", "path=~trades-preview&listing=bulk-1")).toBe("path=bulk_trade");
  });
  it("round-trips records and filters through one builder and parser", () => {
    const url = buildBulkTradesUrl({ tab: "demand", status: "closed", category: "offer_reply", query: "r3 robotics" });
    expect(url).toBe("/?path=bulk_trade&tab=demand&status=closed&q=r3+robotics&category=offer_reply");
    expect(parseBulkTradesRoute(new URL(url, "https://x.test").searchParams)).toMatchObject({
      tab: "demand", status: "closed", category: "offer_reply", query: "r3 robotics", demand: null,
    });
    expect(buildBulkTradesUrl({ demand: "dm 1" })).toBe("/?path=bulk_trade&demand=dm+1");
    expect(buildBulkTradesUrl()).toBe("/?path=bulk_trade");
  });

  it("keeps shell state when the page writes its own params", () => {
    const current = new URLSearchParams("path=bulk_trade&tab=demand&terminal=1&browse=%2Ftmp&hidden=1&chat=x");
    expect(buildBulkTradesUrl({ tab: "demand", query: "a" }, current))
      .toBe("/?path=bulk_trade&terminal=1&browse=%2Ftmp&hidden=1&tab=demand&q=a");
  });

  it("a selected record implies its tab, an unknown tab is ignored", () => {
    const fallback = "trades";
    expect(activeBulkTradesTab(parseBulkTradesRoute("demand=1"), fallback)).toBe("demand");
    expect(activeBulkTradesTab(parseBulkTradesRoute("supply=1&tab=demand"), fallback)).toBe("supply");
    expect(activeBulkTradesTab(parseBulkTradesRoute("tab=bogus"), fallback)).toBe("trades");
  });

  it("recognises Bulk Trades links only", () => {
    expect(isBulkTradesHref("/?path=bulk_trade&demand=1")).toBe(true);
    expect(isBulkTradesHref("/?path=people")).toBe(false);
    expect(isBulkTradesHref("/?chat=abc")).toBe(false);
  });

  it("the shell keeps Bulk Trades params when it re-projects the same page, and drops them elsewhere", () => {
    const current = "path=bulk_trade&demand=dm_1&status=closed&terminal=1";
    expect(carryBulkTradesParams("path=bulk_trade&terminal=1", current)).toBe("path=bulk_trade&terminal=1&demand=dm_1&status=closed");
    expect(carryBulkTradesParams("path=people", current)).toBe("path=people");
    expect(carryBulkTradesParams("path=bulk_trade", "path=people&demand=1")).toBe("path=bulk_trade");
  });

  it("preview links stay on their own page and never mix with Bulk Trades links", () => {
    expect(buildBulkTradesUrl({ demand: "d1", side: "buyer" }, undefined, "~trades-preview")).toBe("/?path=%7Etrades-preview&listing=d1&side=buyer");
    expect(isTradesPreviewHref("/?path=%7Etrades-preview&demand=d1")).toBe(true);
    expect(isTradesPreviewHref("/?path=bulk_trade&demand=d1")).toBe(false);
    expect(isBulkTradesHref("/?path=%7Etrades-preview&demand=d1")).toBe(false);
    expect(carryBulkTradesParams("path=%7Etrades-preview", "path=%7Etrades-preview&demand=d1")).toBe("path=%7Etrades-preview&demand=d1");
    expect(carryBulkTradesParams("path=bulk_trade", "path=%7Etrades-preview&demand=d1")).toBe("path=bulk_trade");
  });
});

describe("listing tab paths", () => {
  it("round-trips ids, including the colon in a split listing id", () => {
    for (const id of ["bulk-panasonic-oklahoma", "btd_fcbebcc3-a080-44ec-be85-d16c262085de:ioniq5"]) {
      expect(parseTradeListingPath(tradeListingPath(id))).toBe(id);
    }
  });
  it("rejects other paths and unsafe ids", () => {
    expect(parseTradeListingPath("~trades-preview")).toBeNull();
    expect(parseTradeListingPath("~trades-preview/listing/")).toBeNull();
    expect(parseTradeListingPath("~trades-preview/listing/a/b")).toBeNull();
    expect(parseTradeListingPath("~mail/message/abc")).toBeNull();
  });
});

