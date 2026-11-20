import { describe, expect, it } from "vitest";
import { allowedSupplierCodes, countryCodeOf, countryInText, regionOfCode } from "./demand-regions";

describe("demand regions", () => {
  it("reads a country from a code, a name or free text", () => {
    expect(countryCodeOf("de")).toBe("DE");
    expect(countryCodeOf("Germany")).toBe("DE");
    expect(countryCodeOf("UK")).toBe("GB");
    expect(countryCodeOf("Atlantis")).toBeNull();
    expect(countryInText("Brumunddal (Ringsaker), Innlandet, Norway")).toBe("NO");
    expect(countryInText("Leeds, UK")).toBe("GB");
    expect(countryInText("Somewhere unknown")).toBeNull();
  });

  it("maps countries to the six regions, Turkey and Ukraine to Europe", () => {
    expect(regionOfCode("TR")).toBe("Europe");
    expect(regionOfCode("UA")).toBe("Europe");
    expect(regionOfCode("US")).toBe("America");
    expect(regionOfCode("VN")).toBe("SE Asia");
    expect(regionOfCode("SA")).toBe("Middle East");
    expect(regionOfCode("ZA")).toBe("Africa");
    expect(regionOfCode("CN")).toBe("Asia");
  });

  it("allows the union of the listed countries and the countries of the listed regions", () => {
    const allowed = allowedSupplierCodes(["Brazil"], ["Middle East"]);
    expect(allowed.has("BR")).toBe(true);
    expect(allowed.has("AE")).toBe(true);
    expect(allowed.has("DE")).toBe(false);
    expect(allowedSupplierCodes([], []).size).toBe(0);
  });
});
