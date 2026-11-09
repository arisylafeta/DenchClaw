// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AttachmentStrip, formatBytes } from "./attachment-strip";

afterEach(() => vi.unstubAllGlobals());
const respond = (body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body))));

describe("attachment strip", () => {
  it("links each file to its download endpoint with size", async () => {
    respond({ attachments: [{ filename: "Packs & prices.xlsx", mediaType: "x", sizeBytes: 25641 }] });
    render(<AttachmentStrip messageId="gmail_msg_1" />);
    const link = await screen.findByRole("link", { name: "Download Packs & prices.xlsx" });
    expect(link).toHaveAttribute("href", "/api/mail/messages/gmail_msg_1/attachments/download?name=Packs%20%26%20prices.xlsx");
    expect(screen.getByText("25 KB")).toBeInTheDocument();
  });
  it("saves a file to Drive and opens it", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/drive")
      ? { url: "https://docs.google.com/document/d/D1/edit", converted: true, name: "a" }
      : { attachments: [{ filename: "a.docx", mediaType: "x", sizeBytes: 10 }] })));
    vi.stubGlobal("fetch", fetchMock);
    render(<AttachmentStrip messageId="m1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Save a.docx to Google Drive" }));
    expect(await screen.findByRole("link", { name: "Open a.docx in Drive" })).toHaveAttribute("href", "https://docs.google.com/document/d/D1/edit");
    expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/m1/attachments/drive", expect.objectContaining({ method: "POST", body: JSON.stringify({ name: "a.docx" }) }));
    expect(open).toHaveBeenCalledWith("https://docs.google.com/document/d/D1/edit", "_blank", "noopener");
  });
  it("offers to connect Drive when the account has no Drive access", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/drive")
      ? new Response(JSON.stringify({ error: "drive_not_connected" }), { status: 409 })
      : new Response(JSON.stringify({ attachments: [{ filename: "a.pdf", mediaType: "x", sizeBytes: 10 }] }))));
    render(<AttachmentStrip messageId="m1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Save a.pdf to Google Drive" }));
    expect(await screen.findByRole("dialog", { name: "Connect Google Drive" })).toBeInTheDocument();
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
