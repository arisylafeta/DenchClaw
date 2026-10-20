// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VisualBlock } from "./visual-block";

describe("VisualBlock", () => {
  it("shows a drawing placeholder, and no iframe, while the fence is still streaming", () => {
    const { container } = render(<VisualBlock code="<svg>" closed={false} />);
    expect(screen.getByText("Drawing…")).toBeInTheDocument();
    expect(container.querySelector("iframe")).toBeNull();
  });
  it("renders a scripts-only sandbox with no same-origin access once closed", async () => {
    const { container } = render(<VisualBlock code="<svg></svg>" closed />);
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("srcdoc")).toContain("<svg></svg>");
  });
  it("relays sendPrompt as a suggestion the user must confirm, ignoring other windows", async () => {
    const onSend = vi.fn();
    const { container } = render(<VisualBlock code="<svg></svg>" closed onSendPrompt={onSend} />);
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const frame = container.querySelector("iframe")!;
    const srcdoc = frame.getAttribute("srcdoc")!;
    const id = /var id="(visual-\d+)"/.exec(srcdoc)![1];
    act(() => { window.dispatchEvent(new MessageEvent("message", { data: { type: "visual-send", id, text: "go with design 2" }, source: window })); });
    expect(screen.queryByText(/Send “go with design 2”/)).toBeNull();
    act(() => { window.dispatchEvent(new MessageEvent("message", { data: { type: "visual-send", id, text: "go with design 2" }, source: frame.contentWindow })); });
    expect(await screen.findByText(/Send “go with design 2”/)).toBeInTheDocument();
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith("go with design 2");
  });
});
