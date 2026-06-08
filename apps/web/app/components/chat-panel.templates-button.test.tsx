// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatPanelTemplatesButton } from "./chat-panel";

describe("ChatPanelTemplatesButton", () => {
  it("renders the dashboard templates action and calls the launcher", async () => {
    const user = userEvent.setup();
    const onOpenTemplates = vi.fn();

    render(<ChatPanelTemplatesButton onOpenTemplates={onOpenTemplates} />);

    await user.click(screen.getByRole("button", { name: "Templates" }));

    expect(onOpenTemplates).toHaveBeenCalledOnce();
  });
});
