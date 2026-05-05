import { describe, expect, it } from "vitest";
import { parseRelationIds, toCustomValueColumns } from "./value-codec";

describe("crm-postgres value-codec", () => {
  it("maps text-like fields to text_value", () => {
    expect(toCustomValueColumns("email", "a@example.com")).toEqual({
      text_value: "a@example.com",
      number_value: null,
      boolean_value: null,
      date_value: null,
      json_value: null,
    });
  });

  it("maps number, boolean, date, and json values", () => {
    expect(toCustomValueColumns("number", "42").number_value).toBe(42);
    expect(toCustomValueColumns("boolean", "true").boolean_value).toBe(true);
    expect(toCustomValueColumns("date", "2026-05-05T00:00:00.000Z").date_value).toBe("2026-05-05T00:00:00.000Z");
    expect(toCustomValueColumns("tags", ["a", "b"]).json_value).toEqual(["a", "b"]);
  });

  it("parses relation ids from scalar and json-array values", () => {
    expect(parseRelationIds("p1")).toEqual(["p1"]);
    expect(parseRelationIds('["p1","p2"]')).toEqual(["p1", "p2"]);
    expect(parseRelationIds(["p1", "p2"])).toEqual(["p1", "p2"]);
  });
});
