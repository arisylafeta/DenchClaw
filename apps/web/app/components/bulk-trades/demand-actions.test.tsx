// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { DemandActions } from "./demand-actions";
import type { Demand } from "@/lib/bulk-demand";

const demand = { id: "history-test", kind: "standing", status: "open", spec: {} } as Demand;
const props = { demand, today: "2026-10-20", onClose: vi.fn(), onChanged: vi.fn(), onEdit: vi.fn(), onOpenTrade: vi.fn(), section: "Activity", story: true };

describe("History loading", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("keeps the timeline structure while pending, then shows real entries", async () => {
    let release!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { release = resolve; })));
    render(<DemandActions {...props} />);
    const history = screen.getByRole("region", { name: "History" });
    expect(within(history).getByRole("status")).toHaveTextContent("Loading history");
    expect(within(history).getByRole("heading")).toHaveTextContent(/^History$/);
    expect(within(history).queryByText("No activity yet")).not.toBeInTheDocument();
    expect(within(history).getAllByRole("listitem")).toHaveLength(5);
    for (const row of within(history).getAllByRole("listitem")) {
      expect(row.querySelector("svg")).toBeInTheDocument();
      expect(row.querySelector("time [aria-hidden]")).toBeInTheDocument();
      expect(row.querySelector("p")).toHaveTextContent(/^\s*$/);
      expect(within(row).getByRole("button")).toBeDisabled();
    }
    expect(within(history).queryByText("Buyer confirmed quantity")).not.toBeInTheDocument();
    await act(async () => release(new Response(JSON.stringify({ activity: [{
      id: "a1", demand_id: demand.id, kind: "call", title: "Buyer confirmed quantity", body: "Twenty packs needed.",
      ref_kind: null, ref_id: null, data: {}, actor_user_id: null, occurred_at: "2026-10-19T10:00:00Z", created_at: "2026-10-19T10:00:00Z",
    }] }))));
    expect(await within(history).findByText("Buyer confirmed quantity")).toBeInTheDocument();
    expect(within(history).getByText("Call")).toBeInTheDocument();
    expect(within(history).getByText("Twenty packs needed.")).toBeInTheDocument();
    expect(within(history).queryByRole("status")).not.toBeInTheDocument();
    expect(within(history).getAllByRole("listitem")).toHaveLength(1);
    expect(history.querySelector("time")).toHaveAttribute("datetime", "2026-10-19T10:00:00Z");
  });

  it("ends the loading state for an empty history", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ activity: [] }))));
    render(<DemandActions {...props} />);
    expect(await screen.findByText("No activity yet")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
