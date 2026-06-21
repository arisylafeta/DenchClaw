import { describe, expect, it } from "vitest";
import { parseRelationIds } from "./value-codec";

describe("crm-postgres value-codec", () => {
  it("parses relation ids from scalar and json-array values", () => {
    expect(parseRelationIds("p1")).toEqual(["p1"]);
    expect(parseRelationIds('["p1","p2"]')).toEqual(["p1", "p2"]);
    expect(parseRelationIds(["p1", "p2"])).toEqual(["p1", "p2"]);
  });
});
