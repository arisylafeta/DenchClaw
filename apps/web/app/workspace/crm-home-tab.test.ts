// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { inferContentTabKindFromPath, inferContentTabTitle } from "@/lib/workspace-tabs";
import { nodeToContentTabKind } from "./workspace-content";

describe("CRM Home tab", () => {
  it("opens as its own page from the sidebar, a link or a URL, not as a folder listing", () => {
    expect(nodeToContentTabKind("folder", "~crm/home")).toBe("crm-home");
    expect(inferContentTabKindFromPath("~crm/home")).toBe("crm-home");
    expect(inferContentTabTitle("~crm/home")).toBe("Home");
  });
});
