import { describe, expect, it } from "vitest";
import { contentUsesFullView } from "./content-layout";

describe("contentUsesFullView", () => {
  it("gives payout reviews the full workspace canvas", () => {
    expect(contentUsesFullView("~platform-admin/payout-reviews")).toBe(true);
  });

  it("keeps the split view for the other admin pages", () => {
    expect(contentUsesFullView("~platform-admin/accounts")).toBe(false);
    expect(contentUsesFullView("~platform-admin/battery-review")).toBe(false);
    expect(contentUsesFullView("~platform-admin/proposals")).toBe(false);
  });
});
