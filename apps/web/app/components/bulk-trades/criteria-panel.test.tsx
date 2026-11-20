// @vitest-environment jsdom
import React, { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MatchCriteria } from "@/lib/matches-types";
import type { PatchBody } from "@/lib/demand-criteria";
import { TEST_REGISTRY } from "@/lib/bulk-registry.fixture";
import { CriteriaPanel } from "./criteria-panel";

const start: MatchCriteria = {
  spec: { formats: ["Cells", "Modules"], cell_formats: ["Prismatic"], chemistries: ["NMC", "NCA"], excludes: ["Fire or thermal history"], min_lot_kwh: 500 },
  max_price: 40, price_currency: "EUR", price_unit: "kWh", volume: null, volume_unit: null, location: "Ukraine",
};
const registry = { ...TEST_REGISTRY, specLists: { ...TEST_REGISTRY.specLists, excludes: [...TEST_REGISTRY.specLists.excludes, "Pouch cells"] } };

/** Applies each saved PATCH to its own criteria, as the page does after it reloads. */
function Harness({ calls, fail = false }: { calls: PatchBody[]; fail?: boolean }) {
  const [criteria, setCriteria] = useState(start);
  return (
    <CriteriaPanel criteria={criteria} registry={registry} save={async (body) => {
      calls.push(body);
      if (fail) throw new Error("The demand could not be saved.");
      setCriteria((current) => ({ ...current, ...body }) as MatchCriteria);
      return { lots: 120 };
    }} />
  );
}

