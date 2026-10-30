// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getLabelReviewPage, recordLabelDecision } from "./actions";
import { LabelReviewClient } from "./label-review-client";
import type { LabelReviewEntry, LabelReviewPage } from "./contract";

vi.mock("./actions", () => ({ getLabelReviewPage: vi.fn(), recordLabelDecision: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const base: LabelReviewEntry = {
  observationId: "11111111-1111-4111-8111-111111111111", itemId: "22222222-2222-4222-8222-222222222222", itemVersion: 3,
  actor: "researcher", createdAt: "2026-10-29T10:00:00.000Z", make: "Audi", model: "Q4", partNumbers: ["0Z1915910AL"], donorYear: "2023",
  text: "Nominal Voltage 352 V; Nominal Capacity 234 Ah; Nominal Energy 82 kWh", quote: null, photoUrl: "https://cdn.example/label.jpg",
  photoNumber: 5, otherPhotos: ["https://cdn.example/other.jpg"], listingUrl: "https://supplier.example/listing/1",
  stored: { packKwh: 77, voltageNominal: 352, capacityAh: 234, packKwhAuthority: "independent_review" },
  parsed: { kwh: 82, voltage: 352, ah: 234 }, match: "mismatch", decision: null,
};
const page = (entries: LabelReviewEntry[]): LabelReviewPage => ({ entries, total: entries.length, decided: entries.filter((e) => e.decision).length, mismatches: entries.filter((e) => e.match === "mismatch" && !e.decision).length });

describe("LabelReviewClient", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("shows the engine reading beside the stored value, the photo and the original link", () => {
    render(<LabelReviewClient initialPage={page([base])} />);
    expect(screen.getByText("Label differs from stored value")).toBeTruthy();
    expect(screen.getAllByText("82 kWh").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/77 kWh/).length).toBeGreaterThan(0);
    expect(screen.getByText(/independent_review/)).toBeTruthy();
    expect(screen.getByAltText(/Supplier photo of Audi Q4/)).toHaveProperty("src", "https://cdn.example/label.jpg");
    expect(screen.getByRole("link", { name: /Original listing/ })).toHaveProperty("href", "https://supplier.example/listing/1");
  });

  it("approves and then reloads the queue", async () => {
    vi.mocked(recordLabelDecision).mockResolvedValue({ ok: true, observationId: base.observationId });
    vi.mocked(getLabelReviewPage).mockResolvedValue(page([{ ...base, decision: { decision: "approve", note: "", by: "crm:ari", at: "x" } }]));
    render(<LabelReviewClient initialPage={page([base])} />);
    await userEvent.click(screen.getByRole("button", { name: /Approve/ }));
    await waitFor(() => expect(recordLabelDecision).toHaveBeenCalledWith({ observationId: base.observationId, decision: "approve", note: "", correctedKwh: null }));
    await waitFor(() => expect(getLabelReviewPage).toHaveBeenCalled());
  });

  it("correct asks for the label energy first, prefilled from the reading, then saves it", async () => {
    vi.mocked(recordLabelDecision).mockResolvedValue({ ok: true, observationId: base.observationId });
    vi.mocked(getLabelReviewPage).mockResolvedValue(page([base]));
    render(<LabelReviewClient initialPage={page([base])} />);
    await userEvent.click(screen.getByRole("button", { name: /^Correct/ }));
    const field = screen.getByLabelText("Corrected pack energy in kWh") as HTMLInputElement;
    expect(field.value).toBe("82");
    await userEvent.click(screen.getByRole("button", { name: /Save correction/ }));
    await waitFor(() => expect(recordLabelDecision).toHaveBeenCalledWith(expect.objectContaining({ decision: "correct", correctedKwh: 82 })));
  });

  it("filters to what still differs", async () => {
    const same = { ...base, observationId: "33333333-3333-4333-8333-333333333333", model: "Q3", match: "match" as const };
    render(<LabelReviewClient initialPage={page([base, same])} />);
    expect(screen.queryByText(/Audi Q3/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "To check" }));
    expect(screen.getAllByText(/Audi Q3/).length).toBeGreaterThan(0);
  });
});
