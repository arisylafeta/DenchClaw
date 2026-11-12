// @vitest-environment jsdom
import React from "react";
import { expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { BuyerCardData } from "@/lib/buyer-card";
import { BuyerCardBody } from "./buyer-card";

const card: BuyerCardData = {
  basis: "dossier", priceTopic: "MEB 82 kWh packs",
  target: { low: 20, high: 25, seen: "2026-08-21" },
  paid: { low: 26.5, high: 34, count: 2, last: "2026-05-05", points: [{ eur_per_kwh: 26.5, seen: "2025-10-24", text: "" }, { eur_per_kwh: 34, seen: "2026-05-05", text: "" }] },
  others: { low: 30, high: 33, count: 2 },
  chips: [{ label: "MEB 82 kWh", seen: "2025-10-22", bought: true }, { label: "Zoe 41 kWh", seen: "2026-09-30", bought: false }, { label: "STLA-M", seen: null, bought: false }, { label: "BMW", seen: null, bought: false }],
  facts: [{ label: "Format", value: "Packs" }, { label: "Typical order", value: "20 packs" }],
  pastIssue: "2025-11-11: customs dispute", decides: "Decides fast", verified: "2026-11-05",
};

it("shows the price benchmark, bought products, facts and the past issue as scan data", () => {
  render(<BuyerCardBody card={card} loading={false} profileHref="/?entry=company:c1" related={[]} />);
  expect(screen.getByRole("heading", { name: /MEB 82 kWh packs/ })).toBeInTheDocument();
  expect(screen.getByText("20–25")).toBeInTheDocument();
  expect(screen.getByText("26.5–34")).toBeInTheDocument();
  expect(screen.getByText("2 deals, last May 2026")).toBeInTheDocument();
  expect(screen.getByText("30–33")).toBeInTheDocument();
  expect(screen.getByRole("img", { name: /their target 20–25; they paid 26.5, 34; others paid 30–33 over 2/ })).toBeInTheDocument();
  expect(screen.getByLabelText("Bought from us")).toBeInTheDocument();
  expect(screen.queryByText("BMW")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "+1 more" }));
  expect(screen.getByText("BMW")).toBeInTheDocument();
  expect(screen.getByText("20 packs")).toBeInTheDocument();
  expect(screen.getByLabelText("Past issue: 2025-11-11: customs dispute")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Dossier" })).toHaveAttribute("href", "/?entry=company:c1");
  expect(screen.getByText("Verified 5 Nov 2026")).toBeInTheDocument();
});

it("says None yet instead of a number it does not have, and hides the price for a researched buyer", () => {
  const { rerender } = render(<BuyerCardBody card={{ ...card, basis: "stated", target: null, paid: null }} loading={false} profileHref={null} />);
  expect(screen.getAllByText("None yet")).toHaveLength(2);
  rerender(<BuyerCardBody card={{ ...card, basis: "researched", target: null, paid: null, others: null }} loading={false} profileHref={null} />);
  expect(screen.queryByText("Their target")).not.toBeInTheDocument();
  expect(screen.getByText("from web research, not confirmed")).toBeInTheDocument();
});
