// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AttachmentStrip, formatBytes } from "./attachment-strip";

afterEach(() => vi.unstubAllGlobals());
const respond = (body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body))));

describe("attachment strip", () => {
  it("links each file to its download endpoint with size", async () => {
    respond({ attachments: [{ filename: "Packs & prices.xlsx", mediaType: "x", sizeBytes: 25641 }] });
    render(<AttachmentStrip messageId="gmail_msg_1" />);
    const link = await screen.findByRole("link", { name: /Packs & prices\.xlsx/ });
    expect(link).toHaveAttribute("href", "/api/mail/messages/gmail_msg_1/attachments/download?name=Packs%20%26%20prices.xlsx");
    expect(link).toHaveTextContent("25 KB");
  });
  it("renders nothing when there are only inline images", async () => {
    respond({ attachments: [] });
    const { container } = render(<AttachmentStrip messageId="m" />);
    await vi.waitFor(() => expect(container.querySelector('[aria-label="Attachments"]')).toBeNull());
  });
  it("says why attachments could not load", async () => {
    respond({ unavailable: "gmail_auth_unavailable" });
    render(<AttachmentStrip messageId="m" />);
    expect(await screen.findByRole("status")).toHaveTextContent("gmail_auth_unavailable");
  });
  it("formats sizes", () => { expect([formatBytes(900), formatBytes(2048), formatBytes(5 * 1024 * 1024), formatBytes(null)]).toEqual(["900 B", "2 KB", "5.0 MB", ""]); });
});
