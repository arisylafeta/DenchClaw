// @vitest-environment jsdom
import { useReducer } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFileLink, interceptWorkspaceLinkClick, parseWorkspaceLink } from "./workspace-links";
import { resolveWorkspaceFileReference } from "./workspace-file-reference";
import { workspaceTabsReducer, type WorkspaceTabsState } from "./workspace-tabs";

const initial: WorkspaceTabsState = { contentTabs: [], chatTabs: [], activeContentId: null, activeChatId: null };
afterEach(() => vi.unstubAllGlobals());

function FileLinkHarness({ href }: { href: string }) {
  const [state, dispatch] = useReducer(workspaceTabsReducer, initial);
  const navigate = async (link: string) => {
    const parsed = parseWorkspaceLink(link);
    if (parsed?.kind !== "file") return;
    const node = await resolveWorkspaceFileReference(parsed.path, [], "/synthetic/workspace");
    if (!node) return;
    dispatch({ type: "openContent", tab: { kind: node.type === "document" ? "document" : "file", path: node.path, title: node.name } });
  };
  return <div onClick={event => interceptWorkspaceLinkClick(event, href => { void navigate(href); })}>
    <a href={href}>Open generated</a>
    <output>{state.contentTabs.find(tab => tab.id === state.activeContentId)?.path}</output>
  </div>;
}

describe("generated document chat link seam", () => {
  it.each([false, true])("opens a new exact file via state before the tree exists (full URL=%s)", async full => {
    const path = "/synthetic/workspace/generated/new report.md";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ path, name: "new report.md", type: "file" })));
    const href = full ? new URL(buildFileLink(path), window.location.origin).href : buildFileLink(path);
    const previousLocation = window.location.href;
    render(<FileLinkHarness href={href} />);
    expect(fireEvent.click(screen.getByRole("link", { name: "Open generated" }))).toBe(false);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("generated/new report.md"));
    expect(fetch).toHaveBeenCalledWith(`/api/workspace/path-info?path=${encodeURIComponent(path)}`);
    expect(window.location.href).toBe(previousLocation);
  });

  it("never substitutes a same-basename or knowledge-prefixed node", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ path: "/synthetic/workspace/reports/new.md", name: "new.md", type: "file" })));
    const node = await resolveWorkspaceFileReference("reports/new.md", [
      { path: "knowledge/reports/new.md", name: "new.md", type: "document" },
      { path: "different/new.md", name: "new.md", type: "document" },
    ], "/synthetic/workspace");
    expect(node?.path).toBe("reports/new.md");
    expect(fetch).toHaveBeenCalledWith(`/api/workspace/path-info?path=${encodeURIComponent("/synthetic/workspace/reports/new.md")}`);
  });

  it("leaves foreign-origin links alone", () => {
    const link = document.createElement("a");
    link.href = "https://foreign.test/?path=reports/new.md";
    const event = { target: link, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    const navigate = vi.fn();
    expect(interceptWorkspaceLinkClick(event, navigate)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("uses an existing exact canonical file without a second lookup", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const expected = { path: "reports/existing.md", name: "existing.md", type: "document" as const };
    expect(await resolveWorkspaceFileReference(expected.path, [expected], "/synthetic/workspace")).toBe(expected);
    expect(fetch).not.toHaveBeenCalled();
  });
});
