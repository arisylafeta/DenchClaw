// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatPanelTerminalButton } from "./chat-panel";

describe("ChatPanelTerminalButton", () => {
  it("keeps the terminal action visible and toggles the drawer", async () => {
    const user = userEvent.setup();
    const onToggleTerminal = vi.fn();

    const { rerender } = render(
      <ChatPanelTerminalButton onToggleTerminal={onToggleTerminal} open={false} />,
    );

    const button = screen.getByRole("button", { name: "Open terminal" });
    expect(button).toHaveTextContent("Terminal");
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button).toHaveAttribute("title", "Open terminal (Cmd/Ctrl+J)");

    await user.click(button);
    expect(onToggleTerminal).toHaveBeenCalledOnce();

    rerender(
      <ChatPanelTerminalButton onToggleTerminal={onToggleTerminal} open />,
    );
    expect(screen.getByRole("button", { name: "Close terminal" }))
      .toHaveAttribute("aria-pressed", "true");
  });
});
