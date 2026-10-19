// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useWorkspaceWatcher } from "./use-workspace-watcher";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, (event: MessageEvent) => void>();
  closed = false;
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  addEventListener(type: string, listener: (event: MessageEvent) => void) { this.listeners.set(type, listener); }
  close() { this.closed = true; }
  emit(type: string, data: unknown) { this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(data) })); }
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); FakeEventSource.instances = []; });

it("does not re-enter loading on SSE browse refresh and retains the listing on HTTP failure", async () => {
  vi.stubGlobal("EventSource", FakeEventSource);
  const entries = [{ name: "report.md", path: "reports/report.md", type: "document" }];
  let resolveRefresh!: (response: Response) => void;
  let browseRequests = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/browse")) {
      if (++browseRequests > 1) return new Promise<Response>(resolve => { resolveRefresh = resolve; });
      return Response.json({ entries, parentDir: "/synthetic" });
    }
    return Response.json({ tree: [], exists: true, workspaceRoot: "/synthetic" });
  }));
  const { result, unmount } = renderHook(() => useWorkspaceWatcher());
  await waitFor(() => expect(result.current.loading).toBe(false));
  act(() => result.current.setBrowseDir("/synthetic/reports"));
  expect(result.current.loading).toBe(true);
  await waitFor(() => expect(result.current.tree).toEqual(entries));
  vi.useFakeTimers();
  act(() => FakeEventSource.instances.at(-1)!.emit("change", { type: "change", path: "reports/report.md", root: "/synthetic" }));
  await act(async () => { vi.advanceTimersByTime(300); });
  expect(browseRequests).toBe(2);
  expect(result.current.loading).toBe(false);
  expect(result.current.tree).toEqual(entries);
  await act(async () => { resolveRefresh(Response.json({ error: "Temporarily unavailable" }, { status: 503 })); });
  expect(result.current.tree).toEqual(entries);
  unmount();
});

it("forwards every exact path/root event and keeps workspace updates alive in browse mode", async () => {
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ tree: [], exists: true, workspaceRoot: "/synthetic/workspace", entries: [] })));
  const { result, unmount } = renderHook(() => useWorkspaceWatcher());
  await waitFor(() => expect(result.current.workspaceRoot).toBe("/synthetic/workspace"));
  const listener = vi.fn();
  const unsubscribe = result.current.subscribeChanges(listener);
  const event = { type: "change", path: "reports/a.md", root: "/synthetic/workspace" };
  act(() => {
    FakeEventSource.instances.at(-1)!.emit("change", event);
    FakeEventSource.instances.at(-1)!.emit("change", { ...event, path: "reports/b.md" });
  });
  expect(listener.mock.calls.map(call => call[0].path)).toEqual(["reports/a.md", "reports/b.md"]);
  act(() => result.current.setBrowseDir("/synthetic/other"));
  await waitFor(() => expect(result.current.browseDir).toBe("/synthetic/other"));
  expect(FakeEventSource.instances.at(-1)!.closed).toBe(false);
  act(() => FakeEventSource.instances.at(-1)!.emit("change", event));
  expect(listener).toHaveBeenLastCalledWith(event);
  unsubscribe();
  unmount();
  expect(FakeEventSource.instances.every(source => source.closed)).toBe(true);
});
