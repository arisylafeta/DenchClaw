// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getLabelReviewPage, recordLabelGroupDecision } from "./actions";
import { LabelReviewClient } from "./label-review-client";
import type { LabelReviewEntry, LabelReviewPage } from "./contract";

vi.mock("./actions", () => ({ getLabelReviewPage: vi.fn(), recordLabelGroupDecision: vi.fn() }));
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
    expect(screen.getByText(/Label differs from stored value/)).toBeTruthy();
    expect(screen.getAllByText(/82 kWh/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/77 kWh/).length).toBeGreaterThan(0);
    expect(screen.getByText(/independent_review/)).toBeTruthy();
    expect(screen.getByAltText(/Supplier photo of Audi Q4/)).toHaveProperty("src", "https://cdn.example/label.jpg");
    expect(screen.getByRole("group", { name: "Photos" }).querySelectorAll("button").length).toBe(2);
    expect(screen.getByRole("link", { name: /Original listing/ })).toHaveProperty("href", "https://supplier.example/listing/1");
  });

  it("approves and then reloads the queue", async () => {
    vi.mocked(recordLabelGroupDecision).mockResolvedValue({ ok: true, done: 1, skipped: 0 });
    vi.mocked(getLabelReviewPage).mockResolvedValue(page([{ ...base, decision: { decision: "approve", note: "", by: "crm:ari", at: "x" } }]));
    render(<LabelReviewClient initialPage={page([base])} />);
    await userEvent.click(screen.getByRole("button", { name: /Approve 1/ }));
    await waitFor(() => expect(recordLabelGroupDecision).toHaveBeenCalledWith({ observationIds: [base.observationId], decision: "approve", note: "", correctedKwh: null }));
    await waitFor(() => expect(getLabelReviewPage).toHaveBeenCalled());
  });

  it("correct asks for the label energy first, prefilled from the reading, then saves it", async () => {
    vi.mocked(recordLabelGroupDecision).mockResolvedValue({ ok: true, done: 1, skipped: 0 });
    vi.mocked(getLabelReviewPage).mockResolvedValue(page([base]));
    render(<LabelReviewClient initialPage={page([base])} />);
    await userEvent.click(screen.getByRole("button", { name: /^Correct/ }));
    const field = screen.getByLabelText("Corrected pack energy in kWh") as HTMLInputElement;
    expect(field.value).toBe("82");
    await userEvent.click(screen.getByRole("button", { name: /Save correction/ }));
    await waitFor(() => expect(recordLabelGroupDecision).toHaveBeenCalledWith(expect.objectContaining({ decision: "correct", correctedKwh: 82 })));
  });

  it("shows one entry per part code and approves every reading in the group at once", async () => {
    const second = { ...base, observationId: "33333333-3333-4333-8333-333333333333", itemId: "44444444-4444-4444-8444-444444444444", model: "Q4 e-tron", match: "match" as const, parsed: { kwh: 77, voltage: 352, ah: 234 } };
    const other = { ...base, observationId: "55555555-5555-4555-8555-555555555555", partNumbers: ["1EA915910AC"], model: "Q3", match: "match" as const };
    vi.mocked(recordLabelGroupDecision).mockResolvedValue({ ok: true, done: 2, skipped: 0 });
    vi.mocked(getLabelReviewPage).mockResolvedValue(page([base, second, other]));
    render(<LabelReviewClient initialPage={page([base, second, other])} />);
    const nav = screen.getByRole("navigation", { name: "Part codes" });
    expect(nav.querySelectorAll("button").length).toBe(1);
    expect(screen.getAllByText(/2 rows/).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: /Approve 2/ }));
    await waitFor(() => expect(recordLabelGroupDecision).toHaveBeenCalledWith(expect.objectContaining({ observationIds: [base.observationId, second.observationId], decision: "approve" })));
  });

  it("filters groups to what still needs a check", async () => {
    const same = { ...base, observationId: "33333333-3333-4333-8333-333333333333", partNumbers: ["1EA915910AC"], model: "Q3", match: "match" as const };
    render(<LabelReviewClient initialPage={page([base, same])} />);
    expect(screen.getByRole("navigation", { name: "Part codes" }).querySelectorAll("button").length).toBe(1);
    await userEvent.click(screen.getByRole("button", { name: "To check" }));
    expect(screen.getByRole("navigation", { name: "Part codes" }).querySelectorAll("button").length).toBe(2);
  });

  it("opens the photo full screen, steps with the arrow keys and closes with Escape", async () => {
    render(<LabelReviewClient initialPage={page([base])} />);
    await userEvent.click(screen.getByRole("button", { name: "Open photo in full view" }));
    const dialog = screen.getByRole("dialog", { name: "Photo full view" });
    expect(dialog.querySelector("img")).toHaveProperty("src", "https://cdn.example/label.jpg");
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("dialog", { name: "Photo full view" }).querySelector("img")).toHaveProperty("src", "https://cdn.example/other.jpg");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("picks a photo from the carousel strip", async () => {
    render(<LabelReviewClient initialPage={page([base])} />);
    await userEvent.click(screen.getByRole("button", { name: "Photo 2" }));
    expect(screen.getByAltText(/Supplier photo of Audi Q4/)).toHaveProperty("src", "https://cdn.example/other.jpg");
  });
});
