// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { notifyWorkspaceObjectsChanged, useCrmNavigationTree } from "./use-crm-navigation-tree";

const objects = [
  { name: "bulk_trades", path: "bulk_trades", type: "object", icon: "truck", defaultView: "kanban" },
  { name: "supplier", path: "supplier", type: "object", icon: "building" },
];
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

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

it("refreshes only for explicit object metadata mutations, not rerenders or file/chat events", async () => {
  const updated = [...objects, { name: "custom_pipeline", path: "custom_pipeline", type: "object" }];
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ tree: objects }))
    .mockResolvedValueOnce(Response.json({ tree: updated }));
  vi.stubGlobal("fetch", fetcher);
  const { result, rerender, unmount } = renderHook(() => useCrmNavigationTree());
  await waitFor(() => expect(result.current.tree).toEqual(objects));
  act(() => {
    window.dispatchEvent(new Event("change"));
    window.dispatchEvent(new Event("chat-sessions-updated"));
  });
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
