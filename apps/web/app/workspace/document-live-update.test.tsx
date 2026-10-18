// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTabContent } from "./use-tab-content";
import type { ContentTab } from "@/lib/workspace-tabs";

const root = "/synthetic/workspace";
const tab = (path: string): ContentTab => ({ id: path, path, title: path.split("/").pop()!, kind: path.endsWith(".md") ? "document" : "file", preview: false, pinned: false });
const a = tab("reports/a.md"), b = tab("reports/b.md");
const response = (content: string) => Response.json({ content, type: "markdown" });
const deps = { tree: [], cronJobs: [], tabs: [a, b], workspaceRoot: root };
const change = (path = a.path) => ({ path, root });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => response("old"))));
afterEach(() => vi.unstubAllGlobals());

describe("document cache external updates", () => {
  it("normalizes an absolute lexical alias for live updates", async () => {
    const active = tab(`${root}/reports/../report.csv`);
    const { result } = renderHook(() => useTabContent(active, { ...deps, tabs: [active] }));
    await waitFor(() => expect(result.current.content.kind).toBe("spreadsheet"));
    act(() => result.current.invalidateFile(change("report.csv")));
    await waitFor(() => expect(result.current.externalVersion).toBe(1));
  });
  it("reloads a matching clean active document only, preserving unrelated state", async () => {
    const { result } = renderHook(() => useTabContent(a, deps));
    await waitFor(() => expect(result.current.content.kind).toBe("document"));
    const previous = result.current.content;
    act(() => result.current.invalidateFile(change("elsewhere/a.md")));
    act(() => result.current.invalidateFile({ root: "/different/workspace", path: a.path }));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.current.content).toBe(previous);
    vi.mocked(fetch).mockResolvedValueOnce(response("new"));
    act(() => result.current.invalidateFile(change()));
    await waitFor(() => expect(result.current.externalVersion).toBe(1));
    expect(result.current.content).toMatchObject({ data: { content: "new" } });
  });

  it("does not keep a phantom dirty cache after the existing editor unmounts on navigation", async () => {
    const { result, rerender } = renderHook(({ active }) => useTabContent(active, deps), { initialProps: { active: a } });
    await waitFor(() => expect(result.current.content.kind).toBe("document"));
    act(() => result.current.setDirty(a.id, true));
    act(() => result.current.invalidateFile(change()));
    rerender({ active: b });
    await waitFor(() => expect(result.current.content.kind).toBe("document"));
    vi.mocked(fetch).mockResolvedValueOnce(response("disk after navigation"));
    rerender({ active: a });
    await waitFor(() => expect(result.current.content).toMatchObject({ data: { content: "disk after navigation" } }));
    expect(result.current.pendingExternalUpdate).toBe(false);
  });

  it("invalidates an inactive tab so reopening reads fresh bytes", async () => {
    const { result, rerender } = renderHook(({ active }) => useTabContent(active, deps), { initialProps: { active: a } });
    await waitFor(() => expect(result.current.content.kind).toBe("document"));
    rerender({ active: b });
    await waitFor(() => expect(result.current.content.kind).toBe("document"));
    act(() => result.current.invalidateFile(change()));
    vi.mocked(fetch).mockResolvedValueOnce(response("fresh reopen"));
    rerender({ active: a });
    await waitFor(() => expect(result.current.content).toMatchObject({ data: { content: "fresh reopen" } }));
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([a, tab(`${root}/reports/a.md`), tab("~workspace/reports/a.md")])("preserves dirty editors and clears pending after saved clean state: $path", async active => {
    const { result } = renderHook(() => useTabContent(active, { ...deps, tabs: [active] }));
    await waitFor(() => expect(result.current.content.kind).toBe("document"));
    const previous = result.current.content;
    act(() => result.current.setDirty(active.id, true));
    act(() => result.current.invalidateFile(change()));
    expect(result.current.pendingExternalUpdate).toBe(true);
    expect(result.current.externalVersion).toBe(0);
    expect(result.current.content).toBe(previous);
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.mocked(fetch).mockResolvedValueOnce(response("saved"));
    act(() => result.current.setDirty(active.id, false));
    await waitFor(() => expect(result.current.content).toMatchObject({ data: { content: "saved" } }));
    expect(result.current.pendingExternalUpdate).toBe(false);
  });

  it("does not replace edits started during an external read", async () => {
    const { result } = renderHook(() => useTabContent(a, deps));
    await waitFor(() => expect(result.current.content.kind).toBe("document"));
    const previous = result.current.content;
    const pending = deferred<Response>();
    vi.mocked(fetch).mockReturnValueOnce(pending.promise);
    act(() => result.current.invalidateFile(change()));
    act(() => result.current.setDirty(a.id, true));
    await act(async () => pending.resolve(response("external")));
    expect(result.current.content).toBe(previous);
    expect(result.current.externalVersion).toBe(0);
    expect(result.current.pendingExternalUpdate).toBe(true);
  });

  it.each(["drop", "clear"])("prevents a late refresh from repopulating invalidated cache: %s", async mode => {
    const { result, rerender } = renderHook(({ active }) => useTabContent(active, deps), { initialProps: { active: a } });
    await waitFor(() => expect(result.current.content.kind).toBe("document"));
    const pending = deferred<Response>();
    vi.mocked(fetch).mockReturnValueOnce(pending.promise);
    act(() => result.current.refreshActive());
    act(() => mode === "drop" ? result.current.dropFromCache(a.id) : result.current.clearCache());
    await act(async () => pending.resolve(response("stale late")));
    rerender({ active: b });
    await waitFor(() => expect(result.current.content.kind).toBe("document"));
    vi.mocked(fetch).mockResolvedValueOnce(response("new after invalidation"));
    rerender({ active: a });
    await waitFor(() => expect(result.current.content).toMatchObject({ data: { content: "new after invalidation" } }));
  });

  it("refreshes spreadsheet identity with an external version for binary editor reload", async () => {
    const active = tab(`${root}/report.xlsx`);
    const { result } = renderHook(() => useTabContent(active, { ...deps, tabs: [active] }));
    await waitFor(() => expect(result.current.content.kind).toBe("spreadsheet"));
    act(() => result.current.invalidateFile(change("report.xlsx")));
    await waitFor(() => expect(result.current.externalVersion).toBe(1));
    expect(result.current.content).toMatchObject({ kind: "spreadsheet", filePath: active.path });
  });
});
