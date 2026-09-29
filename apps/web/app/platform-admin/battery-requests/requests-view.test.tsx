// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const { getBatteryInquiryChat } = vi.hoisted(() => ({
  getBatteryInquiryChat: vi.fn(),
}));
vi.mock("./actions", () => ({ getBatteryInquiryChat }));
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
      session_id: "synthetic-session",
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
describe("battery inquiries page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getBatteryInquiryChat.mockResolvedValue({
      inquiryId: "synthetic-request",
      contactEmail: "battery@example.test",
      createdAt: "2026-09-08T12:03:00Z",
      messages: [
        {
          id: "message-1",
          sequence: 1,
          role: "user",
          body: "I have an EV battery to sell.",
          createdAt: "2026-09-08T12:00:00Z",
        },
        {
          id: "message-2",
          sequence: 2,
          role: "assistant",
          body: "What details can you share?",
          createdAt: "2026-09-08T12:01:00Z",
        },
      ],
    });
  });
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
  it("loads the attached Joules chat into a side sheet", async () => {
    render(<BatteryRequestsView data={data} />);
    fireEvent.click(screen.getByRole("button", { name: "View chat with battery@example.test" }));
    const sheet = screen.getByRole("dialog", { name: "Chat with battery@example.test" });
    expect(sheet).toHaveTextContent("Loading chat");
    expect(getBatteryInquiryChat).toHaveBeenCalledExactlyOnceWith("synthetic-request");
    expect(await screen.findByText("I have an EV battery to sell.")).toBeInTheDocument();
    expect(sheet).toHaveTextContent("2 messages");
    expect(sheet).toHaveTextContent("Visitor");
    expect(sheet).toHaveTextContent("I have an EV battery to sell.");
    expect(sheet).toHaveTextContent("Joules");
    expect(sheet).toHaveTextContent("What details can you share?");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
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
