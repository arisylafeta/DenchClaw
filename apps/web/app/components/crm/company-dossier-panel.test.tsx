// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DossierPanel } from "./company-dossier-panel";

const DOSSIER = {
  company_id: "co_1",
  text: "---\ncompany_id: co_1\nlast_verified: \"2026-07-02\"\n---\n## What they buy\n\nSecond-life MEB packs.",
  body: "## What they buy\n\nSecond-life MEB packs.",
  frontmatter: { company_id: "co_1", last_verified: "2026-07-02" },
  version: 3,
  updated_at: "2026-11-07 09:00:00+00",
  stale_since: "2026-11-02",
  stale_reasons: [{ date: "2026-11-02", reason: "new saved search", source_id: "saved_search:41" }],
  last_verified: "2026-07-02",
  saved_searches: [
    { id: "ccn_1", note: "LFP packs under 60 kWh", observed_on: "2026-11-02", source_kind: "saved_search", source_ref: "saved_search:41", source_url: null },
  ],
};

const calls: { url: string; method: string; body?: unknown }[] = [];
let getResponse: unknown = DOSSIER;
let patchResponse: { status: number; body: unknown } = { status: 200, body: { ok: true, version: 4 } };
let postResponse: { status: number; body: unknown } = { status: 200, body: { ok: true } };

function json(body: unknown, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: async () => body } as Response);
}

beforeEach(() => {
  calls.length = 0;
  getResponse = DOSSIER;
  patchResponse = { status: 200, body: { ok: true, version: 4 } };
  postResponse = { status: 200, body: { ok: true } };
  vi.stubGlobal("fetch", vi.fn((url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) as unknown : undefined });
    if (method === "GET") return json(getResponse);
    if (method === "PATCH") return json(patchResponse.body, patchResponse.status);
    return json(postResponse.body, postResponse.status);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dossier panel", () => {
  it("renders the dossier body, when it was last verified, the stale reasons and the saved searches", async () => {
    render(<DossierPanel companyId="co_1" />);
    expect(await screen.findByText(/Second-life MEB packs/)).toBeTruthy();
    expect(screen.getByText("v3")).toBeTruthy();
    expect(screen.getByText(/Last verified/)).toBeTruthy();
    expect(screen.getByText("Needs review since", { exact: false })).toBeTruthy();
    expect(screen.getByText(/new saved search/)).toBeTruthy();
    expect(screen.getByText(/LFP packs under 60 kWh/)).toBeTruthy();
  });

  it("saves the editor text with the version it loaded", async () => {
    render(<DossierPanel companyId="co_1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit dossier" }));
    const textarea = screen.getByLabelText("Dossier text") as HTMLTextAreaElement;
    expect(textarea.value).toContain("Second-life MEB packs.");
    fireEvent.change(textarea, { target: { value: "---\ncompany_id: co_1\n---\nEdited" } });
    fireEvent.click(screen.getByRole("button", { name: "Save dossier" }));
    await waitFor(() => expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(1));
    expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({
      text: "---\ncompany_id: co_1\n---\nEdited",
      expected_version: 3,
    });
    await waitFor(() => expect(screen.getByText("Saved.")).toBeTruthy());
  });

  it("keeps the draft on a conflict and offers the latest version", async () => {
    const latest = "---\ncompany_id: co_1\n---\nNewer text from someone else.";
    patchResponse = {
      status: 409,
      body: { error: "The dossier changed while you were editing it.", current_version: 5, current_text: latest },
    };
    render(<DossierPanel companyId="co_1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit dossier" }));
    const textarea = screen.getByLabelText<HTMLTextAreaElement>("Dossier text");
    fireEvent.change(textarea, { target: { value: "my draft in progress" } });
    fireEvent.click(screen.getByRole("button", { name: "Save dossier" }));

    expect(await screen.findByText(/Someone saved this dossier while you were editing it \(now v5\)/)).toBeTruthy();
    // The user's own text is untouched, and the other version is readable without replacing it.
    expect(screen.getByLabelText<HTMLTextAreaElement>("Dossier text").value).toBe("my draft in progress");
    expect(screen.getByText(/Newer text from someone else/)).toBeTruthy();
    expect(screen.queryByText("Saved.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Load latest" }));
    await waitFor(() => expect(screen.getByLabelText<HTMLTextAreaElement>("Dossier text").value).toBe(DOSSIER.text));
    expect(screen.queryByText(/Someone saved this dossier/)).toBeNull();
  });

  it("lists validation errors and keeps the editor open", async () => {
    patchResponse = { status: 400, body: { error: "Dossier has errors.", errors: ["products[0].status: required (one of bought, asked, said_interested, declined)"] } };
    render(<DossierPanel companyId="co_1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit dossier" }));
    fireEvent.click(screen.getByRole("button", { name: "Save dossier" }));
    expect(await screen.findByText(/products\[0\]\.status/)).toBeTruthy();
    expect(screen.getByLabelText("Dossier text")).toBeTruthy();
  });

  it("marks the dossier reviewed", async () => {
    render(<DossierPanel companyId="co_1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Mark reviewed" }));
    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({ action: "mark_reviewed" });
    await waitFor(() => expect(screen.getByText("Marked reviewed.")).toBeTruthy());
  });

  it("reports a failed mark-reviewed in the message area, not as a load error", async () => {
    postResponse = { status: 500, body: { error: "boom" } };
    render(<DossierPanel companyId="co_1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Mark reviewed" }));
    expect(await screen.findByText("Could not mark the dossier reviewed.")).toBeTruthy();
    expect(screen.queryByText(/Could not load the dossier/)).toBeNull();
    expect(screen.getByText(/Second-life MEB packs/)).toBeTruthy();
  });

  it("says so when the stored text already matches", async () => {
    patchResponse = { status: 200, body: { ok: true, version: 3, unchanged: true } };
    render(<DossierPanel companyId="co_1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit dossier" }));
    fireEvent.click(screen.getByRole("button", { name: "Save dossier" }));
    expect(await screen.findByText(/No change: the dossier already matches/)).toBeTruthy();
    expect(screen.getByText("v3")).toBeTruthy();
  });

  it("says there is no dossier yet and offers to add one", async () => {
    getResponse = { ...DOSSIER, text: null, body: null, frontmatter: null, version: 0, stale_since: null, stale_reasons: [], last_verified: null, saved_searches: [] };
    render(<DossierPanel companyId="co_1" />);
    expect(await screen.findByText(/No dossier yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add dossier" }));
    expect((screen.getByLabelText("Dossier text") as HTMLTextAreaElement).value).toContain('company_id: "co_1"');
  });
});
