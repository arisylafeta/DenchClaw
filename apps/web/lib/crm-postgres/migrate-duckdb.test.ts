import { describe, expect, it } from "vitest";
import { isCustomField, pickCanonicalValue, relationIdsFromValue } from "./migrate-duckdb";

describe("duckdb to postgres migration", () => {
  it("picks canonical values from pivot-style entries", () => {
    const row = {
      entry_id: "p1",
      "Full Name": "Ada Lovelace",
      "Email Address": "ada@example.com",
      "Strength Score": "42.5",
      "Supply Update": "true",
    };

    expect(pickCanonicalValue("people", "Full Name", row)).toBe("Ada Lovelace");
    expect(pickCanonicalValue("people", "Strength Score", row)).toBe(42.5);
    expect(pickCanonicalValue("people", "Supply Update", row)).toBeNull();
  });
});

describe("migration relation/custom helpers", () => {
  it("parses single and array relation values", () => {
    expect(relationIdsFromValue("abc")).toEqual(["abc"]);
    expect(relationIdsFromValue('["a","b"]')).toEqual(["a", "b"]);
    expect(relationIdsFromValue("")).toEqual([]);
  });

  it("routes unmapped fields to custom values", () => {
    expect(isCustomField("people", "Twenty id")).toBe(true);
    expect(isCustomField("people", "Full Name")).toBe(false);
  });
});
