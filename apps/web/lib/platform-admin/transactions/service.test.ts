import { describe, expect, it, vi } from "vitest";
import { refundAndCancelDeal, type DealForRefund, type RefundDeps } from "./service";
import { refundBlocker, transactionNumber, formatMoney } from "./contract";
import { buildRefundIssuedEmail, buildSellerCancelledEmail } from "./emails";

const DEAL_ID = "0b5c6b52-bfd7-4550-8678-c794cf864bfb";

function deal(overrides: Partial<DealForRefund> = {}): DealForRefund {
  return {
    id: DEAL_ID,
    status: "open",
    workflowStep: "payment_confirmed",
    currency: "GBP",
    listingTitle: "Nissan Leaf Acenta 40kWh",
    listingReference: "13478255",
    fundedAmount: 2080,
    refundedAmount: 0,
    paidOutAmount: 0,
    paymentStatus: "funds_held",
    payoutStatus: "held",
    chargeId: "ch_1",
    paymentIntentRef: "pi_1",
    buyer: { email: "buyer@example.com", name: "Jimmy Jørgensen" },
    seller: { email: "seller@example.com", name: "Charles Trent" },
    ...overrides,
  };
}

function makeDeps(overrides: Partial<RefundDeps> = {}): RefundDeps {
  return {
    loadDeal: vi.fn(async () => deal()),
    refundCharge: vi.fn(async () => ({ id: "re_1", amount: 208000, currency: "gbp", created: 1794218702 })),
    finalize: vi.fn(async () => ({ outcome: "cancelled" as const, restoredQuantity: 1 })),
    sendBuyer: vi.fn(async () => ({ success: true, messageId: "m1" })),
    sendSeller: vi.fn(async () => ({ success: true, messageId: "m2" })),
    audit: vi.fn(async () => undefined),
    ...overrides,
  };
}

const confirm = { dealId: DEAL_ID, confirmation: "0B5C6B52", actorEmail: "alex@rebattery.io" };

describe("transactions contract", () => {
  it("numbers a deal by the first 8 hex characters", () => {
    expect(transactionNumber(DEAL_ID)).toBe("0B5C6B52");
  });
  it("formats money", () => {
    expect(formatMoney(2080, "GBP")).toBe("£2,080.00");
  });
  it("blocks refunds once money has moved on", () => {
    const base = { status: "open", paymentStatus: "funds_held", payoutStatus: "held", fundedAmount: 10, refundedAmount: 0, paidOutAmount: 0, paymentIntentRef: "pi" };
    expect(refundBlocker(base)).toBeNull();
    expect(refundBlocker({ ...base, status: "cancelled" })).toBe("Already cancelled");
    expect(refundBlocker({ ...base, paidOutAmount: 5 })).toBe("Seller already paid");
    expect(refundBlocker({ ...base, payoutStatus: "processing" })).toBe("Payout started");
    expect(refundBlocker({ ...base, refundedAmount: 10 })).toBe("Already refunded");
    expect(refundBlocker({ ...base, paymentIntentRef: null })).toBe("No captured payment");
  });
});

