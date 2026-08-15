// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PayoutReviewsClient } from "./payout-reviews-client";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("./actions", () => ({
  approvePayoutCopReview: vi.fn(),
  rejectPayoutCopReview: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const review = {
  id: "review-1",
  status: "requested" as const,
  accountId: "account-1",
  accountName: "Acme Recycling",
  accountRole: "recycler",
  payoutProfileStatus: "restricted",
  payoutMethodLast4: "4242",
  payoutCountry: "GB",
  payoutCurrency: "GBP",
  matchResult: "partial_match" as const,
  providerMessage: "Close business-name match",
  requestedAt: "2026-08-15T00:00:00.000Z",
  reviewedAt: null,
  reviewedBy: null,
  reviewReason: null,
};

describe("PayoutReviewsClient", () => {
  it("uses the shared searchable table", async () => {
    const user = userEvent.setup();
    render(<PayoutReviewsClient reviews={[review, { ...review, id: "review-2", accountName: "Other Seller" }]} />);

    const search = screen.getByPlaceholderText("Search payout reviews...");
    await user.type(search, "Acme");

    expect(screen.getByText("Acme Recycling")).toBeInTheDocument();
    expect(screen.queryByText("Other Seller")).not.toBeInTheDocument();
  });
});
