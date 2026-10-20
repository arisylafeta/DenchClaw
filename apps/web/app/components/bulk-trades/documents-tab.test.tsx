// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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
  it("groups documents into needed, received and ours, and shows nothing for required types on a demand", async () => {
    const documents = [
      doc({ id: "n1", title: "Toyota pack datasheet", state: "needed" }),
      doc({ id: "r1", title: "Buyer spec", doc_type: "Datasheet" }),
      doc({ id: "o1", title: "RFS draft", doc_type: "RFS", direction: "prepared", state: "draft" }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ documents }))));
    render(<DocumentsTab listingId="d1" wantsRequired={false} />);
    expect(await screen.findByRole("heading", { name: "Needed · 1" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Received · 1" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Ours · 1" })).toBeInTheDocument();
    expect(screen.queryByText("BMS or test report")).not.toBeInTheDocument();
  });

  it("opens a link in a new tab and has no add buttons", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ documents: [doc({ id: "l1", title: "Granola call notes" })] }))));
    render(<DocumentsTab listingId="d1" wantsRequired={false} />);
    expect(await screen.findByRole("link", { name: "Granola call notes" })).toHaveAttribute("target", "_blank");
    for (const name of ["Upload", "Add link", "Ask for a document"]) expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
  });

  it("marks a required type as requested without a file", async () => {
    const created = doc({ id: "n3", title: "Photos", doc_type: "Photos", state: "needed", url: null });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify(init?.method === "POST" ? { document: created } : { documents: [] })));
    vi.stubGlobal("fetch", fetchMock);
    render(<DocumentsTab listingId="bt_1" wantsRequired />);
    const needed = (await screen.findByRole("heading", { name: /Needed · 4/ })).closest("section")!;
    await userEvent.click(within(needed).getAllByRole("button", { name: "Mark as requested" })[0]);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/bulk-listings/bt_1/documents", expect.objectContaining({
      method: "POST", body: JSON.stringify({ title: "Photos", doc_type: "Photos", state: "needed" }),
    })));
  });
});
