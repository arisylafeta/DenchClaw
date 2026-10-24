// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DocumentsTab } from "./documents-tab";
import { forgetShared } from "./trade-ui";

vi.mock("./use-registry", async () => {
  const { TEST_REGISTRY } = await import("@/lib/bulk-registry.fixture");
  return { useRegistry: () => TEST_REGISTRY };
});

const doc = (over: object) => ({ id: "d1", title: "Doc", doc_type: "Other", state: "received", direction: "received", has_file: false, file_name: null,
  content_type: null, byte_size: null, url: "https://example.test/a", note: null, source_label: null, source_date: null, visibility: "never",
  created_at: "2026-10-01T00:00:00Z", ...over });

afterEach(() => { vi.unstubAllGlobals(); forgetShared(); });

describe("DocumentsTab", () => {
  it("keeps document groups and card structure visible while values load", async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => { resolve = r; })));
    render(<DocumentsTab listingId="d1" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading documents");
    for (const title of ["Received", "Ours"]) expect(screen.getByRole("heading", { name: new RegExp(title) })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByRole("heading", { name: /Needed/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Buyer spec")).not.toBeInTheDocument();
    await act(async () => resolve(new Response(JSON.stringify({ documents: [doc({ title: "Buyer spec" })] }))));
    expect(await screen.findByText("Buyer spec")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Received · 1" })).toBeInTheDocument();
  });

  it("groups documents into received and ours, with no needed section and nothing for required types", async () => {
    const documents = [
      doc({ id: "n1", title: "Toyota pack datasheet", state: "needed" }),
      doc({ id: "r1", title: "Buyer spec", doc_type: "Datasheet" }),
      doc({ id: "o1", title: "RFS draft", doc_type: "RFS", direction: "prepared", state: "draft" }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ documents }))));
    render(<DocumentsTab listingId="d1" />);
    expect(await screen.findByRole("heading", { name: "Received · 2" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Needed/ })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Ours · 1" })).toBeInTheDocument();
    expect(screen.queryByText("BMS or test report")).not.toBeInTheDocument();
  });

  it("opens a link in a new tab and has no add buttons", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ documents: [doc({ id: "l1", title: "Granola call notes" })] }))));
    render(<DocumentsTab listingId="d1" />);
    expect(await screen.findByRole("link", { name: "Granola call notes" })).toHaveAttribute("target", "_blank");
    for (const name of ["Upload", "Add link", "Ask for a document"]) expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
  });
});
