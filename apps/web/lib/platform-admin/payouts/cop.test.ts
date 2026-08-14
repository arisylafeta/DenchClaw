import { describe, expect, it } from "vitest";
import { normalisePayoutReviewContext } from "./cop";

const activeRecipient = {
  id: "acct_recipient_1",
  requirements: { entries: [] },
  configuration: {
    recipient: {
      capabilities: { bank_accounts: { local: { status: "active" } } },
      default_outbound_destination: {
        id: "gbba_test_1",
        type: "gb_bank_account",
      },
    },
  },
};

describe("payout review context", () => {
  it("normalises a reviewable mismatch without retaining bank names", () => {
    const context = normalisePayoutReviewContext(activeRecipient, {
      id: "gbba_test_1",
      last4: "2345",
      confirmation_of_payee: {
        status: "awaiting_acknowledgement",
        result: {
          created: "2026-07-16T12:00:00.000Z",
          match_result: "partial_match",
          message: "The beneficiary name partially matched.",
          provided: { name: "Sensitive provided name" },
          matched: { name: "Sensitive matched name" },
        },
      },
    });

    expect(context).toEqual({
      recipientId: "acct_recipient_1",
      payoutMethodId: "gbba_test_1",
      payoutMethodType: "gb_bank_account",
      accountReadiness: "active",
      requirementsDue: 0,
      confirmationOfPayeeStatus: "awaiting_acknowledgement",
      confirmationOfPayeeMatchResult: "partial_match",
      confirmationOfPayeeMessage: "The beneficiary name partially matched.",
      confirmationOfPayeeCheckedAt: "2026-07-16T12:00:00.000Z",
    });
    expect(JSON.stringify(context)).not.toContain("Sensitive");
  });

  it("keeps readiness pending while requirements remain", () => {
    const context = normalisePayoutReviewContext(
      {
        ...activeRecipient,
        requirements: { entries: [{ field: "identity" }] },
      },
      {
        confirmation_of_payee: {
          status: "confirmed",
          result: { match_result: "match" },
        },
      },
    );

    expect(context.accountReadiness).toBe("pending");
    expect(context.requirementsDue).toBe(1);
  });
});
