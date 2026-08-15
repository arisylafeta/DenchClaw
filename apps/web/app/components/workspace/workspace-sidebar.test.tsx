// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { categorizeSidebarObjects, WorkspaceSidebar } from "./workspace-sidebar";

vi.mock("./profile-switcher", () => ({
  ProfileSwitcher: ({ trigger }: { trigger: (props: { onClick: () => void; activeWorkspace: string; switching: boolean }) => React.ReactNode }) =>
    trigger({ onClick: () => {}, activeWorkspace: "default", switching: false }),
}));
vi.mock("./create-workspace-dialog", () => ({ CreateWorkspaceDialog: () => null }));
vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "light", setTheme: vi.fn() }) }));

const objects = [
  { name: "work_task", icon: "list-checks" },
  { name: "automation_loop", icon: "refresh-cw" },
  { name: "automation_loop_run", icon: "history" },
  { name: "campaign", icon: "megaphone" },
];

describe("workspace sidebar navigation", () => {
  it("categorizes workspace objects without changing their order", () => {
    expect(categorizeSidebarObjects(objects)).toEqual({
      crm: [objects[3]],
      work: [objects[0]],
      automations: [objects[1], objects[2]],
    });
  });

  it("renders categorized links with loop monitoring beside Cron", () => {
    render(
      <WorkspaceSidebar
        onNavigate={vi.fn()}
        onNavigateToCrmObject={vi.fn()}
        customCrmObjects={objects}
      />,
    );

    expect(screen.getByRole("button", { name: "CRM" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Admin" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Workspace" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("group", { name: "Workspace" })).toContainElement(screen.getByRole("button", { name: "Work Tasks" }));
    expect(screen.queryByText("work")).toBeNull();
    expect(screen.queryByText("automations")).toBeNull();
    expect(screen.queryByText("Cloud")).toBeNull();
    expect(screen.queryByText("Integrations")).toBeNull();
    expect(screen.queryByText("Skills")).toBeNull();
    expect(screen.queryByText(/dench\.com/)).toBeNull();
    expect(screen.queryByTitle(/dotfiles/)).toBeNull();
    expect(screen.getByRole("button", { name: "Open user menu" })).toBeInTheDocument();

    const navigationLabels = screen.getAllByRole("button").map((button) => button.textContent?.trim()).filter(Boolean);
    expect(navigationLabels).toEqual(expect.arrayContaining([
      "People", "Companies", "Inbox", "Calendar", "Recycler selection", "Accounts", "Battery review", "Payout reviews", "Campaigns", "Work Tasks", "Loops", "Loop Runs", "Cron",
    ]));
    expect(navigationLabels.indexOf("Loops")).toBeLessThan(navigationLabels.indexOf("Loop Runs"));
    expect(navigationLabels.indexOf("Loop Runs")).toBeLessThan(navigationLabels.indexOf("Cron"));
  });

  it("collapses CRM, Admin, and Workspace as independent trees", () => {
    render(
      <WorkspaceSidebar
        onNavigate={vi.fn()}
        onNavigateToCrmObject={vi.fn()}
        customCrmObjects={objects}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Admin" }));
    expect(screen.queryByRole("button", { name: "Accounts" })).toBeNull();
    expect(screen.getByRole("button", { name: "People" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "CRM" }));
    expect(screen.queryByRole("button", { name: "People" })).toBeNull();
    expect(screen.getByRole("button", { name: "Work Tasks" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    expect(screen.queryByRole("button", { name: "Work Tasks" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Loops" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cron" })).toBeNull();
  });

  it("keeps compact CRM, Admin, and Workspace links in separate ordered groups", () => {
    render(
      <WorkspaceSidebar
        compact
        onNavigate={vi.fn()}
        onNavigateToCrmObject={vi.fn()}
        customCrmObjects={objects}
      />,
    );

    const crmGroup = screen.getByRole("group", { name: "CRM" });
    const adminGroup = screen.getByRole("group", { name: "Admin" });
    const workspaceGroup = screen.getByRole("group", { name: "Workspace" });
    expect(crmGroup).toContainElement(screen.getByRole("button", { name: "Campaigns" }));
    expect(adminGroup).toContainElement(screen.getByRole("button", { name: "Accounts" }));
    expect(workspaceGroup).toContainElement(screen.getByRole("button", { name: "Work Tasks" }));
    expect(workspaceGroup).toContainElement(screen.getByRole("button", { name: "Loops" }));
    expect(workspaceGroup).toContainElement(screen.getByRole("button", { name: "Cron" }));
    expect(crmGroup.compareDocumentPosition(adminGroup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(adminGroup.compareDocumentPosition(workspaceGroup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("uses the same collapsible trees in the mobile drawer", () => {
    render(
      <WorkspaceSidebar
        mobile
        onNavigate={vi.fn()}
        onNavigateToCrmObject={vi.fn()}
        customCrmObjects={objects}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Admin" }));
    expect(screen.queryByRole("button", { name: "Accounts" })).toBeNull();
    expect(screen.getByRole("button", { name: "People" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    expect(screen.queryByRole("button", { name: "Work Tasks" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cron" })).toBeNull();
  });

  it("does not flash the fixed CRM links before dynamic objects load", () => {
    render(
      <WorkspaceSidebar
        loading
        onNavigate={vi.fn()}
        onNavigateToCrmObject={vi.fn()}
        customCrmObjects={[]}
      />,
    );

    expect(screen.getByLabelText("Loading navigation")).toBeTruthy();
    expect(screen.queryByText("People")).toBeNull();
    expect(screen.queryByText("Calendar")).toBeNull();
  });
});
