import { describe, expect, it } from "vitest";
import {
  buildBulkTradesUrl, carryBulkTradesParams, isBulkTradesHref, parseBulkTradesRoute,
} from "./bulk-trades-url";

describe("bulk trades URLs", () => {
  it("round-trips records and filters through one builder and parser", () => {
    const url = buildBulkTradesUrl({ side: "buyer", progress: "Closing", company: "R3 Robotics", category: "packs", query: "r3 robotics" });
    expect(url).toBe("/?path=bulk_trade&q=r3+robotics&side=buyer&progress=Closing&company=R3+Robotics&category=packs");
    expect(parseBulkTradesRoute(new URL(url, "https://x.test").searchParams)).toMatchObject({
      side: "buyer", progress: "Closing", company: "R3 Robotics", category: "packs", query: "r3 robotics", demand: null,
    });
    expect(buildBulkTradesUrl({ demand: "dm 1" })).toBe("/?path=bulk_trade&demand=dm+1");
    expect(buildBulkTradesUrl()).toBe("/?path=bulk_trade");
  });

  it("keeps shell state when the page writes its own params", () => {
    const current = new URLSearchParams("path=bulk_trade&tab=demand&terminal=1&browse=%2Ftmp&hidden=1&chat=x");
    expect(buildBulkTradesUrl({ tab: "demand", query: "a" }, current))
      .toBe("/?path=bulk_trade&terminal=1&browse=%2Ftmp&hidden=1&tab=demand&q=a");
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
});
