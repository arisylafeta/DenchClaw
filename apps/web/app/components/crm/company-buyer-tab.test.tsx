// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { BuyerTab, type BuyerData } from "./company-buyer-tab";

vi.mock("../bulk-trades/use-registry", async () => {
  const { TEST_REGISTRY } = await import("@/lib/bulk-registry.fixture");
  return { useRegistry: () => TEST_REGISTRY };
});

function buyer(profile: Partial<BuyerData["profile"]>): BuyerData {
  return { profile: { capabilities: [], ...profile } as BuyerData["profile"], engagement: null, demand: [], changes: [] };
}

describe("Buyer profile display", () => {
  it("shows structured researched preferences, evidence, and profiled date separately from demand", () => {
    render(<BuyerTab companyId="co_1" people={[]} onSaved={() => {}} buyer={buyer({
      buyer_profile: { formats: ["Packs"], chemistries: ["LFP"], makes: ["VW"], wants: "Matched packs for storage", evidence_url: "https://example.com/buyer" },
      buyer_profile_basis: "researched", buyer_profiled_at: "2026-10-01",
    })} />);
    const profile = screen.getByRole("region", { name: "Buyer profile" });
    expect(within(profile).getByText("Researched")).toBeInTheDocument();
    expect(profile).toHaveTextContent("Matched packs for storage");
    expect(profile).toHaveTextContent("Chemistry: LFP");
    expect(profile).toHaveTextContent("Format: Packs");
    expect(profile).toHaveTextContent("Vehicle makes: VW");
    expect(profile).toHaveTextContent("Profiled");
    expect(within(profile).getByRole("link", { name: "Evidence" })).toHaveAttribute("href", "https://example.com/buyer");
    expect(screen.getByRole("region", { name: "Demand" })).toHaveTextContent("No demand yet");
  });

  it("shows the empty profile state", () => {
    render(<BuyerTab companyId="co_1" people={[]} onSaved={() => {}} buyer={buyer({})} />);
    expect(screen.getByRole("region", { name: "Buyer profile" })).toHaveTextContent("No buyer profile on file.");
  });
});
