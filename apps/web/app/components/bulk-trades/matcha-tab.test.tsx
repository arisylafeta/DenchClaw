// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/dynamic", () => ({ default: () => (props: Record<string, unknown>) => <div data-testid="chat" onClick={() => (props.onBranched as (c: unknown) => void)({ key: "solo:matcha:2", title: "n" })} data-key={String(props.nativeConversationKey)} data-path={(props.fileContext as { path: string }).path} /> }));
import { MatchaTab } from "./matcha-tab";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("MatchaTab", () => {
  it("opens the chat only once the tab is visited, with the listing as context", async () => {
    const fetchMock = vi.fn(async () => Response.json({ conversation: { key: "solo:matcha:1", title: "t" }, transport: "gateway" }));
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<MatchaTab listingId="btd_1" active={false} />);
    expect(fetchMock).not.toHaveBeenCalled();
    rerender(<MatchaTab listingId="btd_1" active />);
    expect(await screen.findByTestId("chat")).toHaveAttribute("data-key", "solo:matcha:1");
    expect(screen.getByTestId("chat")).toHaveAttribute("data-path", "~trades-preview/listing/btd_1");
    expect(fetchMock).toHaveBeenCalledWith("/api/bulk-listings/btd_1/matcha-chat", { method: "POST" });
    rerender(<MatchaTab listingId="btd_1" active={false} />);
    expect(screen.getByTestId("chat")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows the error when the chat cannot be opened", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Hermes is not enabled" }, { status: 404 })));
    render(<MatchaTab listingId="btd_1" active />);
    await waitFor(() => expect(screen.getByText(/Hermes is not enabled/)).toBeInTheDocument());
  });

  it("follows /new: shows the new chat and re-pins the listing to it", async () => {
    const fetchMock = vi.fn(async () => Response.json({ conversation: { key: "solo:matcha:1", title: "t" }, transport: "gateway" }));
    vi.stubGlobal("fetch", fetchMock);
    render(<MatchaTab listingId="btd_1" active />);
    fireEvent.click(await screen.findByTestId("chat"));
    await waitFor(() => expect(screen.getByTestId("chat")).toHaveAttribute("data-key", "solo:matcha:2"));
    expect(fetchMock).toHaveBeenCalledWith("/api/bulk-listings/btd_1/matcha-chat", expect.objectContaining({ method: "PUT", body: JSON.stringify({ key: "solo:matcha:2" }) }));
  });
});
