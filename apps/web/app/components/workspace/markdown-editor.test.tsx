// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { MarkdownEditor } from "./markdown-editor";

type EditorOptions = {
  onCreate?: (props: { editor: unknown }) => void;
  onUpdate?: (props: { editor: unknown }) => void;
};

let lastEditorOptions: EditorOptions | null = null;
let currentEditor: {
  view: { dom: HTMLDivElement };
  commands: { setContent: ReturnType<typeof vi.fn> };
  isActive: ReturnType<typeof vi.fn>;
  getHTML: ReturnType<typeof vi.fn>;
  getMarkdown: ReturnType<typeof vi.fn>;
  chain: ReturnType<typeof vi.fn>;
};

function createMockChain() {
  const chain = {
    focus: vi.fn(() => chain),
    toggleBold: vi.fn(() => chain),
    toggleItalic: vi.fn(() => chain),
    toggleStrike: vi.fn(() => chain),
    toggleCode: vi.fn(() => chain),
    unsetLink: vi.fn(() => chain),
    setLink: vi.fn(() => chain),
    toggleHeading: vi.fn(() => chain),
    toggleBulletList: vi.fn(() => chain),
    toggleOrderedList: vi.fn(() => chain),
    toggleTaskList: vi.fn(() => chain),
    toggleBlockquote: vi.fn(() => chain),
    toggleCodeBlock: vi.fn(() => chain),
    setImage: vi.fn(() => chain),
    insertTable: vi.fn(() => chain),
    setHorizontalRule: vi.fn(() => chain),
    run: vi.fn(() => true),
  };
  return chain;
}

vi.mock("@tiptap/react", () => ({
  useEditor: (options: EditorOptions) => {
    lastEditorOptions = options;
    return currentEditor;
  },
  EditorContent: () => <div data-testid="editor-content" />,
}));

vi.mock("@tiptap/react/menus", () => ({
  BubbleMenu: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="bubble-menu">{children}</div>
  ),
}));

vi.mock("@tiptap/starter-kit", () => ({ default: { configure: () => ({}) } }));
vi.mock("@tiptap/markdown", () => ({ Markdown: { configure: () => ({}) } }));
vi.mock("@tiptap/extension-image", () => ({ default: { configure: () => ({}) } }));
vi.mock("@tiptap/extension-link", () => ({ default: { configure: () => ({}) } }));
vi.mock("@tiptap/extension-table", () => ({ Table: { configure: () => ({}) } }));
vi.mock("@tiptap/extension-table-row", () => ({ default: {} }));
vi.mock("@tiptap/extension-table-cell", () => ({ default: {} }));
vi.mock("@tiptap/extension-table-header", () => ({ default: {} }));
vi.mock("@tiptap/extension-task-list", () => ({ default: {} }));
vi.mock("@tiptap/extension-task-item", () => ({ default: { configure: () => ({}) } }));
vi.mock("@tiptap/extension-placeholder", () => ({ default: { configure: () => ({}) } }));

vi.mock("./report-block-node", () => ({
  ReportBlockNode: {},
  preprocessReportBlocks: (value: string) => value,
  postprocessReportBlocks: (value: string) => value,
}));

vi.mock("./slash-command", () => ({
  createSlashCommand: () => ({}),
  createWorkspaceMention: () => ({}),
  createFileMention: () => ({}),
}));

vi.mock("./editor-toolbar-primitives", () => ({
  ToolbarGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ToolbarDivider: () => <div data-testid="toolbar-divider" />,
  ToolbarButton: ({
    children,
    onClick,
    title,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    title?: string;
  }) => (
    <button type="button" onClick={onClick} title={title}>
      {children}
    </button>
  ),
  BubbleButton: ({
    children,
    onClick,
    title,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    title?: string;
  }) => (
    <button type="button" onClick={onClick} title={title}>
      {children}
    </button>
  ),
}));

vi.mock("@/lib/workspace-links", () => ({
  isWorkspaceLink: () => false,
}));

/** GET reads the file on disk (for the pre-save check); POST accepts the write. */
function diskFetch(onDisk: string) {
  return vi.fn((_url: string, init?: RequestInit) => Promise.resolve(new Response(
    JSON.stringify(init?.method === "POST" ? { ok: true } : { content: onDisk }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  )));
}

describe("MarkdownEditor", () => {
  beforeEach(() => {
    const chain = createMockChain();
    currentEditor = {
      view: { dom: document.createElement("div") },
      commands: { setContent: vi.fn() },
      isActive: vi.fn(() => false),
      getHTML: vi.fn(() => "<p>fallback</p>"),
      getMarkdown: vi.fn(() => "# updated markdown"),
      chain: vi.fn(() => chain),
    };
    lastEditorOptions = null;
  });

  function markDirty() {
    act(() => {
      lastEditorOptions?.onUpdate?.({ editor: currentEditor });
    });
  }

  it("saves home-relative markdown files through the real file API", async () => {
    const fetchMock = diskFetch("# initial");
    global.fetch = fetchMock as unknown as typeof fetch;
    const user = userEvent.setup();

    render(
      <MarkdownEditor
        content="# initial"
        filePath="~/notes/daily.md"
        tree={[]}
      />,
    );

    markDirty();
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(fetchMock).toHaveBeenCalledWith("/api/workspace/file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "~/notes/daily.md", content: "# updated markdown" }),
    });
  });

  it("keeps virtual markdown paths on the virtual-file API", async () => {
    const fetchMock = diskFetch("# initial");
    global.fetch = fetchMock as unknown as typeof fetch;
    const user = userEvent.setup();

    render(
      <MarkdownEditor
        content="# initial"
        filePath="~skills/demo/SKILL.md"
        tree={[]}
      />,
    );

    markDirty();
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(fetchMock).toHaveBeenCalledWith("/api/workspace/virtual-file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "~skills/demo/SKILL.md", content: "# updated markdown" }),
    });
  });

  it("does not overwrite a file that changed on disk since it was loaded", async () => {
    const fetchMock = diskFetch("# an agent wrote this");
    global.fetch = fetchMock as unknown as typeof fetch;
    const user = userEvent.setup();
    render(<MarkdownEditor content="# initial" filePath="cv/a.md" tree={[]} />);

    markDirty();
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    expect(await screen.findByRole("alert")).toHaveTextContent("changed on disk");
    await user.click(screen.getByRole("button", { name: "Overwrite with mine" }));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true);
  });

  it("shows a Done button that leaves edit mode", async () => {
    const onExit = vi.fn();
    const user = userEvent.setup();
    render(<MarkdownEditor content="# initial" filePath="cv/a.md" tree={[]} onExit={onExit} />);
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(onExit).toHaveBeenCalled();
  });
});
