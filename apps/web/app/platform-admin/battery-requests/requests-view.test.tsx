// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BatteryRequestsView } from "./requests-view";
import BatteryRequestsError from "./error";
import BatteryRequestsLoading from "./loading";
import type { BatteryRequestPage } from "./reads";
const data: BatteryRequestPage = {
  page: 1,
  totalPages: 1,
  totalCount: 1,
  email: "",
  rows: [
    {
      id: "synthetic-request",
      contact_email: "battery@example.test",
      intent: "sell",
      created_at: "2026-09-08T12:03:00Z",
      request_json: {
        stock: {
          description: "Synthetic cells",
          quantity: 0,
          quantityUnknown: true,
          location: null,
          identifiers: [{ kind: "model", value: "Example" }],
        },
        missingUsefulDetails: ["Confirm battery count"],
      },
    },
  ],
};
describe("battery requests page", () => {
  it("renders saved facts, uncertainty, nested fields and UTC dates", () => {
    const { container } = render(<BatteryRequestsView data={data} />);
    expect(screen.getByRole("heading", { name: "Battery requests" })).toBeInTheDocument();
    expect(screen.getByText("battery@example.test")).toBeInTheDocument();
    expect(screen.getByText("Sell")).toBeInTheDocument();
    expect(screen.getByText("8 Sept 2026, 12:03 UTC")).toBeInTheDocument();
    expect(container.querySelector("details")).not.toHaveAttribute("open");
    fireEvent.click(container.querySelector("summary")!);
    for (const text of [
      "Quantity unknown",
      "Yes",
      "0",
      "Not provided",
      "Confirm battery count",
      "Example",
    ]) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
  });
  it("renders HTML as text and handles incomplete payloads", () => {
    const { container } = render(
      <BatteryRequestsView
        data={{
          ...data,
          rows: [{ ...data.rows[0], request_json: { note: '<img src=x onerror="alert(1)">' } }],
        }}
      />,
    );
    expect(screen.getByText("Battery details not provided")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText('<img src=x onerror="alert(1)">')).toBeInTheDocument();
  });
  it("preserves email search in pagination and submits via GET", () => {
    render(
      <BatteryRequestsView
        data={{ ...data, page: 2, totalPages: 3, email: "battery@example.test" }}
      />,
    );
    expect(screen.getByRole("search")).toHaveAttribute("method", "get");
    expect(screen.getByLabelText("Contact email")).toHaveValue("battery@example.test");
    expect(screen.getByRole("link", { name: "Next" })).toHaveAttribute(
      "href",
      "/platform-admin/battery-requests?page=3&email=battery%40example.test",
    );
    expect(screen.getByRole("link", { name: "Previous" })).toHaveAttribute(
      "href",
      "/platform-admin/battery-requests?page=1&email=battery%40example.test",
    );
  });
  it.each(["", "absent@example.test"])("explains empty results: %s", (email) => {
    render(<BatteryRequestsView data={{ ...data, rows: [], totalCount: 0, email }} />);
    expect(
      screen.getByRole("heading", {
        name: email ? "No matching requests" : "No battery requests yet",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Next" })).toBeNull();
  });
  it("offers retry and a named loading state", () => {
    const reset = vi.fn();
    const view = render(<BatteryRequestsError reset={reset} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledOnce();
    view.unmount();
    render(<BatteryRequestsLoading />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading battery requests");
  });
});
