// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { WorkspaceSidebar } from "./workspace-sidebar";

vi.mock("./profile-switcher", () => ({
  ProfileSwitcher: ({ trigger }: { trigger: (props: { onClick: () => void; activeWorkspace: string; switching: boolean }) => React.ReactNode }) =>
    trigger({ onClick: () => {}, activeWorkspace: "investigator", switching: false }),
}));
vi.mock("./create-workspace-dialog", () => ({ CreateWorkspaceDialog: () => null }));
vi.mock("./nav-user", () => ({ NavUser: () => null }));

describe("profile avatars in sidebar triggers", () => {
  it.each([false, true])("uses the selected profile image in compact=%s", (compact) => {
    const { container } = render(<WorkspaceSidebar compact={compact} orgName="ReBattery" />);
    expect(container.querySelector('img[src="/api/workspace/avatar?name=investigator"]')).toBeTruthy();
    if (!compact) {
      expect(screen.getByTitle("Switch workspace")).toHaveTextContent("investigator");
      expect(screen.getByTitle("Switch workspace")).not.toHaveTextContent("ReBattery");
    }
  });
});
