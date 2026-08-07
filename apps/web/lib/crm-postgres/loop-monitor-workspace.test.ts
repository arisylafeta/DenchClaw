import { describe, expect, it } from "vitest";
import { renderLoopObject, renderRunObject } from "../../../../scripts/rebattery/loop-monitor-workspace.mjs";

describe("loop monitor workspace projections", () => {
  it("renders monitoring views and live entry counts", () => {
    const loops = renderLoopObject(21);
    const runs = renderRunObject(84);
    expect(loops).toContain("entry_count: 21");
    expect(loops).toContain("name: Needs Attention");
    expect(loops).toContain("name: Waiting for Approval");
    expect(loops).toContain("operator: is_true");
    expect(runs).toContain("entry_count: 84");
    expect(runs).toContain("related_object: automation_loop");
    expect(runs).toContain("name: Run Issues");
  });
});
