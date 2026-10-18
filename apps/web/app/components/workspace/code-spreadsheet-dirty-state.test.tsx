// @vitest-environment jsdom
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DocumentDirtyContext } from "./document-dirty-context";
import { MonacoCodeEditor } from "./code-editor";
import { SpreadsheetEditor } from "./spreadsheet-editor";

const seam = vi.hoisted(() => ({ mount: null as unknown, change: null as unknown }));
vi.mock("@monaco-editor/react", () => ({ default: (props: { onMount: unknown }) => { seam.mount = props.onMount; return null; } }));
vi.mock("react-spreadsheet", async importOriginal => ({
  ...await importOriginal<typeof import("react-spreadsheet")>(),
  default: (props: { onChange: unknown }) => { seam.change = props.onChange; return null; },
}));
afterEach(() => vi.unstubAllGlobals());

it("Monaco reports dirty, remains dirty through in-flight edits, and clears only after the latest content is saved", async () => {
  const dirty = vi.fn();
  let finish!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
  render(<DocumentDirtyContext.Provider value={dirty}><MonacoCodeEditor content="original" filename="report.json" filePath="/synthetic/report.json" /></DocumentDirtyContext.Provider>);
  let value = "original", changed = () => {}, save = () => {};
  act(() => (seam.mount as Function)({
    getValue: () => value, onDidChangeCursorPosition: vi.fn(), focus: vi.fn(),
    onDidChangeModelContent: (callback: () => void) => { changed = callback; },
    addCommand: (_key: number, callback: () => void) => { save = callback; },
  }, { editor: { defineTheme: vi.fn(), setTheme: vi.fn() }, KeyMod: { CtrlCmd: 1 }, KeyCode: { KeyS: 2 } }));
  act(() => { value = "edited"; changed(); });
  expect(dirty).toHaveBeenLastCalledWith(true);
  act(() => save());
  act(() => { value = "edited during save"; changed(); });
  await act(async () => finish(new Response("", { status: 200 })));
  expect(dirty).toHaveBeenLastCalledWith(true);
  act(() => save());
  await act(async () => finish(new Response("", { status: 200 })));
  expect(dirty).toHaveBeenLastCalledWith(false);
});

it("spreadsheet loads without HTTP cache, reports edits, clears after save and becomes dirty again on undo", async () => {
  const dirty = vi.fn();
  seam.change = null;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST" ? new Response("", { status: 200 }) : new Response("Name,Value\nSynthetic,1\n")));
  render(<DocumentDirtyContext.Provider value={dirty}><SpreadsheetEditor url="/synthetic/report.csv" filename="report.csv" filePath="/synthetic/report.csv" /></DocumentDirtyContext.Provider>);
  await waitFor(() => expect(seam.change).toBeTypeOf("function"));
  expect(fetch).toHaveBeenCalledWith("/synthetic/report.csv", { cache: "no-store" });
  act(() => (seam.change as Function)([[{ value: "edited" }]]));
  expect(dirty).toHaveBeenLastCalledWith(true);
  fireEvent.keyDown(document, { key: "s", ctrlKey: true });
  await waitFor(() => expect(dirty).toHaveBeenLastCalledWith(false));
  fireEvent.keyDown(document, { key: "z", ctrlKey: true });
  expect(dirty).toHaveBeenLastCalledWith(true);
});
