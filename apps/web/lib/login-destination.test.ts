import { describe, expect, it } from "vitest";
import { getSafeLoginDestination } from "./login-destination";

const ORIGIN = "https://crm.rebattery.io";

describe("getSafeLoginDestination", () => {
  it("preserves same-origin paths and their query state", () => {
    expect(
      getSafeLoginDestination("/workspace?path=work_task#entry", ORIGIN),
    ).toBe("/workspace?path=work_task#entry");
  });

  it.each([
    null,
    "",
    "workspace",
    "https://attacker.example/x",
    "//attacker.example/x",
    "/\\attacker.example/x",
  ])("falls back to the root for an unsafe destination: %s", (destination) => {
    expect(getSafeLoginDestination(destination, ORIGIN)).toBe("/");
  });
});
