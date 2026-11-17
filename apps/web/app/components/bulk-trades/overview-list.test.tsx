// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SheetRow } from "@/lib/bulk-sheet";
import { OverviewList } from "./overview-list";

const TODAY = "2026-11-17";

function row(id: string, overrides: Partial<SheetRow> = {}): SheetRow {
  return {
    key: id, id, kind: "demand", side: "buyer", title: `Ask ${id}`, company: `Co ${id}`, company_id: null, category: null,
    progress: "Sourcing", tone: "active", score: 88, latest: null, next_action: `Next for ${id}`, next_due: TODAY, owner: "Sean", touched: null,
    waiting_on: "us", waiting_since: "2026-10-30", ...overrides,
  };
}

const ROWS: SheetRow[] = [
  row("r3", { company: "R3 Robotics S.A.", is_trade: true, progress: "Agreed", fee_eur: 10_000, value_eur: 33_000, likelihood: 80, next_due: "2026-11-16",
    latest: { label: "Pro forma", at: "2026-11-09T10:00:00Z", kind: "Note" } }),
  row("om", { company: "OM Energy Solutions", fee_eur: 17_200, value_eur: 172_000, next_due: "2026-11-15", waiting_since: "2026-10-22" }),
  row("nolden", { company: "H. Nolden Investment GmbH", progress: "Offered", waiting_on: "them", waiting_since: "2026-11-11", contact: "Markus Nolden", next_due: "2026-11-18", fee_eur: 3200 }),
  row("unset", { company: "Fellten", waiting_on: null, waiting_since: null, next_due: null, review: true }),
  row("later", { company: "Later Ltd", next_due: "2026-12-10" }),
];

const props = { loading: false, error: null, today: TODAY, filtered: false, onOpen: vi.fn(), onUpdate: vi.fn() };
const section = (name: string) => screen.getByRole("region", { name });
const rowOf = (company: string) => screen.getByRole("button", { name: `Open ${company}` }).closest("li")!;
const companies = (region: HTMLElement) => Array.from(region.querySelectorAll("li")).map((li) => li.querySelector("button")?.textContent);

