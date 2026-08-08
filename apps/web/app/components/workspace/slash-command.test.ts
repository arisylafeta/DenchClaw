import { describe, expect, it, vi } from "vitest";
import { loadMentionSearchResults, type MentionSearchFn } from "./slash-command";

describe("lazy workspace mention search", () => {
  it("waits for the search index before resolving the first query", async () => {
    let loaded = false;
    const search = vi.fn(() => loaded ? [{ id: "entry-1", label: "Acme", kind: "entry" as const }] : []) as unknown as MentionSearchFn;
    search.ensureLoaded = vi.fn(async () => { loaded = true; });

    await expect(loadMentionSearchResults(search, "Acme")).resolves.toEqual([
      { id: "entry-1", label: "Acme", kind: "entry" },
    ]);
    expect(search.ensureLoaded).toHaveBeenCalledOnce();
    expect(search).toHaveBeenCalledWith("Acme", 15);
  });
});