describe("refund and cancel orchestration", () => {
  it("refunds, finalizes, then emails buyer and seller", async () => {
    const deps = makeDeps();
    const result = await refundAndCancelDeal(deps, confirm);
    expect(result).toMatchObject({ ok: true, number: "0B5C6B52", refundId: "re_1", alreadyCancelled: false });
    expect(deps.refundCharge).toHaveBeenCalledWith({ chargeId: "ch_1", amountMinor: 208000, currency: "GBP", dealId: DEAL_ID });
    expect(deps.sendBuyer).toHaveBeenCalledWith("buyer@example.com", expect.objectContaining({ firstName: "Jimmy", amount: "£2,080.00", tagNumber: "13478255" }));
    expect(deps.sendSeller).toHaveBeenCalledWith("seller@example.com", expect.objectContaining({ number: "0B5C6B52" }));
  });

  it("refuses without the typed confirmation and never touches Stripe", async () => {
    const deps = makeDeps();
    const result = await refundAndCancelDeal(deps, { ...confirm, confirmation: "nope" });
    expect(result).toMatchObject({ ok: false, stage: "validate" });
    expect(deps.refundCharge).not.toHaveBeenCalled();
  });

  it("does not refund a deal that is blocked", async () => {
    const deps = makeDeps({ loadDeal: vi.fn(async () => deal({ paidOutAmount: 100 })) });
    const result = await refundAndCancelDeal(deps, confirm);
    expect(result).toMatchObject({ ok: false, stage: "validate", error: "Seller already paid" });
    expect(deps.refundCharge).not.toHaveBeenCalled();
  });

  it("stops before the database when Stripe fails", async () => {
    const deps = makeDeps({ refundCharge: vi.fn(async () => { throw new Error("card_declined"); }) });
    const result = await refundAndCancelDeal(deps, confirm);
    expect(result).toMatchObject({ ok: false, stage: "stripe", error: "card_declined" });
    expect(deps.finalize).not.toHaveBeenCalled();
    expect(deps.sendBuyer).not.toHaveBeenCalled();
  });

  it("reports a database failure after a successful refund and sends no email", async () => {
    const deps = makeDeps({ finalize: vi.fn(async () => { throw new Error("boom"); }) });
    const result = await refundAndCancelDeal(deps, confirm);
    expect(result).toMatchObject({ ok: false, stage: "database", refundId: "re_1" });
    expect(deps.sendBuyer).not.toHaveBeenCalled();
  });

  it("keeps the refund when an email fails and reports it", async () => {
    const deps = makeDeps({ sendSeller: vi.fn(async () => ({ success: false, detail: "inactive recipient" })) });
    const result = await refundAndCancelDeal(deps, confirm);
    expect(result).toMatchObject({ ok: true, buyerEmail: { sent: true }, sellerEmail: { sent: false, error: "inactive recipient" } });
  });

  it("skips an email when the account has no address", async () => {
    const deps = makeDeps({ loadDeal: vi.fn(async () => deal({ seller: { email: null, name: null } })) });
    const result = await refundAndCancelDeal(deps, confirm);
    expect(result).toMatchObject({ ok: true, sellerEmail: { sent: false } });
    expect(deps.sendSeller).not.toHaveBeenCalled();
  });

  it("sends no duplicate emails when the database says it was already cancelled", async () => {
    const deps = makeDeps({ finalize: vi.fn(async () => ({ outcome: "already_cancelled" as const })) });
    const result = await refundAndCancelDeal(deps, confirm);
    expect(result).toMatchObject({ ok: true, alreadyCancelled: true });
    expect(deps.sendBuyer).not.toHaveBeenCalled();
  });
});

describe("email copy", () => {
  it("renders the refund template", () => {
    const mail = buildRefundIssuedEmail({ firstName: "Jimmy", listingTitle: "Nissan Leaf Acenta 40kWh", tagNumber: "13478255", amount: "£2,080.00" });
    expect(mail.subject).toBe("Your refund is on the way!");
    expect(mail.html).toContain("Hi Jimmy,");
    expect(mail.html).toContain("<strong>Tag number:</strong> 13478255");
    expect(mail.html).toContain("https://www.rebattery.io/buyer/dashboard");
    expect(mail.text).toContain("- Amount refunded: £2,080.00");
  });
  it("escapes html in names and titles", () => {
    const mail = buildRefundIssuedEmail({ firstName: "<b>x</b>", listingTitle: "A&B", tagNumber: null, amount: "£1.00" });
    expect(mail.html).not.toContain("<b>x</b>");
    expect(mail.html).toContain("A&amp;B");
    expect(mail.html).not.toContain("Tag number");
  });
  it("renders the seller notice", () => {
    const mail = buildSellerCancelledEmail({ firstName: "Charles", number: "0B5C6B52", listingTitle: "Nissan Leaf" });
    expect(mail.subject).toBe("Transaction #0B5C6B52 has been cancelled");
    expect(mail.html).toContain("Transaction #0B5C6B52 for Nissan Leaf has been cancelled");
  });
});
