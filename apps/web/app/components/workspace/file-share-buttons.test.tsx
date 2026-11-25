// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileShareButtons } from "./file-share-buttons";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const props = { url: "/api/workspace/raw-file?path=%2Fw%2Forders.xlsx", filePath: "/w/orders.xlsx", filename: "orders.xlsx" };

describe("FileShareButtons", () => {
  it("downloads the file under its name", () => {
    render(<FileShareButtons {...props} />);
    const link = screen.getByRole("link", { name: "Download orders.xlsx" });
    expect(link.getAttribute("href")).toBe(props.url);
    expect(link.getAttribute("download")).toBe("orders.xlsx");
  });

  it("saves to Drive, opens the Google file and then links to it", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ url: "https://docs.google.com/spreadsheets/d/1/edit", converted: true })));
    vi.stubGlobal("fetch", fetch);
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<FileShareButtons {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Open orders.xlsx in Google Drive" }));
    expect(await screen.findByRole("link", { name: "Open orders.xlsx in Google" })).toHaveAttribute("href", "https://docs.google.com/spreadsheets/d/1/edit");
    expect(fetch).toHaveBeenCalledWith("/api/workspace/drive", expect.objectContaining({ method: "POST", body: JSON.stringify({ path: "/w/orders.xlsx" }) }));
    expect(open).toHaveBeenCalledWith("https://docs.google.com/spreadsheets/d/1/edit", "_blank", "noopener,noreferrer");
  });

  it("shows the one-time Connect step when Drive is not connected", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "drive_not_connected" }), { status: 409 })));
    render(<FileShareButtons {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Open orders.xlsx in Google Drive" }));
    expect(await screen.findByRole("dialog", { name: "Connect Google Drive" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Connect Google Drive" })).toBeNull());
  });
});
