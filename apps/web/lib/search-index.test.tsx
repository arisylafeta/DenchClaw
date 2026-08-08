// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useSearchIndex } from "./search-index";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useSearchIndex", () => {
  it("loads lazily on first search and reuses the cached index", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({
        items: [{ id: "company-1", label: "Acme Batteries", kind: "entry" }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useSearchIndex());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.search.isLoaded()).toBe(false);

    act(() => {
      expect(result.current.search("Acme")).toEqual([]);
      result.current.search("Acme");
    });

    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(result.current.search.isLoaded()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.search("Acme")[0]).toMatchObject({ label: "Acme Batteries" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("allows callers to preload the index on demand", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ json: async () => ({ items: [] }) });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSearchIndex());

    await act(async () => {
      await result.current.ensureLoaded();
      await result.current.ensureLoaded();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe(false);
  });
});