describe("OverviewList", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("groups by whose move: your move most overdue first, their move, and On track folded", async () => {
    render(<OverviewList {...props} rows={ROWS} owner="Sean" />);
    expect(companies(section("Your move"))).toEqual(["OM Energy Solutions", "R3 Robotics S.A.", "Fellten"]);
    expect(companies(section("Their move"))).toEqual(["H. Nolden Investment GmbH"]);
    const onTrack = section("On track");
    expect(onTrack).toHaveTextContent("On track · 1");
    expect(within(onTrack).queryByRole("listitem")).toBeNull();
    await userEvent.click(within(onTrack).getByRole("button", { name: /On track/ }));
    expect(companies(section("On track"))).toEqual(["Later Ltd"]);
  });

  it("shows the strip counts, filters on a click and clears on a second click", async () => {
    render(<OverviewList {...props} rows={ROWS} owner="Sean" />);
    const strip = section("Whose move");
    const stat = (key: string) => strip.querySelector(`[data-strip=${key}]`) as HTMLButtonElement;
    expect(stat("you")).toHaveTextContent("3your move");
    expect(stat("over")).toHaveTextContent("2of them overdue");
    expect(stat("them")).toHaveTextContent("1their move");
    expect(stat("all")).toHaveTextContent("5all of Sean’s · €30.4k fees in these 4");
    expect(stat("all")).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(stat("them"));
    expect(stat("them")).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("region", { name: "Your move" })).toBeNull();
    expect(screen.queryByRole("region", { name: "On track" })).toBeNull();
    expect(companies(section("Their move"))).toEqual(["H. Nolden Investment GmbH"]);

    await userEvent.click(stat("over"));
    expect(companies(section("Your move"))).toEqual(["OM Energy Solutions", "R3 Robotics S.A."]);
    await userEvent.click(stat("over"));
    expect(stat("all")).toHaveAttribute("aria-pressed", "true");
    expect(companies(section("Your move"))).toHaveLength(3);
    expect(section("Their move")).toBeInTheDocument();
  });

  it("lays out a row: who, stage track, money, move label, due chip, full next action and Open", () => {
    render(<OverviewList {...props} rows={ROWS} owner="Sean" />);
    const r3 = rowOf("R3 Robotics S.A.");
    expect(within(r3).getByText("Trade")).toBeInTheDocument();
    expect(within(r3).getByText("Ask r3")).toBeInTheDocument();
    expect(within(r3).getByRole("img", { name: "Stage: Agreed, step 6 of 6" })).toBeInTheDocument();
    expect(within(r3).getByText("Last: note, 9 Nov")).toBeInTheDocument();
    expect(r3.querySelector("[data-money]")).toHaveTextContent("€10kfee · €33k ticket80% chance");
    expect(r3.querySelector("[data-move-label]")).toHaveTextContent("Your move · since 30 Oct");
    expect(r3.querySelector("[data-due]")).toHaveTextContent("Overdue 1 day");
    expect(within(r3).getByText("Next for r3")).toBeInTheDocument();
    expect(within(r3).getByRole("button", { name: "Open R3 Robotics S.A." }).className).toMatch(/btnPri/);

    const nolden = rowOf("H. Nolden Investment GmbH");
    expect(nolden.querySelector("[data-move-label]")).toHaveTextContent("Their move · Markus, 6 days");
    expect(nolden.querySelector("[data-due]")).toHaveTextContent("Due tomorrow");
    expect(within(nolden).getByRole("button", { name: "Open H. Nolden Investment GmbH" }).className).not.toMatch(/btnPri/);
    // The score column is gone.
    expect(screen.queryByText("88")).toBeNull();
  });

  it("offers a quiet Set chance when there is no chance, which opens the chance control and saves", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    const onUpdate = vi.fn();
    render(<OverviewList {...props} onUpdate={onUpdate} rows={ROWS} owner="Sean" />);
    const om = rowOf("OM Energy Solutions");
    expect(within(rowOf("R3 Robotics S.A.")).queryByRole("button", { name: "Set chance" })).toBeNull();
    await userEvent.click(within(om).getByRole("button", { name: "Set chance" }));
    fireEvent.change(within(om).getByLabelText("Likelihood of completion"), { target: { value: "40" } });
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: "om" }), { likelihood: 40 }));
    expect(fetchMock).toHaveBeenCalledWith("/api/bulk-listings/om/likelihood", expect.objectContaining({ method: "PUT", body: JSON.stringify({ likelihood: 40 }) }));
  });

  it("still shows the To review chip", () => {
    render(<OverviewList {...props} rows={ROWS} owner="Sean" />);
    expect(within(rowOf("Fellten")).getByText("To review")).toHaveAttribute("data-review-chip");
    expect(rowOf("Fellten").querySelector("[data-move-label]")).toHaveTextContent(/^Your move$/);
  });

  it("shows each row's driver only under All owners", () => {
    const { rerender } = render(<OverviewList {...props} rows={ROWS} owner="Sean" />);
    expect(document.querySelector("[data-driver]")).toBeNull();
    rerender(<OverviewList {...props} rows={ROWS} owner="all" />);
    expect(within(rowOf("OM Energy Solutions")).getByRole("img", { name: "Driver Sean" })).toBeInTheDocument();
    expect(section("Whose move").querySelector("[data-strip=all]")).toHaveTextContent(/^5all · /);
  });

  it("keeps the next-action tools in the … menu: tick done with the composer, reschedule and reword", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    const onUpdate = vi.fn();
    render(<OverviewList {...props} onUpdate={onUpdate} rows={ROWS} owner="Sean" />);
    const om = () => rowOf("OM Energy Solutions");

    await userEvent.click(within(om()).getByRole("button", { name: "More actions for OM Energy Solutions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Reschedule…" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Tomorrow/ }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: "om" }), { next_due: "2026-11-18" }));
    expect(fetchMock).toHaveBeenLastCalledWith("/api/bulk-listings/om/next", expect.objectContaining({ method: "PUT", body: JSON.stringify({ next_action: "Next for om", next_due: "2026-11-18" }) }));

    await userEvent.click(within(om()).getByRole("button", { name: "More actions for OM Energy Solutions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Mark done" }));
    await userEvent.type(within(om()).getByLabelText("What's next?"), "Send the options{Enter}");
    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith("/api/bulk-listings/om/next", expect.objectContaining({
      method: "POST", body: JSON.stringify({ done: "Next for om", next_action: "Send the options", next_due: "2026-11-18" }),
    })));
    expect(onUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ id: "om" }), { next_action: "Send the options", next_due: "2026-11-18", owner: "Sean" });

    await userEvent.click(within(om()).getByRole("button", { name: "More actions for OM Energy Solutions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Edit next action" }));
    const field = within(om()).getByLabelText("Next action");
    await userEvent.clear(field);
    await userEvent.type(field, "Call Alexander{Enter}");
    await waitFor(() => expect(onUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ id: "om" }), { next_action: "Call Alexander" }));
  });

  it("offers Add next action in the menu when a row has none", async () => {
    render(<OverviewList {...props} rows={[row("x", { company: "Empty Co", next_action: null, next_due: null })]} owner="Sean" />);
    await userEvent.click(screen.getByRole("button", { name: "More actions for Empty Co" }));
    expect(screen.queryByRole("menuitem", { name: "Mark done" })).toBeNull();
    await userEvent.click(screen.getByRole("menuitem", { name: "Add next action" }));
    expect(within(rowOf("Empty Co")).getByRole("button", { name: "Add" })).toBeInTheDocument();
  });

  it("says when nothing matches, and when the sheet failed", () => {
    const { rerender } = render(<OverviewList {...props} rows={[]} owner="Sean" filtered />);
    expect(screen.getByText("Nothing matches these filters.")).toBeInTheDocument();
    rerender(<OverviewList {...props} rows={[]} owner="Sean" error="boom" />);
    expect(screen.getByText("The sheet could not load.")).toBeInTheDocument();
  });
});
