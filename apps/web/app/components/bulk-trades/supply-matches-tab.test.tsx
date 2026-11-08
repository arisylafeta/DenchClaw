// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DemandMatchesTab } from "./demand-matches-tab";
import { SupplyMatchesTab } from "./supply-matches-tab";
import { forgetShared } from "./trade-ui";
import type { MatchGroupView, MatchesResult, MatchUnit } from "@/lib/matches-types";

const row = (o: Partial<MatchesResult["rows"][number]> = {}) => ({
  key: "company:c1", rank: 1, name: "Exigo", detail: "Last contact 2026-10-08",
  tags: [] as MatchesResult["rows"][number]["tags"], reason: "Same part number: 50 kWh Packs NMC",
  checks: ["No firm seller price"], price: "40/kWh against their 60/kWh (+50%)",
  offer: null, companyId: "c1", personId: "p1", contact: "buyer@exigo.test", stockId: null, ...o,
});

const result = (rows: MatchesResult["rows"], o: Partial<MatchesResult> = {}): MatchesResult => ({
  id: "bts_1", kind: "supply",
  lotKey: { line: "40 units · Toyota Proace · 50 kWh · Packs · NMC", full: ["40 units · Toyota Proace · 50 kWh · Packs · NMC", "Seller price EUR 40 per kWh"], open: false },
  rows, considered: 34, blocked: null, errors: [], ...o,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("Matches tab", () => {
  beforeEach(() => forgetShared());
  afterEach(() => vi.unstubAllGlobals());

  it("leads with the key, one ranked list, the reason, the check and the firm price", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(result([
      row({ key: "demand:btd_1", name: "ELG Battery", tags: ["live ask"], reason: "Wants 100k cells", checks: [], price: "EUR 20/kWh" }),
      row({ tags: ["lead"], personId: "p1" }),
    ]))));
    render(<SupplyMatchesTab listingId="bts_1" active />);
    expect(await screen.findByText("Matched on")).toBeTruthy();
    expect(screen.getByText(/40 units · Toyota Proace/)).toBeTruthy();
    expect(screen.getByText("live ask")).toBeTruthy();
    expect(screen.getByText("lead")).toBeTruthy();
    expect(screen.getByText("Same part number: 50 kWh Packs NMC")).toBeTruthy();
    expect(screen.getByText(/Check: No firm seller price/)).toBeTruthy();
    expect(screen.getByText("40/kWh against their 60/kWh (+50%)")).toBeTruthy();
    expect(screen.getByText(/2 matches · 34 checked/)).toBeTruthy();
    // One primary action per row, and the quiet Not a fit beside it.
    expect(screen.getAllByRole("button", { name: "Add to offers" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Not a fit" })).toHaveLength(2);
  });

  it("expands the full key only when asked, or by itself for a disputed or mixed lot", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(result([row()]))));
    const { unmount } = render(<SupplyMatchesTab listingId="bts_1" active />);
    expect(await screen.findByText("Matched on")).toBeTruthy();
    expect(screen.queryByText("Seller price EUR 40 per kWh")).toBeNull();
    fireEvent.click(screen.getByText("Matched on"));
    expect(screen.getByText("Seller price EUR 40 per kWh")).toBeTruthy();
    unmount();
    vi.stubGlobal("fetch", vi.fn(async () => json(result([row()], {
      lotKey: { line: "2 products", full: ["Product 1", "Product 2"], open: true },
    }))));
    render(<SupplyMatchesTab listingId="bts_2" active />);
    expect(await screen.findByText("Product 1")).toBeTruthy();
  });

  it("adds the offer with the match in data and shows the stage and date it became", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url} ${init?.body ?? ""}`);
      if (url.endsWith("/offers")) {
        return json({ offer: { id: "bof_1", stage: "candidate", updated_at: "2026-11-08T09:00:00.000Z" } }, 201);
      }
      return json(result([row()]));
    }));
    render(<SupplyMatchesTab listingId="bts_1" active />);
    fireEvent.click(await screen.findByRole("button", { name: "Add to offers" }));
    await waitFor(() => expect(calls.some((call) => call.startsWith("POST /api/bulk-listings/bts_1/offers"))).toBe(true));
    const body = JSON.parse(calls.find((call) => call.startsWith("POST"))!.split(" ").slice(2).join(" "));
    expect(body).toMatchObject({
      name: "Exigo", companyId: "c1", personId: "p1", contact: "buyer@exigo.test", stage: "candidate",
      data: { match: { reason: "Same part number: 50 kWh Packs NMC", rank: 1 } },
    });
    expect(typeof body.data.match.at).toBe("string");
    expect(body.data.stock_opportunity_id).toBeUndefined();
    expect(await screen.findByText(/In offers · Candidate 8 Nov/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add to offers" })).toBeNull();
  });

  it("links an existing offer to the Offers tab instead of offering again", async () => {
    const open = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => json(result([
      row({ offer: { id: "bof_2", stage: "offered", date: "2026-11-05" } }),
    ]))));
    render(<SupplyMatchesTab listingId="bts_1" active onOpenOffers={open} />);
    fireEvent.click(await screen.findByText(/In offers · Offered 5 Nov/));
    expect(open).toHaveBeenCalled();
  });

  it("asks for a quick reason before Not a fit and hides the row once saved", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url} ${init?.body ?? ""}`);
      if (init?.method === "POST") return json({ activity: { id: "a1" } }, 201);
      return json(result([row()]));
    }));
    render(<SupplyMatchesTab listingId="bts_1" active />);
    fireEvent.click(await screen.findByRole("button", { name: "Not a fit" }));
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Wrong chemistry" }));
    fireEvent.change(screen.getByLabelText("Anything else"), { target: { value: "NMC only" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(calls.some((call) => call.startsWith("POST /api/bulk-listings/bts_1/matches/v2")
      && call.includes('"reason":"Wrong chemistry — NMC only"'))).toBe(true));
    await waitFor(() => expect(screen.queryByText("Exigo")).toBeNull());
  });

  it("shows ten rows and then the rest", async () => {
    const many = Array.from({ length: 14 }, (_, i) => row({ key: `company:c${i}`, name: `Buyer ${i}`, rank: i + 1 }));
    vi.stubGlobal("fetch", vi.fn(async () => json(result(many))));
    render(<SupplyMatchesTab listingId="bts_1" active />);
    expect(await screen.findByText("Buyer 9")).toBeTruthy();
    expect(screen.queryByText("Buyer 10")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Show 4 more of 4/ }));
    expect(await screen.findByText("Buyer 13")).toBeTruthy();
  });

  it("shows the empty state, and an error with a retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(result([], { blocked: "Nothing fits yet. Add a dossier or a listing field to widen the match." }))));
    const { unmount } = render(<SupplyMatchesTab listingId="bts_1" active />);
    expect(await screen.findByText(/Nothing fits yet/)).toBeTruthy();
    unmount();
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Could not load matches." }, 500)));
    render(<SupplyMatchesTab listingId="bts_2" active />);
    expect(await screen.findByText("Could not load matches.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("does not fetch while the tab is hidden", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<SupplyMatchesTab listingId="bts_1" active={false} />);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows what a request row holds, its source and one fit mark per requirement, each as glyph and word", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(result([row({
      key: "stock:sto_50e", name: "E-bike seller", tags: ["unlisted stock"], reason: "Cell model matches: Samsung 50E", checks: [],
      detail: "Quantity not stated", price: null, stockId: "sto_50e",
      holds: "Samsung INR21700-50E · quantity not stated", source: "Email, 27 Oct · Florida, USA",
      fit: [
        { key: "model", label: "Samsung 50E", state: "fits" },
        { key: "format", label: "Format", state: "unstated" },
        { key: "location", label: "US → PL", state: "close" },
        { key: "price", label: "EUR 2, over max", state: "misses" },
      ],
    })], { id: "btd_1", kind: "demand", coverage: { stated: 0, need: 500_000, unstated: 1 } }))));
    render(<DemandMatchesTab demandId="btd_1" active />);
    expect(await screen.findByText("Samsung INR21700-50E · quantity not stated")).toBeTruthy();
    expect(screen.getByText("Email, 27 Oct · Florida, USA")).toBeTruthy();
    const marks = within(screen.getByRole("list", { name: "How it fits" })).getAllByRole("listitem");
    expect(marks.map((mark) => mark.textContent)).toEqual([
      "✓fits:Samsung 50E", "?not stated:Format", "≈close:US → PL", "✗misses:EUR 2, over max",
    ]);
    expect(screen.getByLabelText("What we matched on").textContent).toMatch(/Stated stock 0 of 500,000.*1 source hasn't said/);
    expect(screen.getByLabelText("Fit marks").textContent).toContain("? not stated");
    // The marks replace the reason and the quantity line on a request row.
    expect(screen.queryByText("Cell model matches: Samsung 50E")).toBeNull();
    expect(screen.queryByText("Quantity not stated")).toBeNull();
  });

  it("states stock against a ranged need without reading the range as its minimum", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(result([row({
      key: "trade:t1", name: "Motorgreen", tags: ["our listing"], checks: [], price: null, holds: "40x Toyota Proace 50kWh Packs · 40 packs",
      source: "Live trade, 7 Nov", fit: [{ key: "quantity", label: "40 available · need 2–13", state: "fits" }],
    })], { id: "btd_stn", kind: "demand", coverage: { stated: 76, need: 2, needMax: 13, unstated: 0 } }))));
    render(<DemandMatchesTab demandId="btd_stn" active />);
    await screen.findByText("Motorgreen");
    expect(screen.getByLabelText("What we matched on").textContent).toContain("Stated stock 76 · need 2–13");
    expect(screen.getByLabelText("What we matched on").textContent).not.toContain("76 of 2");
    expect(screen.getByRole("list", { name: "How it fits" }).textContent).toContain("40 available · need 2–13");
  });

  it("lays a request out as the mockup: requirement chips, a ranked card, and rows that open", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(result([row({
      key: "stock:sto_50e", name: "AATGNR (US cell seller)", tags: ["unlisted stock"], reason: "Cell model matches: Samsung 50E", checks: [],
      detail: "Quantity not stated", price: null, stockId: "sto_50e", country: "United States",
      holds: "Samsung INR21700-50E · quantity not stated", source: "Email, 27 Oct",
      quote: "Seller email 22 Oct 2026: loose cells from e-bike packs", link: null, askFor: ["quantity", "price per unit"], sourceKind: "email",
      fit: [
        { key: "model", label: "Samsung 50E", state: "fits", name: "Cell model", asked: "Samsung 50E", have: "Samsung INR21700-50E" },
        { key: "quantity", label: "Quantity", state: "unstated", name: "Quantity", asked: "500,000", have: "Not stated" },
      ],
    })], {
      id: "btd_1", kind: "demand", coverage: { stated: 0, need: 500_000, unstated: 1 },
      summary: { chips: [{ label: "Samsung 50E-equivalent 21700 cells", strong: true }, { label: "Cells" }, { label: "Ceiling €1.00/cell · internal" }], outreach: { asked: 1, replied: 0, chaseDue: 1 } },
    }))));
    render(<DemandMatchesTab demandId="btd_1" active />);
    expect(await screen.findByText("Samsung 50E-equivalent 21700 cells")).toBeTruthy();
    const summary = screen.getByLabelText("What we matched on");
    expect(summary.textContent).toContain("Matched on");
    expect(summary.textContent).toContain("Ceiling €1.00/cell · internal");
    expect(summary.textContent).toContain("1 source matches");
    expect(summary.textContent).toMatch(/1 asked · 0 replied · 1 chase due/);
    expect(screen.getByText("Matches")).toBeTruthy();
    expect(screen.getByText("· ranked by fit, then stated quantity")).toBeTruthy();
    expect(screen.getByText("Not contacted")).toBeTruthy();
    // The mock's second status line, from where the line comes from.
    expect(screen.getByText("Mentioned in an email, never asked")).toBeTruthy();
    expect(screen.getByText("Unlisted stock")).toBeTruthy();
    // The row opens on click: the source, "How it fits" and "This deal with …".
    const toggle = screen.getAllByRole("button", { expanded: false }).find((button) => button.textContent?.includes("AATGNR"))!;
    expect(screen.queryByText("Where this comes from")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Where this comes from")).toBeTruthy();
    expect(screen.getByText("“Seller email 22 Oct 2026: loose cells from e-bike packs”")).toBeTruthy();
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Requirement", "Buyer asked", "They have", "Fit"]);
    // The table's marks are glyph and word.
    expect(within(table).getAllByRole("row").slice(1).map((r) => r.textContent)).toEqual([
      "Cell modelSamsung 50ESamsung INR21700-50E✓fits", "Quantity500,000Not stated?not stated",
    ]);
    expect(screen.getByText("This deal with AATGNR")).toBeTruthy();
    expect(screen.getByText("Ask for: quantity, price per unit.")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Add to offers" })).toHaveLength(2);
    fireEvent.click(toggle);
    expect(screen.queryByText("Where this comes from")).toBeNull();
  });

  it("keeps the supply tab exactly as it was: reason, detail and checks, with no marks or legend", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(result([row()]))));
    render(<SupplyMatchesTab listingId="bts_1" active />);
    expect(await screen.findByText("Same part number: 50 kWh Packs NMC")).toBeTruthy();
    expect(screen.getByText("Last contact 2026-10-08")).toBeTruthy();
    expect(screen.getByText(/Check: No firm seller price/)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "How it fits" })).toBeNull();
    expect(screen.queryByLabelText("Fit marks")).toBeNull();
    expect(screen.queryByText(/Stated stock/)).toBeNull();
  });

  describe("grouped stock on a request (slice 2)", () => {
    const unit = (i: number, o: Partial<MatchUnit> = {}): MatchUnit => ({
      key: `stock:sto_${i}`, stockId: `sto_${i}`, vehicle: i % 2 ? "Peugeot Rifter Allure" : "Vauxhall Vivaro-e 3100", year: 2022,
      ref: `NW-${4400 + i}`, soh: i === 1 ? { state: "fits", label: "SoH 92%", source: "supplier test" } : { state: "unstated", label: "Not stated", source: null },
      location: "Leeds", price: `EUR ${(2000 + i * 10).toLocaleString("en-GB")}`, seen: "7 Nov", link: { href: `https://northway.example/${i}`, label: "Listing" }, ...o,
    });
    const grouped = (units: MatchUnit[], o: Partial<MatchGroupView> = {}) => row({
      key: "group:stock:sto_1", name: "Northway Parts", tags: ["unlisted stock"], reason: "Stellantis 46 kWh NMC pack × 11", checks: [],
      detail: "11 packs", price: "EUR 2,010–2,110", stockId: "sto_1", companyId: "c_nw", personId: "p_nw", sourceKind: "salvage listing",
      holds: "Stellantis 46 kWh NMC pack × 11", source: "EUR 2,010–2,110 per pack · Leeds, Warrington · salvage listings, seen 1–7 Nov",
      fit: [
        { key: "price", label: "EUR 2,010–2,110", state: "fits" },
        { key: "condition", label: "SoH: 1 of 11 stated", state: "close" },
        { key: "location", label: "In GB", state: "fits" },
      ],
      group: {
        pack: "Stellantis 46 kWh NMC pack", count: units.length, countWord: null, unsure: false, sameLabel: "Same pack in",
        vehicles: [{ name: "Vauxhall Vivaro-e", n: 6 }, { name: "Peugeot Rifter", n: 5 }],
        meta: "EUR 2,010–2,110 per pack · Leeds, Warrington · salvage listings, seen 1–7 Nov",
        why: { title: "Why these count as the same pack", text: "The Vauxhall Vivaro-e and Peugeot Rifter carry the Stellantis 50 kWh NMC pack. Battery graph: matched on part number, high confidence." },
        lots: false, units, stockIds: units.map((u) => u.stockId!), ...o,
      },
    });
    const summary = { chips: [{ label: "Complete EV packs", strong: true }], outreach: null, count: { suppliers: 2, units: 12, word: "packs" }, packTypes: { types: 2, unconfirmed: 1 }, grouped: true };

    it("shows one row per supplier and pack type: the pack × N, Same pack in, the meta line and the group's marks", async () => {
      const units = Array.from({ length: 11 }, (_, i) => unit(i + 1));
      vi.stubGlobal("fetch", vi.fn(async () => json(result([
        grouped(units),
        row({ key: "stock:sto_99", name: "Fenwick Auto", tags: ["unlisted stock"], checks: [], price: null, stockId: "sto_99", holds: "Citroen e-Berlingo · 1 pack", source: "Salvage listing, 5 Nov", fit: [] }),
      ], { id: "btd_stn", kind: "demand", summary }))));
      render(<DemandMatchesTab demandId="btd_stn" active />);
      expect(await screen.findByText("Stellantis 46 kWh NMC pack")).toBeTruthy();
      expect(screen.getByText("× 11")).toBeTruthy();
      expect(screen.getByLabelText("What we matched on").textContent).toContain("2 suppliers · 12 packs match");
      expect(screen.getByLabelText("What we matched on").textContent).toContain("2 pack types, 1 not confirmed");
      expect(screen.getByText("· one row per supplier and pack type")).toBeTruthy();
      expect(screen.getByText("Click a row for each unit and why the packs count as the same")).toBeTruthy();
      expect(screen.getByText("Same pack in")).toBeTruthy();
      expect(screen.getByText("Vauxhall Vivaro-e").parentElement?.textContent).toContain("Vauxhall Vivaro-e 6");
      expect(screen.getByText("EUR 2,010–2,110 per pack · Leeds, Warrington · salvage listings, seen 1–7 Nov")).toBeTruthy();
      const marks = within(screen.getAllByRole("list", { name: "How it fits" })[0]).getAllByRole("listitem").map((mark) => mark.textContent);
      expect(marks).toEqual(["✓fits:EUR 2,010–2,110", "≈close:SoH: 1 of 11 stated", "✓fits:In GB"]);
      // The status column and Add to offers as slice 1; no checkboxes yet (slice 4).
      expect(screen.getAllByText("Not contacted")).toHaveLength(2);
      expect(screen.getByText("Listed for sale")).toBeTruthy();
      expect(screen.queryByRole("checkbox")).toBeNull();
      expect(screen.queryByText("Pack type not confirmed")).toBeNull();
    });

    it("opens to why the packs count as the same, then five units, and Show all opens a scrolling box with a fixed header", async () => {
      const units = Array.from({ length: 11 }, (_, i) => unit(i + 1));
      vi.stubGlobal("fetch", vi.fn(async () => json(result([grouped(units)], { id: "btd_stn", kind: "demand", summary }))));
      render(<DemandMatchesTab demandId="btd_stn" active />);
      const toggle = (await screen.findAllByRole("button", { expanded: false })).find((button) => button.textContent?.includes("Northway Parts"))!;
      fireEvent.click(toggle);
      expect(screen.getByText("Why these count as the same pack:").parentElement?.textContent).toContain("carry the Stellantis 50 kWh NMC pack");
      expect(screen.getByText("Units")).toBeTruthy();
      expect(screen.getByText("· 11, cheapest first")).toBeTruthy();
      const table = screen.getByRole("table");
      expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Vehicle", "Year", "Stock ref", "SoH / condition", "Location", "Price", "Seen", "Link"]);
      expect(within(table).getAllByRole("row")).toHaveLength(1 + 5);
      expect(within(table).getAllByRole("row")[1].textContent).toBe("Peugeot Rifter Allure2022NW-4401✓fits:SoH 92% supplier testLeedsEUR 2,0107 NovListing");
      expect(within(table).getAllByRole("row")[2].textContent).toContain("?not stated:Not stated");
      const box = screen.getByRole("region", { name: "Northway Parts: units" });
      expect(box.style.maxHeight).toBe("");
      fireEvent.click(screen.getByRole("button", { name: "Show all 11 units (6 more)" }));
      expect(within(table).getAllByRole("row")).toHaveLength(1 + 11);
      expect(box.style.maxHeight).toBe("360px");
      expect(box.className).toContain("ubox");
      expect(within(table).getAllByRole("columnheader")[0].closest("table")?.className).toContain("ut");
      fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
      expect(within(table).getAllByRole("row")).toHaveLength(1 + 5);
      // No "Show all" for five units or fewer.
      fireEvent.click(toggle);
      expect(screen.queryByRole("table")).toBeNull();
    });

    it("tags an unconfirmed pack type and says why it is kept apart", async () => {
      const units = [unit(1), unit(2), unit(3)];
      vi.stubGlobal("fetch", vi.fn(async () => json(result([grouped(units, {
        pack: "Pack from Citroen e-Berlingo", unsure: true, sameLabel: "Listed as", vehicles: [{ name: "Citroen e-Berlingo", n: 3 }],
        why: { title: "Why this is kept apart", text: "These listings name the Citroen e-Berlingo but give no part number." },
      })], { id: "btd_stn", kind: "demand", summary }))));
      render(<DemandMatchesTab demandId="btd_stn" active />);
      expect(await screen.findByText("Pack type not confirmed")).toBeTruthy();
      expect(screen.getByText("Listed as")).toBeTruthy();
      fireEvent.click(screen.getAllByRole("button", { expanded: false }).find((button) => button.textContent?.includes("Northway Parts"))!);
      expect(screen.getByText("Why this is kept apart:")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
    });

    it("keeps a group of one as slice 1's row", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => json(result([row({
        key: "stock:sto_1", name: "Carden Breakers", tags: ["unlisted stock"], checks: [], price: "EUR 2,150", stockId: "sto_1",
        holds: "Vauxhall Corsa-e · 1 pack · SoH 91%", source: "Stock list, 2 Nov", quote: "Corsa-e pack", sourceKind: "stock list",
        fit: [{ key: "condition", label: "SoH 91%", state: "fits", name: "Condition", asked: "SoH 80%+", have: "SoH 91%" }],
      })], { id: "btd_stn", kind: "demand", summary: { ...summary, grouped: false, packTypes: null } }))));
      render(<DemandMatchesTab demandId="btd_stn" active />);
      expect(await screen.findByText("Vauxhall Corsa-e · 1 pack · SoH 91%")).toBeTruthy();
      expect(screen.getByText("· ranked by fit, then stated quantity")).toBeTruthy();
      expect(screen.queryByText("Same pack in")).toBeNull();
      expect(screen.getByRole("button", { name: "Not a fit" })).toBeTruthy();
      fireEvent.click(screen.getAllByRole("button", { expanded: false }).find((button) => button.textContent?.includes("Carden"))!);
      expect(screen.getByText("Where this comes from")).toBeTruthy();
      expect(screen.getByText("How it fits")).toBeTruthy();
      expect(screen.getByText("This deal with Carden")).toBeTruthy();
    });

    it("adds a group as one offer: the cheapest unit as its stock line, and every unit's stock line kept", async () => {
      const calls: string[] = [];
      const units = [unit(1), unit(2), unit(3)];
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url} ${init?.body ?? ""}`);
        if (url.includes("/offers")) return json({ offer: { id: "bof_9", stage: "candidate", updated_at: "2026-11-08T09:00:00.000Z" } }, 201);
        return json(result([grouped(units)], { id: "btd_stn", kind: "demand", summary }));
      }));
      render(<DemandMatchesTab demandId="btd_stn" active />);
      fireEvent.click(await screen.findByRole("button", { name: "Add to offers" }));
      await waitFor(() => expect(calls.some((call) => call.startsWith("POST /api/bulk-trades/demand/btd_stn/offers"))).toBe(true));
      const body = JSON.parse(calls.find((call) => call.startsWith("POST"))!.split(" ").slice(2).join(" "));
      expect(body).toMatchObject({ name: "Northway Parts", companyId: "c_nw", personId: "p_nw", data: { stock_opportunity_id: "sto_1", stock_opportunity_ids: ["sto_1", "sto_2", "sto_3"] } });
      expect(await screen.findByText(/In offers · Candidate 8 Nov/)).toBeTruthy();
      expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(1);
    });

    it("leaves the supply tab as it was, even next to a grouped request", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => json(result([row()]))));
      render(<SupplyMatchesTab listingId="bts_1" active />);
      expect(await screen.findByText("Same part number: 50 kWh Packs NMC")).toBeTruthy();
      expect(screen.getByText(/1 match · 34 checked/)).toBeTruthy();
      expect(screen.queryByText(/suppliers ·/)).toBeNull();
      expect(screen.queryByText("Same pack in")).toBeNull();
      expect(screen.queryByRole("table")).toBeNull();
    });
  });

  it("offers an unlisted stock row on the request side and records the stock line on the offer", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url} ${init?.body ?? ""}`);
      if (url.includes("/offers")) return json({ offer: { id: "bof_9", stage: "candidate", updated_at: "2026-11-08T09:00:00.000Z" } }, 201);
      return json(result([row({ key: "stock:sto_1", name: "Synthetic Supplier", tags: ["unlisted stock"], companyId: "c9", personId: "p9", stockId: "sto_1", price: null })], { id: "btd_1", kind: "demand" }));
    }));
    render(<DemandMatchesTab demandId="btd_1" active />);
    fireEvent.click(await screen.findByRole("button", { name: "Add to offers" }));
    await waitFor(() => expect(calls.some((call) => call.startsWith("POST /api/bulk-trades/demand/btd_1/offers"))).toBe(true));
    const body = JSON.parse(calls.find((call) => call.startsWith("POST"))!.split(" ").slice(2).join(" "));
    expect(body.data.stock_opportunity_id).toBe("sto_1");
  });
});
