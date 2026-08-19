// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NavUser } from "./nav-user";

const theme = vi.hoisted(() => ({
  resolvedTheme: "light",
  setTheme: vi.fn(),
}));

vi.mock("next-themes", () => ({
  useTheme: () => theme,
}));

describe("NavUser", () => {
  beforeEach(() => {
    theme.resolvedTheme = "light";
    theme.setTheme.mockReset();
  });

  it("puts theme and sign out actions in the three-dot menu", async () => {
    const user = userEvent.setup();
    const onSignOut = vi.fn();

    render(
      <NavUser
        user={{ displayName: "Ari", email: "ari@example.com" }}
        onSignOut={onSignOut}
      />,
    );

    expect(screen.getByText("Ari")).toBeInTheDocument();
    expect(screen.getByText("ari@example.com")).toBeInTheDocument();

    const trigger = screen.getByRole("button", { name: "Open user menu" });
    trigger.focus();
    await user.keyboard("{Enter}");
    await user.click(screen.getByText("Dark mode"));
    expect(theme.setTheme).toHaveBeenCalledWith("dark");

    trigger.focus();
    await user.keyboard("{Enter}");
    await user.click(screen.getByText("Sign out"));
    expect(onSignOut).toHaveBeenCalledOnce();
  });
});