describe("CriteriaPanel", () => {
  afterEach(cleanup);

  it("lists each criterion with its fixed Buyer or Ours tag and value", () => {
    render(<Harness calls={[]} />);
    const chemistry = screen.getByRole("button", { name: /^Chemistry: NMC, NCA/ }).closest("[data-key]") as HTMLElement;
    expect(within(chemistry).getByText("Buyer")).toBeTruthy();
    const floor = screen.getByRole("button", { name: /^Min lot size: ≥ 500 kWh per lot/ }).closest("[data-key]") as HTMLElement;
    expect(within(floor).getByText("Ours")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Price ceiling: ≤ EUR 40 per kWh/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Delivery: Ukraine/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Exclude: No fire or thermal history/ })).toBeTruthy();
  });

  it("edits a list in place, saves the whole spec with that one key changed and says how many lots", async () => {
    const user = userEvent.setup();
    const calls: PatchBody[] = [];
    render(<Harness calls={calls} />);
    await user.click(screen.getByRole("button", { name: /^Chemistry: NMC, NCA/ }));
    await user.click(screen.getByRole("checkbox", { name: "LFP" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect((calls[0].spec as Record<string, unknown>).chemistries).toEqual(["NMC", "NCA", "LFP"]);
    expect((calls[0].spec as Record<string, unknown>).min_lot_kwh).toBe(500);
    expect(await screen.findByText("Chemistry saved · 120 lots")).toBeTruthy();
    // Focus goes back to the row's value.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Chemistry: NMC, NCA, LFP/ })));
  });

  it("shows exclusions as 'No …' pills and offers values the request already holds", async () => {
    const user = userEvent.setup();
    render(<Harness calls={[]} />);
    await user.click(screen.getByRole("button", { name: /^Exclude:/ }));
    expect(screen.getByRole("checkbox", { name: "No pouch cells" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "No fire or thermal history" }).getAttribute("aria-checked")).toBe("true");
  });

  it("keeps Save disabled with one inline error until the price floor is valid", async () => {
    const user = userEvent.setup();
    const calls: PatchBody[] = [];
    render(<Harness calls={calls} />);
    await user.click(screen.getByRole("button", { name: /Add criterion/ }));
    await user.click(screen.getByRole("menuitem", { name: "Price floor" }));
    const amount = screen.getByLabelText("Price floor amount");
    await user.type(amount, "50");
    expect((await screen.findByRole("alert")).textContent).toMatch(/Floor is above the ceiling \(EUR 40 per kWh\)/);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    await user.clear(amount);
    await user.type(amount, "25");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect((calls[0].spec as Record<string, unknown>).price_floor).toEqual({ amount: 25, currency: "EUR", unit: "kWh" });
  });

  it("treats an all-empty editor as Cancel and Escape as Cancel", async () => {
    const user = userEvent.setup();
    const calls: PatchBody[] = [];
    render(<Harness calls={calls} />);
    await user.click(screen.getByRole("button", { name: /Add criterion/ }));
    await user.click(screen.getByRole("menuitem", { name: "Min SOH" }));
    expect(screen.getByLabelText("Min SOH")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByLabelText("Min SOH")).toBeNull();
    await user.click(screen.getByRole("button", { name: /^Chemistry:/ }));
    await user.click(screen.getByRole("checkbox", { name: "NMC" }));
    await user.click(screen.getByRole("checkbox", { name: "NCA" }));
    await user.click(screen.getByRole("button", { name: "Save" })); // disabled: nothing chosen
    expect(calls).toHaveLength(0);
  });

  it("removes at once with an Undo row and toast, and Undo restores the value", async () => {
    const user = userEvent.setup();
    const calls: PatchBody[] = [];
    render(<Harness calls={calls} />);
    await user.click(screen.getByRole("button", { name: "Remove Min lot size" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].spec).not.toHaveProperty("min_lot_kwh");
    expect(screen.queryByRole("button", { name: /^Min lot size:/ })).toBeNull();
    expect(screen.getByText("Min lot size removed")).toBeTruthy();
    expect(await screen.findByText("Min lot size removed · 120 lots")).toBeTruthy();
    const undo = screen.getAllByRole("button", { name: "Undo" })[0];
    await waitFor(() => expect(document.activeElement).toBe(undo));
    await user.click(undo);
    await waitFor(() => expect(calls).toHaveLength(2));
    expect((calls[1].spec as Record<string, unknown>).min_lot_kwh).toBe(500);
    expect(await screen.findByRole("button", { name: /^Min lot size: ≥ 500/ })).toBeTruthy();
  });

  it("clears the three price fields together when the ceiling is removed", async () => {
    const user = userEvent.setup();
    const calls: PatchBody[] = [];
    render(<Harness calls={calls} />);
    await user.click(screen.getByRole("button", { name: "Remove Price ceiling" }));
    await waitFor(() => expect(calls).toEqual([{ max_price: null, price_currency: null, price_unit: null }]));
  });

  it("picks a supplier country from a searchable list grouped by region, selected first", async () => {
    const user = userEvent.setup();
    const calls: PatchBody[] = [];
    render(<Harness calls={calls} />);
    await user.click(screen.getByRole("button", { name: /Add criterion/ }));
    await user.click(screen.getByRole("menuitem", { name: "Supplier country" }));
    await user.click(screen.getByRole("button", { name: /Supplier country/ }));
    await user.type(screen.getByPlaceholderText("Search countries"), "pol");
    await user.click(screen.getByRole("option", { name: /Poland/ }));
    await user.click(screen.getByRole("option", { name: /Poland/ })); // toggles off again
    await user.click(screen.getByRole("option", { name: /Poland/ }));
    expect(screen.getByRole("button", { name: "Remove Poland" })).toBeTruthy();
    await user.keyboard("{Escape}"); // closes the list only
    expect(screen.queryByPlaceholderText("Search countries")).toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect((calls[0].spec as Record<string, unknown>).supplier_countries).toEqual(["Poland"]);
  });

  it("lists each region with its countries as option text", async () => {
    const user = userEvent.setup();
    render(<Harness calls={[]} />);
    await user.click(screen.getByRole("button", { name: /Add criterion/ }));
    await user.click(screen.getByRole("menuitem", { name: "Supplier region" }));
    await user.click(screen.getByRole("button", { name: /Supplier region/ }));
    expect(screen.getByRole("option", { name: /SE Asia.*Vietnam, Thailand/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Europe.*Turkey/ })).toBeTruthy();
  });

  it("splits the Add menu into buyer criteria and our filters and offers only unused ones", async () => {
    const user = userEvent.setup();
    render(<Harness calls={[]} />);
    await user.click(screen.getByRole("button", { name: /Add criterion/ }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByText("From the buyer")).toBeTruthy();
    expect(within(menu).getByText("Our filters")).toBeTruthy();
    expect(within(menu).queryByRole("menuitem", { name: "Format" })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: "Min lot size" })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "Supplier region" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("shows the save error inline and keeps the editor open", async () => {
    const user = userEvent.setup();
    render(<Harness calls={[]} fail />);
    await user.click(screen.getByRole("button", { name: /^Chemistry:/ }));
    await user.click(screen.getByRole("checkbox", { name: "LFP" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The demand could not be saved.");
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });
});
