// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DossiersToReview } from "./dossiers-to-review";

const DOSSIERS = [
  {
    company_id: "co_a",
    name: "Example Modules Ltd",
    stale_since: "2026-11-02",
    reasons: [{ date: "2026-11-02", reason: "new saved search", source_id: "saved_search:9" }],
    version: 4,
  },
  {
    company_id: "co_b",
    name: "Synthetic Energy Ltd",
    stale_since: "2026-11-05",
    reasons: [
      { date: "2026-11-05", reason: "survey answer", source_id: "formbricks:2" },
      { date: "2026-11-06", reason: "sourcing request", source_id: "sourcing_request:3" },
    ],
    version: 2,
  },
];

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ count: DOSSIERS.length, dossiers: DOSSIERS }) }) as Response));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dossiers to review", () => {
  it("lists the flagged buyers with their first dated reason", async () => {
    render(<DossiersToReview onOpenCompany={() => {}} />);
    expect(await screen.findByText("Example Modules Ltd")).toBeTruthy();
    expect(screen.getByText("2 buyers")).toBeTruthy();
    expect(screen.getByText(/new saved search/)).toBeTruthy();
    expect(screen.getByText(/survey answer/)).toBeTruthy();
    expect(screen.getByText(/1 more/)).toBeTruthy();
  });

  it("opens the company so the dossier can be read and marked reviewed", async () => {
    const opened: string[] = [];
    render(<DossiersToReview onOpenCompany={(id) => opened.push(id)} />);
    fireEvent.click(await screen.findByText("Example Modules Ltd"));
    await waitFor(() => expect(opened).toEqual(["co_a"]));
  });

  it("renders nothing when no dossier is waiting", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ count: 0, dossiers: [] }) }) as Response));
    const { container } = render(<DossiersToReview onOpenCompany={() => {}} />);
    await waitFor(() => expect(container.querySelector("[data-dossiers-to-review]")).toBeNull());
    expect(screen.queryByText("Dossiers to review")).toBeNull();
  });
});
