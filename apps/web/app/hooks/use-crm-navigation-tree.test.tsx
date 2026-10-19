// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useWorkspaceWatcher } from "./use-workspace-watcher";
import { notifyWorkspaceObjectsChanged, useCrmNavigationTree } from "./use-crm-navigation-tree";

const objects = [
  { name: "bulk_trades", path: "bulk_trades", type: "object", icon: "truck", defaultView: "kanban" },
  { name: "supplier", path: "supplier", type: "object", icon: "building" },
];
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("retains names, icons and views during explicit refreshes and HTTP, network or malformed response failures", async () => {
  let resolveRefresh!: (response: Response) => void;
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ tree: objects }))
    .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveRefresh = resolve; }))
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(Response.json({ error: "not a tree" }))
    .mockResolvedValueOnce(Response.json({ tree: [] }));
  vi.stubGlobal("fetch", fetcher);
  const { result } = renderHook(() => useCrmNavigationTree());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.tree).toEqual(objects);
  const lastGoodTree = result.current.tree;
  let pending!: Promise<void>;
  act(() => { pending = result.current.refresh(); });
  expect(result.current.loading).toBe(false);
  expect(result.current.tree).toBe(lastGoodTree);
  await act(async () => { resolveRefresh(Response.json({ tree: [] }, { status: 503 })); await pending; });
  expect(result.current.tree).toBe(lastGoodTree);
  await act(async () => { await result.current.refresh(); });
  expect(result.current.tree).toBe(lastGoodTree);
  await act(async () => { await result.current.refresh(); });
  expect(result.current.tree).toBe(lastGoodTree);
  await act(async () => { await result.current.refresh(); });
  expect(result.current.tree).toEqual([]); // A successful deletion is not cached forever.
});

it("refreshes for explicit object metadata mutations but not rerenders", async () => {
  const updated = [...objects, { name: "custom_pipeline", path: "custom_pipeline", type: "object" }];
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ tree: objects }))
    .mockResolvedValueOnce(Response.json({ tree: updated }));
  vi.stubGlobal("fetch", fetcher);
  const { result, rerender, unmount } = renderHook(() => useCrmNavigationTree());
  await waitFor(() => expect(result.current.tree).toEqual(objects));
  rerender();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledWith("/api/workspace/tree");
  act(() => notifyWorkspaceObjectsChanged());
  await waitFor(() => expect(result.current.tree).toEqual(updated));
  expect(fetcher).toHaveBeenCalledTimes(2);
  unmount();
  notifyWorkspaceObjectsChanged();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

class FakeEventSource {
  static latest: FakeEventSource;
  listeners = new Map<string, (event: MessageEvent) => void>();
  constructor() { FakeEventSource.latest = this; }
  addEventListener(type: string, listener: (event: MessageEvent) => void) { this.listeners.set(type, listener); }
  close() {}
  emit(path: string, type = "change") {
    this.listeners.get("change")?.(new MessageEvent("change", { data: JSON.stringify({ path, type, root: "/synthetic" }) }));
  }
}

it("ignores ordinary SSE file writes but updates object creation, deletion and metadata in browse mode", async () => {
  vi.stubGlobal("EventSource", FakeEventSource);
  let currentObjects = objects;
  let rootRequests = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/browse")) return Response.json({ entries: [], parentDir: "/synthetic" });
    ++rootRequests;
    return Response.json({ tree: currentObjects, workspaceRoot: "/synthetic", exists: true });
  }));
  const { result } = renderHook(() => {
    const watcher = useWorkspaceWatcher();
    const nav = useCrmNavigationTree("one", watcher.subscribeChanges);
    return { watcher, nav };
  });
  await waitFor(() => expect(result.current.nav.tree).toEqual(objects));
  act(() => result.current.watcher.setBrowseDir("/synthetic/reports"));
  await waitFor(() => expect(result.current.watcher.loading).toBe(false));
  const initialRequests = rootRequests;
  const initialTree = result.current.nav.tree;
  vi.useFakeTimers();
  act(() => FakeEventSource.latest.emit("reports/result.md"));
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(rootRequests).toBe(initialRequests);
  expect(result.current.nav.tree).toBe(initialTree);
  currentObjects = [...objects, { name: "new_object", path: "new_object", type: "object", icon: "table" }];
  act(() => FakeEventSource.latest.emit("new_object/.object.yaml", "add"));
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(result.current.nav.tree).toEqual(currentObjects);
  expect(rootRequests).toBe(initialRequests + 1);
  currentObjects = [];
  act(() => FakeEventSource.latest.emit("new_object", "unlinkDir"));
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(result.current.nav.tree).toEqual([]);
  expect(rootRequests).toBe(initialRequests + 2);
});

it("does not retain another workspace's objects after a failed workspace switch", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ tree: objects }))
    .mockResolvedValue(Response.json({ error: "offline" }, { status: 503 })));
  const { result, rerender } = renderHook(({ workspace }) => useCrmNavigationTree(workspace), { initialProps: { workspace: "one" } });
  await waitFor(() => expect(result.current.tree).toEqual(objects));
  rerender({ workspace: "two" });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.tree).toEqual([]);
});

it("recovers an initial fetch failure when the network reconnects", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(Response.json({ tree: objects })));
  const { result } = renderHook(() => useCrmNavigationTree("one"));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.tree).toEqual([]);
  act(() => window.dispatchEvent(new Event("online")));
  await waitFor(() => expect(result.current.tree).toEqual(objects));
});

it("ignores an older metadata response that races a newer mutation refresh", async () => {
  let resolveOld!: (response: Response) => void;
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { resolveOld = resolve; }))
    .mockResolvedValueOnce(Response.json({ tree: objects }));
  vi.stubGlobal("fetch", fetcher);
  const { result } = renderHook(() => useCrmNavigationTree());
  await act(async () => { await result.current.refresh(); });
  await act(async () => { resolveOld(Response.json({ tree: [] })); });
  expect(result.current.tree).toEqual(objects);
  expect(result.current.loading).toBe(false);
});
