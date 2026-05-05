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

  it("normalizes invalid and blank numeric input to empty columns", () => {
    expect(toCustomValueColumns("number", "not-a-number")).toEqual({
      text_value: null,
      number_value: null,
      boolean_value: null,
      date_value: null,
      json_value: null,
    });

    expect(toCustomValueColumns("number", "   ")).toEqual({
      text_value: null,
      number_value: null,
      boolean_value: null,
      date_value: null,
      json_value: null,
    });
  });

  it("normalizes invalid boolean strings to empty columns", () => {
    expect(toCustomValueColumns("boolean", "false").boolean_value).toBe(false);
    expect(toCustomValueColumns("boolean", "TrUe").boolean_value).toBe(true);
    expect(toCustomValueColumns("boolean", "FaLsE").boolean_value).toBe(false);

    expect(toCustomValueColumns("boolean", "yes")).toEqual({
      text_value: null,
      number_value: null,
      boolean_value: null,
      date_value: null,
      json_value: null,
    });
  });

  it("normalizes invalid date input to empty columns", () => {
    expect(toCustomValueColumns("date", new Date("2026-05-05T00:00:00.000Z")).date_value).toBe("2026-05-05T00:00:00.000Z");
    expect(toCustomValueColumns("date", "not-a-date")).toEqual({
      text_value: null,
      number_value: null,
      boolean_value: null,
      date_value: null,
      json_value: null,
    });
  });

  it("parses relation ids from scalar and json-array values", () => {
    expect(parseRelationIds("p1")).toEqual(["p1"]);
    expect(parseRelationIds('["p1","p2"]')).toEqual(["p1", "p2"]);
    expect(parseRelationIds(["p1", "p2"])).toEqual(["p1", "p2"]);
  });
});
