import { describe, expect, it } from "vitest";
import { changeLabel, stageToSuggest } from "./buyer-profile";

describe("stageToSuggest", () => {
  it("suggests the data's stage only when it is further along than the one set by hand", () => {
    expect(stageToSuggest(null, "Responded")).toBe("Responded");
    expect(stageToSuggest("Contacted", "Bidding")).toBe("Bidding");
    expect(stageToSuggest("Qualified", "In conversation")).toBeNull(); // Qualified is set by hand, never undone by email
    expect(stageToSuggest("Qualified", "Bidding")).toBe("Bidding");
    expect(stageToSuggest("Customer", "Bidding")).toBeNull();
    expect(stageToSuggest("Responded", "Responded")).toBeNull();
  });
});

describe("changeLabel", () => {
  it("names the field and both values", () => {
    expect(changeLabel({ field: "buyer_stage", old_value: "Contacted", new_value: "Bidding", changed_at: "" })).toBe("Stage: Contacted → Bidding");
    expect(changeLabel({ field: "buyer_capabilities", old_value: null, new_value: ["Recycle", "BMS repair"], changed_at: "" }))
      .toBe("Capabilities: empty → Recycle, BMS repair");
    expect(changeLabel({ field: "buyer_main_contact_id", old_value: "p1", new_value: null, changed_at: "" })).toBe("Main contact: p1 → empty");
  });
});
