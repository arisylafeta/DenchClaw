// @vitest-environment jsdom
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DocumentDirtyContext } from "./document-dirty-context";
import { MarkdownEditor } from "./markdown-editor";
import { RichDocumentEditor } from "./rich-document-editor";

const state = vi.hoisted(() => ({ html: "<p>original</p>", onUpdate: () => {}, editor: null as unknown }));
vi.mock("@tiptap/react", () => ({
  useEditor: (options: { onUpdate: () => void }) => { state.onUpdate = options.onUpdate; return state.editor; },
  EditorContent: () => null,
}));
vi.mock("@tiptap/react/menus", () => ({ BubbleMenu: () => null }));
vi.mock("html-to-docx", () => ({ default: async () => new Blob(["synthetic docx test bytes"]) }));

beforeEach(() => {
  state.html = "<p>original</p>";
  state.editor = {
    getHTML: () => state.html, getText: () => state.html, getMarkdown: () => state.html,
    view: { dom: document.createElement("div") }, storage: {},
    isActive: () => false, getAttributes: () => ({}), can: () => ({ undo: () => false, redo: () => false }),
    commands: { setContent: vi.fn() },
  };
});
afterEach(() => vi.unstubAllGlobals());

it.each(["markdown", "txt", "docx"])("reports actual dirty and saved clean state for %s", async mode => {
  const dirty = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 200 })));
  render(<DocumentDirtyContext.Provider value={dirty}>{mode === "markdown"
    ? <MarkdownEditor content="original" filePath="/synthetic/report.md" tree={[]} />
    : <RichDocumentEditor mode={mode as "txt" | "docx"} initialHtml="<p>original</p>" filePath={`/synthetic/report.${mode}`} />}</DocumentDirtyContext.Provider>);
  expect(dirty).toHaveBeenLastCalledWith(false);
  act(() => { state.html = "<p>edited</p>"; state.onUpdate(); });
  expect(dirty).toHaveBeenLastCalledWith(true);
  fireEvent.keyDown(document, { key: "s", ctrlKey: true });
  await waitFor(() => expect(dirty).toHaveBeenLastCalledWith(false));
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("does not report saved clean if the user edits while a save is in flight", async () => {
  const dirty = vi.fn();
  let finish!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
  render(<DocumentDirtyContext.Provider value={dirty}><RichDocumentEditor mode="txt" initialHtml="<p>original</p>" filePath="/synthetic/report.txt" /></DocumentDirtyContext.Provider>);
  act(() => { state.html = "<p>first edit</p>"; state.onUpdate(); });
  fireEvent.keyDown(document, { key: "s", ctrlKey: true });
  act(() => { state.html = "<p>second edit</p>"; state.onUpdate(); });
  await act(async () => finish(new Response("", { status: 200 })));
  expect(dirty).toHaveBeenLastCalledWith(true);
});
