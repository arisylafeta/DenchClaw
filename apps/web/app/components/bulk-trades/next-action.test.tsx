// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextActionPanel } from "./next-action";

const TODAY = "2026-11-15";
const ok = () => vi.fn(async () => new Response(JSON.stringify({})));
const body = (mock: ReturnType<typeof ok>, index = 0) => JSON.parse(String((mock.mock.calls[index] as unknown as [string, RequestInit])[1].body));

afterEach(() => vi.unstubAllGlobals());

describe("NextActionPanel", () => {
  it("shows the action with its overdue date and driver", () => {
    render(<NextActionPanel listingId="l1" today={TODAY} value={{ next_action: "Ask David", next_due: "2026-11-02", owner: "Alex" }} />);
    expect(screen.getByRole("button", { name: "Edit next action: Ask David" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Due: Overdue 2 Nov/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Driver Alex" })).toBeInTheDocument();
  });

  it("ticking asks what is next; Save logs it done and sets the next one in one call", async () => {
    const fetchMock = ok(); vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn();
    render(<NextActionPanel listingId="l1" today={TODAY} onChanged={onChanged} value={{ next_action: "Ask David", next_due: "2026-11-02", owner: "Alex" }} />);
    await userEvent.click(screen.getByRole("button", { name: "Mark done" }));
    expect(screen.getByText("Ask David").tagName).toBe("S");
    await userEvent.type(screen.getByLabelText("What's next?"), "Send EXW terms");
    await userEvent.click(screen.getByRole("button", { name: "Wed 18" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/bulk-listings/l1/next");
    expect(body(fetchMock)).toEqual({ done: "Ask David", next_action: "Send EXW terms", next_due: "2026-11-18" });
    expect(screen.getByRole("button", { name: "Edit next action: Send EXW terms" })).toBeInTheDocument();
  });

  it("Undo returns to the action without saving; Skip logs it done with no next action", async () => {
    const fetchMock = ok(); vi.stubGlobal("fetch", fetchMock);
    render(<NextActionPanel listingId="l1" today={TODAY} value={{ next_action: "Ask David", next_due: null, owner: "Alex" }} />);
    await userEvent.click(screen.getByRole("button", { name: "Mark done" }));
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(fetchMock).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Mark done" }));
    await userEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    await waitFor(() => expect(body(fetchMock)).toEqual({ done: "Ask David", next_action: null, next_due: null }));
    expect(await screen.findByText(/No next action/)).toBeInTheDocument();
  });

  it("with no action, the add field is open and needs a driver when the listing has none", async () => {
    const fetchMock = ok(); vi.stubGlobal("fetch", fetchMock);
    render(<NextActionPanel listingId="l1" today={TODAY} value={{ next_action: null, next_due: null, owner: null }} />);
    await userEvent.type(screen.getByRole("textbox", { name: "Next action" }), "Call the seller");
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText("Driver"), "Sean");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/bulk-listings/l1/owner");
    expect(body(fetchMock, 1)).toEqual({ next_action: "Call the seller", next_due: "2026-11-16" });
  });

  it("reschedules from the date pill and keeps the action", async () => {
    const fetchMock = ok(); vi.stubGlobal("fetch", fetchMock);
    render(<NextActionPanel listingId="l1" today={TODAY} value={{ next_action: "Ask David", next_due: "2026-11-02", owner: "Alex" }} />);
    await userEvent.click(screen.getByRole("button", { name: /Due: Overdue 2 Nov/ }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Tomorrow/ }));
    await waitFor(() => expect(body(fetchMock)).toEqual({ next_action: "Ask David", next_due: "2026-11-16" }));
    expect(await screen.findByRole("button", { name: /Due: Tomorrow/ })).toBeInTheDocument();
  });

  it("shows a failed save and keeps the draft", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Listing not found" }), { status: 404 })));
    render(<NextActionPanel listingId="l1" today={TODAY} value={{ next_action: "Ask David", next_due: null, owner: "Alex" }} />);
    await userEvent.click(screen.getByRole("button", { name: "Mark done" }));
    await userEvent.type(screen.getByLabelText("What's next?"), "Send terms{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Listing not found");
    expect(screen.getByLabelText("What's next?")).toHaveValue("Send terms");
  });
});
