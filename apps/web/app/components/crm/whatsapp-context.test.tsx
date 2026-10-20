// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WhatsappContext, WhatsappConversation, WhatsappIdentityList } from "./whatsapp-context";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("WhatsApp read-only context", () => {
  it("shows 1:1 and shared groups from the canonical profile endpoint", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        threads: [
          { id: "direct", kind: "direct", subject: "Direct fixture", message_count: "2" },
          { id: "group", kind: "group", subject: "Group fixture", message_count: "5" },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetch);
    render(<WhatsappContext personId="person" />);
    expect(await screen.findByText("Group fixture")).toBeInTheDocument();
    expect(screen.getByText("1:1")).toBeInTheDocument();
    expect(screen.getByText("Group · shared context")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Group fixture/ })).toHaveAttribute(
      "href",
      "/whatsapp/threads/group",
    );
    expect(fetch.mock.calls[0][0]).toContain("personId=person");
  });
  it("labels unknown senders, edits, tombstones, unresolved replies and undownloaded media without send controls", async () => {
    const base = {
      direction: "inbound",
      sender_name: null,
      sender_person_name: null,
      occurred_at: "2026-01-01",
      captured_at: "2026-01-01",
      timestamp_source: "capture",
      metadata: {},
      attachment: null,
      edit_version: 0,
      reply_to_provider_id: null,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          thread: { kind: "group", subject: "Group fixture" },
          messages: [
            {
              ...base,
              id: "edited",
              edit_version: 1,
              body: "Edited fixture",
              reply_to_provider_id: "missing",
            },
            { ...base, id: "media", attachment: { type: "audio" }, body: null },
            { ...base, id: "deleted", deleted_at: "2026-01-01", body: null },
          ],
          capture_status: null,
        }),
      }),
    );
    render(<WhatsappConversation id="group" />);
    expect(await screen.findByText("Edited fixture")).toBeInTheDocument();
    // Consecutive unknown-sender messages share one run, so the sender is named once.
    expect(screen.getAllByText("Unknown sender")).toHaveLength(1);
    expect(screen.getByText("Edited")).toBeInTheDocument();
    expect(screen.getByText("Message deleted")).toBeInTheDocument();
    expect(screen.getByText(/audio · content not downloaded/)).toBeInTheDocument();
    expect(screen.getByText(/Reply to an unavailable/)).toBeInTheDocument();
    expect(screen.getByLabelText("History limitations")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send|reply/i })).not.toBeInTheDocument();
  });
  it("confirms an existing proposed person without creating a CRM contact", async () => {
    const fetch = vi
      .fn()
      .mockImplementation(async (_url: string, options?: RequestInit) =>
        options?.method === "POST"
          ? { ok: true, json: async () => ({ id: "link" }) }
          : {
              ok: true,
              json: async () => ({
                identities: [
                  {
                    id: "identity",
                    display_name: "Fixture identity",
                    shared: false,
                    links: [],
                    candidates: [{ id: "person", name: "Synthetic person" }],
                  },
                ],
                people: [],
              }),
            },
      );
    vi.stubGlobal("fetch", fetch);
    render(<WhatsappIdentityList />);
    fireEvent.click(await screen.findByRole("button", { name: "Confirm Synthetic person" }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/whatsapp/identities",
        expect.objectContaining({
          method: "POST",
          body: '{"identityId":"identity","personId":"person"}',
        }),
      ),
    );
  });
});

import { groupRuns } from "./whatsapp-chat";
import type { WhatsappMessage } from "@/lib/crm-postgres/whatsapp";
import { whatsappChatLabel } from "@/lib/whatsapp-display";
const msg = (id: string, direction: string, at: string): WhatsappMessage => ({ id, direction, body: id, sender_name: null, sender_person_name: null, attachment: null, occurred_at: at, captured_at: at, timestamp_source: "provider", reply_to_provider_id: null, reply_to_message_id: null, reply_body: null, edit_version: 0, deleted_at: null, metadata: {} });
describe("WhatsApp transcript grouping and names", () => {
  it("groups same-side messages under five minutes and breaks on side, gap and day", () => {
    const runs = groupRuns([msg("a", "inbound", "2026-10-20T09:00:00Z"), msg("b", "inbound", "2026-10-20T09:03:00Z"), msg("c", "outbound", "2026-10-20T09:04:00Z"), msg("d", "outbound", "2026-10-20T09:20:00Z"), msg("e", "outbound", "2026-10-21T09:20:00Z")]);
    expect(runs.map((run) => run.messages.map((m) => m.id).join(""))).toEqual(["ab", "c", "d", "e"]);
    expect(runs.map((run) => run.newDay)).toEqual([true, false, false, true]);
  });
  it("marks greeting-inferred names and falls back to a short id", () => {
    expect(whatsappChatLabel({ id: "abcdef123", kind: "direct", name: "Jakub", name_source: "greeting" })).toMatchObject({ text: "Jakub", inferred: true });
    expect(whatsappChatLabel({ id: "abcdef123", kind: "direct", name: "Mathieu", name_source: "person" }).inferred).toBe(false);
    expect(whatsappChatLabel({ id: "abcdef123", kind: "group" }).text).toBe("Group abcdef");
    expect(whatsappChatLabel({ id: "abcdef123", kind: "direct" }).text).toBe("Contact abcdef");
  });
});
