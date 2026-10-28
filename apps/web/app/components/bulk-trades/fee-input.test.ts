import { describe, expect, it } from "vitest";
import { parseFee } from "./fee-input";

describe("parseFee", () => {
  it("reads a dot before exactly three digits as thousands, never as cents", () => {
    expect(["10.000", "1.250", "1.250.000", "10,000", "€ 4 200", "4200", "10.5", "0", ""].map(parseFee))
      .toEqual([10000, 1250, 1250000, 10000, 4200, 4200, 11, 0, null]);
  });
  it("refuses anything that is not a number of 0 or more", () => {
    for (const text of ["ten", "-5", "1.2.3", "10.00.0", "1e6"]) expect(parseFee(text)).toBeUndefined();
  });
});
