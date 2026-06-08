// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTabContent, type UseTabContentDeps } from "./use-tab-content";
import type { ContentTab } from "@/lib/workspace-tabs";
import type { ObjectData } from "./content-state";
import type { TreeNode } from "../components/workspace/file-manager-tree";

/**
 * Stale-while-revalidate contract for `useTabContent`.
 *
 * Why this matters: the workspace tree watcher fires on every SSE tick
 * (file edits, log writes, db file touches). When the active tab is an
 * object, `workspace-content.tsx` calls `refreshActive` to re-fetch the
 * payload so the right panel stays in sync. Before this contract was
 * locked in, a refresh would wipe the cached content to `undefined`,
 * which made the hook return `{kind:"loading"}` for ~100-500ms while
 * the network round-trip resolved. Visible result: the active right
 * panel flicked to a centered spinner / empty table on every tick,
 * destroying scroll/selection/edit state and rendering "No results
 * found" when the in-flight fetch happened to interleave with an empty
 * intermediate response.
 *
 * The contract: once a tab has cached content, refreshes keep that
 * content visible until the new payload lands. Initial loads still
 * surface `{kind:"loading"}` because there is nothing to keep.
 */

type FetchHandler = (
  url: string,
  init: RequestInit | undefined,
) => Promise<Response>;

let fetchHandler: FetchHandler;

beforeEach(() => {
  fetchHandler = async () => new Response("not-mocked", { status: 500 });
  global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    return fetchHandler(url, init);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeObjectTab(name: string): ContentTab {
  return {
    id: `object:${name}`,
    kind: "object",
    path: name,
    title: name,
    preview: false,
    pinned: false,
  };
}

function makeObjectData(overrides?: Partial<ObjectData>): ObjectData {
  return {
    object: { id: "obj1", name: "people" },
    fields: [{ id: "f1", name: "Name", type: "text" }],
    statuses: [],
    entries: [{ entry_id: "p1", Name: "Ada" }],
    ...overrides,
  };
}

function makeDeps(overrides?: Partial<UseTabContentDeps>): UseTabContentDeps {
  return {
    tree: [] as TreeNode[],
    cronJobs: [],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("useTabContent stale-while-revalidate", () => {
  it("includes URL object-view params when initially fetching an object tab", async () => {
    window.history.replaceState(
      null,
      "",
      "/?path=people&view=All+CRM+Contacts&search=ari.sylafeta&cols=Full+Name%2CNotes&terminal=1",
    );
    const urls: string[] = [];
    fetchHandler = async (url) => {
      urls.push(url);
      return new Response(JSON.stringify(makeObjectData()), { status: 200 });
    };

    renderHook(() => useTabContent(makeObjectTab("people"), makeDeps()));

    await waitFor(() => {
      expect(urls.length).toBeGreaterThan(0);
    });
    expect(urls[0]).toBe(
      "/api/workspace/objects/people?view=All+CRM+Contacts&search=ari.sylafeta&cols=Full+Name%2CNotes",
    );
  });

  it("emits loading on initial load, then resolves to fetched object content", async () => {
    fetchHandler = async () =>
      new Response(JSON.stringify(makeObjectData()), { status: 200 });

    const tab = makeObjectTab("people");
    const deps = makeDeps();
    const { result } = renderHook(() => useTabContent(tab, deps));

    expect(result.current.content).toEqual({ kind: "loading" });

    await waitFor(() => {
      expect(result.current.content.kind).toBe("object");
    });
    expect(
      result.current.content.kind === "object"
        ? result.current.content.data.entries
        : null,
    ).toEqual([{ entry_id: "p1", Name: "Ada" }]);
  });

  it("keeps existing object content visible while refreshActive() is in flight (no spurious loading flicker)", async () => {
    // Initial fetch resolves immediately with one row.
    fetchHandler = async () =>
      new Response(JSON.stringify(makeObjectData()), { status: 200 });

    const tab = makeObjectTab("people");
    const deps = makeDeps();
    const { result } = renderHook(() => useTabContent(tab, deps));

    await waitFor(() => {
      expect(result.current.content.kind).toBe("object");
    });

    // Refresh fetch is held open until we resolve it manually.
    const refreshGate = deferred<Response>();
    fetchHandler = async () => refreshGate.promise;

    act(() => {
      result.current.refreshActive();
    });

    // While the refresh is in flight the previously cached content
    // must still be returned. If we ever revert to wiping cache on
    // "loading", this assertion catches it — which is exactly the
    // flicker users reported.
    expect(result.current.content.kind).toBe("object");
    expect(
      result.current.content.kind === "object"
        ? result.current.content.data.entries
        : null,
    ).toEqual([{ entry_id: "p1", Name: "Ada" }]);

    // Resolve the refresh with the new payload.
    const refreshed = makeObjectData({
      entries: [
        { entry_id: "p1", Name: "Ada" },
        { entry_id: "p2", Name: "Grace" },
      ],
    });
    await act(async () => {
      refreshGate.resolve(
        new Response(JSON.stringify(refreshed), { status: 200 }),
      );
      // Let the microtask + reducer settle.
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(
        result.current.content.kind === "object"
          ? result.current.content.data.entries.length
          : 0,
      ).toBe(2);
    });
  });

  it("emits {kind:'loading'} when refreshActive() is called and nothing was ever cached yet", async () => {
    // Hold the fetch open so the hook stays in its loading state.
    const initialGate = deferred<Response>();
    fetchHandler = async () => initialGate.promise;

    const tab = makeObjectTab("people");
    const deps = makeDeps();
    const { result } = renderHook(() => useTabContent(tab, deps));

    expect(result.current.content).toEqual({ kind: "loading" });

    // Refreshing a never-cached tab must not produce stale content out of
    // thin air — the user should still see the loading state.
    act(() => {
      result.current.refreshActive();
    });
    expect(result.current.content).toEqual({ kind: "loading" });

    // Cleanup: resolve so the hook's pending fetch settles before unmount.
    initialGate.resolve(
      new Response(JSON.stringify(makeObjectData()), { status: 200 }),
    );
  });
});
