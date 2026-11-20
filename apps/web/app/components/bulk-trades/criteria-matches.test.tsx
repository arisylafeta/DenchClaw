// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MatchesResult } from "@/lib/matches-types";
import { TEST_REGISTRY } from "@/lib/bulk-registry.fixture";
import { MatchesTab } from "./matches-list";
import { forgetShared } from "./trade-ui";

const payload = (lots: number, chemistries: string[]): MatchesResult => ({
  id: "btd_1", kind: "demand", lotKey: { line: "Prismatic cells", full: ["Matched on LFP"], open: false },
  criteria: { spec: { formats: ["Cells"], chemistries }, max_price: null, price_currency: null, price_unit: null, volume: null, volume_unit: null, location: "Ukraine" },
  rows: [], considered: 0, blocked: null, errors: [],
  summary: { chips: [{ label: "Prismatic cells", strong: true }], outreach: null, count: { suppliers: 15, units: lots, word: "lots" }, packTypes: null, grouped: true },
});

describe("editable Criteria on the Matches tab", () => {
  afterEach(() => { vi.unstubAllGlobals(); forgetShared(); });

  it("opens the list in the card, hides the chips, shows the live count and the change after an edit", async () => {
    const user = userEvent.setup();
    const calls: { url: string; method: string; body?: string }[] = [];
    let lots = 377;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
      if (url === "/api/bulk-trades/registry") return new Response(JSON.stringify({ registry: TEST_REGISTRY }), { status: 200 });
      if (init?.method === "PATCH") { lots = 294; return new Response(JSON.stringify({ demand: { id: "btd_1" } }), { status: 200 }); }
      return new Response(JSON.stringify(payload(lots, lots === 377 ? ["NMC"] : ["NMC", "LFP"])), { status: 200 });
    }));
    const changed = vi.fn();
    render(<MatchesTab kind="demand" id="btd_1" active onDemandChanged={changed} />);
    await screen.findByText("Prismatic cells");
    await user.click(screen.getByRole("button", { name: /Criteria/ }));
    expect(screen.queryByText("Prismatic cells")).toBeNull(); // the chips step aside
    expect(screen.getByText(/377/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /^Chemistry: NMC/ }));
    await user.click(screen.getByRole("checkbox", { name: "LFP" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("−83")).toBeTruthy());
    const patch = calls.find((call) => call.method === "PATCH")!;
    expect(patch.url).toBe("/api/bulk-trades/demand/btd_1");
    expect(JSON.parse(patch.body!).spec).toEqual({ formats: ["Cells"], chemistries: ["NMC", "LFP"] });
    expect(changed).toHaveBeenCalled();
    expect(await screen.findByText("Chemistry saved · 294 lots")).toBeTruthy();
  });
});
