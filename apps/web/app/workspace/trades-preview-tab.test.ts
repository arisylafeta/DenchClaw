// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { inferContentTabKindFromPath, inferContentTabTitle } from "@/lib/workspace-tabs";
import { nodeToContentTabKind } from "./workspace-content";

describe("Trades Preview tab", () => {
  it("opens as its own page from the sidebar, a link or a URL, not as a folder listing", () => {
    // The sidebar and in-app links open a synthetic folder node for the path.
    expect(nodeToContentTabKind("folder", "~trades-preview")).toBe("trades-preview");
    expect(inferContentTabKindFromPath("~trades-preview")).toBe("trades-preview");
    expect(inferContentTabTitle("~trades-preview")).toBe("Bulk Trades");
  });
});
