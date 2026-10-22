// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
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
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
});
afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState({}, "", "/"); });

describe("workspace sidebar navigation", () => {
  it("uses the desktop panel-toggle idiom, not Back, for the mobile drawer", () => {
    const close = vi.fn();
    render(<WorkspaceSidebar mobile onClose={close} onToggleCompact={vi.fn()} />);
    const toggle = screen.getByRole("button", { name: "Close sidebar" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAttribute("aria-controls", "workspace-sidebar");
    expect(toggle.querySelector('path')).toHaveAttribute("d", "M9 3v18");
    expect(toggle.className).toContain("min-h-11");
    expect(toggle.className).toContain("min-w-11");
    expect(screen.queryByText("Back")).toBeNull();
    expect(screen.queryByRole("button", { name: "Collapse sidebar" })).toBeNull();
    fireEvent.click(toggle);
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("makes Chats the first and default sidebar view without navigating content", () => {
    const navigate = vi.fn();
    render(<WorkspaceSidebar chatsPanel={<p>Conversation fixture</p>} onNavigate={navigate} />);
    const tabs = within(screen.getByRole("group", { name: "Sidebar views" })).getAllByRole("button");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Chats", "Home"]);
    expect(tabs[0]).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Conversation fixture")).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });
  it("restores an intentional Home view and never resets it after file/deep-link navigation", () => {
    localStorage.setItem("dench-sidebar-view", "home");
    window.history.replaceState({}, "", "/workspace?path=fixture.md&chat=exact-profile-key");
    const navigate = vi.fn(); const select = vi.fn();
    const view = render(<WorkspaceSidebar activePath="fixture.md" chatsPanel={<p>Conversation fixture</p>} onNavigate={navigate} onSelect={select} />);
    expect(screen.getByRole("button", { name: "Home" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("Conversation fixture")).not.toBeInTheDocument();
    view.rerender(<WorkspaceSidebar activePath="other.md" activeCrmTarget="people" chatsPanel={<p>Refreshed chats</p>} onNavigate={navigate} onSelect={select} />);
    expect(screen.getByRole("button", { name: "Home" })).toHaveAttribute("aria-pressed", "true");
    expect(location.search).toBe("?path=fixture.md&chat=exact-profile-key");
    expect(navigate).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Chats" }));
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    expect(localStorage.getItem("dench-sidebar-view")).toBe("home");
    expect(screen.queryByText("Refreshed chats")).not.toBeInTheDocument();
  });
  it("opens the CRM Home page first in the CRM navigation and marks it active", () => {
    const onNavigate = vi.fn();
    render(<WorkspaceSidebar onNavigate={onNavigate} customCrmObjects={[]} activeCrmTarget="home" />);
    const home = screen.getByRole("button", { name: "CRM Home" });
    expect(home).toHaveTextContent("Home");
    expect(home).toHaveStyle({ background: "var(--color-surface-hover)" });
    fireEvent.click(home);
    expect(onNavigate).toHaveBeenCalledWith("crm-home");
  });

  it("opens People from the fixed CRM navigation even when hidden objects are absent", () => {
    const onNavigate = vi.fn();
    render(<WorkspaceSidebar onNavigate={onNavigate} customCrmObjects={[]} />);

    fireEvent.click(screen.getByRole("button", { name: "People" }));
    expect(onNavigate).toHaveBeenCalledWith("crm-people");

  });


  it("categorizes workspace objects without changing their order", () => {
    expect(categorizeSidebarObjects(objects)).toEqual({
      crm: [objects[3]],
      work: [objects[0]],
      automations: [objects[1], objects[2]],
    });
  });

	it("keeps secondary sections collapsed until they are needed", () => {
    render(
      <WorkspaceSidebar
        onNavigate={vi.fn()}
        onNavigateToCrmObject={vi.fn()}
        customCrmObjects={objects}
      />,
    );

    expect(screen.getByRole("button", { name: "CRM" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Admin" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Workspace" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Accounts" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Work Tasks" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Admin" }));
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    expect(screen.getByRole("group", { name: "Workspace" })).toContainElement(screen.getByRole("button", { name: "Work Tasks" }));
    expect(screen.queryByText("work")).toBeNull();
    expect(screen.queryByText("automations")).toBeNull();
    expect(screen.queryByText("Cloud")).toBeNull();
    expect(screen.queryByText("Integrations")).toBeNull();
    expect(screen.queryByText("Skills")).toBeNull();
    expect(screen.queryByText(/dench\.com/)).toBeNull();
    expect(screen.queryByTitle(/dotfiles/)).toBeNull();
    expect(screen.getByRole("button", { name: "Open user menu" })).toBeInTheDocument();

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
    expect(screen.getByRole("button", { name: "Listings" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "People" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "CRM" }));
    expect(screen.queryByRole("button", { name: "People" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Work Tasks" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
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
    expect(crmGroup).toContainElement(screen.getByRole("button", { name: "People" }));
    expect(adminGroup).toContainElement(screen.getByRole("button", { name: "Listings" }));
    expect(workspaceGroup).toContainElement(screen.getByRole("button", { name: "Work Tasks" }));
    expect(workspaceGroup).toContainElement(screen.getByRole("button", { name: "Automation Loops" }));
    expect(workspaceGroup).toContainElement(screen.getByRole("button", { name: "Automation Loop Runs" }));
    expect(screen.queryByRole("button", { name: "Cron" })).toBeNull();
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

    expect(screen.queryByRole("button", { name: "Accounts" })).toBeNull();
    expect(screen.getByRole("button", { name: "People" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    expect(screen.getByRole("button", { name: "Work Tasks" })).toBeTruthy();
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
