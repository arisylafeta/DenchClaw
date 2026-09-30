// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { todayInLondon } from "@/lib/bulk-trades";
import type { Dismantler } from "@/lib/dismantlers";
import { DismantlersView } from "./dismantlers-view";

const today = todayInLondon();

function dismantler(o: Partial<Dismantler>): Dismantler {
  return {
    id: "dm", company_id: "c", name: "Yard", stage: "Contacted", stage_since: today, parked_from: null, park_reason: null,
    revisit_on: null, next_step: "Follow up", next_step_due: today, next_step_person_id: null, next_step_person_name: null,
    waiting_on: "us", waiting_since: null, owner_user_id: null, owner_name: null, goal: false, route: "eBay", country: "UK",
    ebay_username: null, ebay_listings: null, platform_account_id: null, source: null, notes: null,
    setup_account_on: null, setup_route_on: null, setup_connected_on: null, setup_first_stock_on: null,
    setup_first_sync_on: null, setup_second_sync_on: null, last_contact: null, updated_at: "", ...o,
  };
}

const DISMANTLERS = [
  dismantler({ id: "dm_1", name: "Synthetic Recycling", stage: "Onboarding", goal: true, next_step: "Setup call" }),
  dismantler({ id: "dm_2", name: "Quiet Yard", stage: "Live", next_step: null, next_step_due: null }),
  dismantler({ id: "dm_3", name: "Backlog Breakers", stage: "Found", next_step: null, next_step_due: null, ebay_listings: 16, country: "UK" }),
  dismantler({ id: "dm_4", name: "Baltic Parts", stage: "Found", next_step: null, next_step_due: null, ebay_listings: 245, country: "Lithuania" }),
  dismantler({ id: "dm_5", name: "Resting Salvage", stage: "Parked", park_reason: "Not now", next_step: null, next_step_due: null }),
];

type Call = { url: string; method: string; body: Record<string, unknown> | null };

function mockFetch(calls: Call[]) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });
    const id = url.match(/^\/api\/dismantlers\/(dm_\d)$/)?.[1];
    const one = DISMANTLERS.find((d) => d.id === id);
    if (method === "PATCH" && one) return new Response(JSON.stringify({ dismantler: { ...one, ...body } }));
    if (one) {
      return new Response(JSON.stringify({
        dismantler: one,
        people: [{ id: "p1", name: "Pat Example", email: "pat@example.test", job_title: "Director" }],
        activity: [{ kind: "event", at: `${today}T09:00:00Z`, event: "updated", changes: { stage: ["Contacted", "Onboarding"] }, actor: "Alex" }],
      }));
    }
    if (url === "/api/dismantlers/outreach") {
      return new Response(JSON.stringify({ dismantlers: DISMANTLERS.filter((d) => (body!.ids as string[]).includes(d.id)).map((d) => ({ ...d, stage: "Contacted" })) }));
    }
    return new Response(JSON.stringify({ dismantlers: DISMANTLERS, owners: [] }));
  });
}

describe("DismantlersView", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it("shows stage counts, groups those in play, and keeps Found as a backlog sorted by eBay listings", async () => {
    vi.stubGlobal("fetch", mockFetch([]));
    render(<DismantlersView />);

    const journey = await screen.findByRole("navigation", { name: "Journey" });
    expect(within(journey).getByText("Found").parentElement!.parentElement).toHaveTextContent("Found2not contacted yet");
    expect(within(screen.getByRole("region", { name: "Due today" })).getByText("Synthetic Recycling")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "No next step" })).getByText("Quiet Yard")).toBeInTheDocument();
    expect(screen.getByText("Q4 goal")).toBeInTheDocument();

    const backlog = screen.getByRole("region", { name: "Found" });
    const names = within(backlog).getAllByRole("button").map((button) => button.textContent).filter((text) => /Parts|Breakers/.test(text ?? ""));
    expect(names).toEqual(["Baltic Parts", "Backlog Breakers"]);
    expect(screen.getByText("1 parked · see on the board")).toBeInTheDocument();
  });

  it("starts outreach on a ticked batch with a working-day follow-up", async () => {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", mockFetch(calls));
    render(<DismantlersView />);

    const backlog = await screen.findByRole("region", { name: "Found" });
    await userEvent.click(within(backlog).getByRole("button", { name: "Lithuania" }));
    await userEvent.click(within(backlog).getByLabelText("Select Baltic Parts"));
    expect(within(backlog).getByText("1 selected")).toBeInTheDocument();
    await userEvent.click(within(backlog).getByRole("button", { name: "Start outreach" }));
    await userEvent.click(screen.getByRole("button", { name: "Move 1 to Contacted" }));

    await waitFor(() => expect(calls.some((call) => call.url === "/api/dismantlers/outreach")).toBe(true));
    const sent = calls.find((call) => call.url === "/api/dismantlers/outreach")!.body!;
    expect(sent).toMatchObject({ ids: ["dm_4"], next_step: "Follow up if no reply" });
    expect(sent.next_step_due).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("moves a card one stage on from the board, unfolds Found rows, and asks why before parking", async () => {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", mockFetch(calls));
    render(<DismantlersView />);

    await userEvent.click(await screen.findByRole("tab", { name: "Board" }));
    await userEvent.click(screen.getByRole("button", { name: "Move Synthetic Recycling to Live" }));
    await waitFor(() => expect(calls.find((call) => call.method === "PATCH")).toMatchObject({ url: "/api/dismantlers/dm_1", body: { stage: "Live" } }));

    const found = screen.getByRole("region", { name: "Found" });
    expect(within(found).queryByText("245 battery listings on eBay")).not.toBeInTheDocument();
    await userEvent.click(within(found).getByRole("button", { name: /Baltic Parts/ }));
    expect(within(found).getByText("245 battery listings on eBay")).toBeInTheDocument();

    const parked = screen.getByRole("button", { name: "Open Parked, 1 dismantler" });
    const data: Record<string, string> = {};
    const transfer = { setData: (k: string, v: string) => { data[k] = v; }, getData: (k: string) => data[k] ?? "" };
    fireEvent.dragStart(within(screen.getByRole("region", { name: "Live" })).getByText("Quiet Yard").closest("[draggable]")!, { dataTransfer: transfer });
    fireEvent.drop(parked, { dataTransfer: transfer });
    await userEvent.type(await screen.findByLabelText("Why"), "Not a fit");
    await userEvent.click(screen.getByRole("button", { name: "Park" }));
    await waitFor(() => expect(calls.filter((call) => call.method === "PATCH").at(-1)).toMatchObject({
      url: "/api/dismantlers/dm_2", body: { stage: "Parked", park_reason: "Not a fit" },
    }));
  });

  it("opens a dismantler: what the next stage needs, setup ticks, and history", async () => {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", mockFetch(calls));
    render(<DismantlersView />);

    await userEvent.click(await screen.findByRole("button", { name: /Synthetic Recycling/ }));
    expect(await screen.findByRole("heading", { name: "Synthetic Recycling" })).toBeInTheDocument();
    expect(screen.getByText(/To reach Live: their first stock is published on ReBattery\. 0 of 6 setup steps done\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Email Pat" })).toBeInTheDocument();
    expect(screen.getByText("Contacted → Onboarding")).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText("eBay connected, Fulfillment permission ticked"));
    await waitFor(() => expect(calls.find((call) => call.method === "PATCH")).toMatchObject({
      url: "/api/dismantlers/dm_1", body: { setup_connected_on: today },
    }));
  });
});
