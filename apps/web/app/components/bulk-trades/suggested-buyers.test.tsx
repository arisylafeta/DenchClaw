// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SuggestedBuyers } from "./suggested-buyers";
describe("SuggestedBuyers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("adds a suggested buyer or hides a poor fit", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn();
    render(
      <SuggestedBuyers
        tradeId="bt_69"
        onChanged={onChanged}
        suggested={[
          {
            demand_id: "btd_1",
            tier: "A",
            stage: "Engaged",
            group: "offer",
            kind: "request",
            basis: null,
            buyer: "H. Nolden Investment",
            contact: "Markus",
            wants: "Tested EV packs 50 kWh+",
            needed_by: "2026-10-15",
            confirmed_on: "2026-09-21",
            strength: "strong",
            reason: "A homogeneous lot.",
            more: [
              {
                demand_id: "btd_2",
                wants: "Modules for BESS",
                strength: "partial",
                reason: "Modules, not packs.",
              },
            ],
          },
          {
            demand_id: "btd_3",
            tier: null,
            stage: "New",
            group: "introduce",
            kind: "standing",
            basis: "estimated",
            buyer: "Volt Repair Kft",
            contact: null,
            wants: "EV packs for repair",
            needed_by: null,
            confirmed_on: null,
            strength: "partial",
            reason: "Repairs packs like these; estimated.",
            more: [],
          },
        ]}
      />,
    );
    expect(screen.getByRole("region", { name: "Offer now" })).toHaveTextContent(
      "H. Nolden Investment",
    );
    const introduce = screen.getByRole("region", { name: "Introduce" });
    expect(introduce).not.toHaveTextContent("Volt Repair Kft"); // research matches stay folded until asked for
    await userEvent.click(
      within(introduce).getByRole("button", { name: "Show" }),
    );
    expect(introduce).toHaveTextContent("Volt Repair Kft");
    expect(screen.getByText("Strong fit")).toBeInTheDocument();
    expect(
      screen.getByText("· needed by 15 Oct", { exact: false }),
    ).toBeInTheDocument();
    await userEvent.click(
      within(screen.getByRole("region", { name: "Offer now" })).getByRole(
        "button",
        { name: "Add to buyers" },
      ),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/bulk-trades/bt_69/suggested/btd_1",
      expect.objectContaining({ method: "POST" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Not a fit: H. Nolden Investment" }),
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/bulk-trades/bt_69/suggested/btd_1",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(onChanged).toHaveBeenCalledTimes(2);
    await userEvent.click(screen.getByRole("button", { name: "+1 more want" }));
    expect(screen.getByText(/Modules for BESS/)).toBeInTheDocument();
  });
});
