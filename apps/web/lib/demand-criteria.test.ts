import { describe, expect, it } from "vitest";
import { addable, describe as show, draftFor, patchFor, readCriteria, validateDraft, type Price } from "./demand-criteria";
import type { MatchCriteria } from "./matches-types";

const base: MatchCriteria = {
  spec: { formats: ["Cells", "Modules"], cell_formats: ["Prismatic"], excludes: ["Pouch cells"], min_lot_kwh: 500, supplier_countries: ["Poland"] },
  max_price: 40, price_currency: "EUR", price_unit: "kWh", volume: null, volume_unit: null, location: "Ukraine (Kharkiv base; delivery site tbc)",
};

describe("readCriteria", () => {
  it("reads each saved field as a criterion and leaves the others absent", () => {
    const v = readCriteria(base);
    expect(v.formats).toEqual(["Cells", "Modules"]);
    expect(v.min_lot_kwh).toBe("500");
    expect(v.max_price).toEqual({ cur: "EUR", amt: "40", unit: "kWh" });
    expect(v.delivery).toBe("Ukraine");
    expect(v.supplier_countries).toEqual(["Poland"]);
    expect(v.volume).toBeUndefined();
    expect(v.min_price).toBeUndefined();
    expect(Object.keys(addable(v).ours)).toHaveLength(2); // price floor and supplier region
  });

  it("reads a price floor from the spec and a kWh range from kwh_min and kwh_max", () => {
    const v = readCriteria({ ...base, spec: { price_floor: { amount: 20, currency: "EUR", unit: "kWh" }, kwh_min: 0.2, kwh_max: 1 } });
    expect(v.min_price).toEqual({ cur: "EUR", amt: "20", unit: "kWh" });
    expect(v.kwh_unit).toEqual({ min: "0.2", max: "1" });
  });

  it("shows pouch exclusions as 'No pouch cells'", () => {
    expect(show("excludes", ["Pouch cells", "Water or impact damage"])).toEqual(["No pouch cells", "No water or impact damage"]);
  });
});

describe("validateDraft", () => {
  const v = readCriteria(base);
  it("treats an empty editor as Cancel", () => {
    expect(validateDraft("formats", [], v)).toBe("empty");
    expect(validateDraft("min_lot_kwh", "", v)).toBe("empty");
  });
  it("checks numbers and ranges", () => {
    expect(validateDraft("min_soh", "101", v)).toBe("Must be 100 or less.");
    expect(validateDraft("min_soh", "abc", v)).toBe("Enter a number.");
    expect(validateDraft("kwh_unit", { min: "2", max: "1" }, v)).toBe("Minimum is above maximum.");
    expect(validateDraft("kwh_unit", { min: "1", max: "" }, v)).toBe("Enter both a minimum and a maximum.");
    expect(validateDraft("kwh_unit", { min: "0", max: "1" }, v)).toBe("Values must be above 0.");
  });
  it("keeps the price floor at or below the ceiling when currency and unit match", () => {
    expect(validateDraft("min_price", { cur: "EUR", amt: "50", unit: "kWh" }, v)).toMatch(/Floor is above the ceiling/);
    expect(validateDraft("min_price", { cur: "USD", amt: "50", unit: "kWh" }, v)).toBeNull();
    expect(validateDraft("min_price", { cur: "EUR", amt: "30", unit: "kWh" }, v)).toBeNull();
    expect(validateDraft("max_price", { cur: "EUR", amt: "10", unit: "kWh" }, { ...v, min_price: { cur: "EUR", amt: "20", unit: "kWh" } as Price })).toMatch(/Ceiling is below the floor/);
  });
  it("rejects makes the registry does not list", () => {
    const options = { lists: { makes: ["Tesla", "Volvo"] } };
    expect(validateDraft("makes", "tesla, Volvo", v, options)).toBeNull();
    expect(validateDraft("makes", "Tesla, Foo", v, options)).toMatch(/Foo/);
  });
});

describe("draftFor", () => {
  it("starts a new price floor in the ceiling's currency and unit", () => {
    expect(draftFor("min_price", undefined, base)).toEqual({ cur: "EUR", amt: "", unit: "kWh" });
  });
});

describe("patchFor", () => {
  it("sends the whole spec with only the edited key changed", () => {
    const body = patchFor("chemistries", ["NMC", "LFP"], base) as { spec: Record<string, unknown> };
    expect(body.spec).toEqual({ ...base.spec, chemistries: ["NMC", "LFP"] });
    expect(base.spec.chemistries).toBeUndefined(); // the input is not mutated
  });
  it("removes a key by sending the spec without it", () => {
    expect((patchFor("min_lot_kwh", null, base) as { spec: Record<string, unknown> }).spec).not.toHaveProperty("min_lot_kwh");
    expect((patchFor("supplier_countries", null, base) as { spec: Record<string, unknown> }).spec).not.toHaveProperty("supplier_countries");
  });
  it("saves the ceiling with its currency and unit, and clears all three together", () => {
    expect(patchFor("max_price", { cur: "USD", amt: "55", unit: "kWh" }, base)).toEqual({ max_price: 55, price_currency: "USD", price_unit: "kWh" });
    expect(patchFor("max_price", null, base)).toEqual({ max_price: null, price_currency: null, price_unit: null });
  });
  it("keeps the price floor in the spec as one object", () => {
    const body = patchFor("min_price", { cur: "EUR", amt: "20", unit: "kWh" }, base) as { spec: Record<string, unknown> };
    expect(body.spec.price_floor).toEqual({ amount: 20, currency: "EUR", unit: "kWh" });
    expect(body.spec.min_lot_kwh).toBe(500);
  });
  it("saves quantity, delivery and the kWh range on their own fields", () => {
    expect(patchFor("volume", { n: "500", unit: "kWh" }, base)).toEqual({ volume: 500, volume_unit: "kWh" });
    expect(patchFor("volume", null, base)).toEqual({ volume: null, volume_unit: null });
    expect(patchFor("delivery", "Poland", base)).toEqual({ location: "Poland" });
    expect(patchFor("delivery", null, base)).toEqual({ location: null });
    const range = patchFor("kwh_unit", { min: "0.2", max: "1" }, base) as { spec: Record<string, unknown> };
    expect(range.spec).toMatchObject({ kwh_min: 0.2, kwh_max: 1 });
  });
  it("normalises makes to the registry's spelling", () => {
    const body = patchFor("makes", "tesla, VOLVO", base, { lists: { makes: ["Tesla", "Volvo"] } }) as { spec: Record<string, unknown> };
    expect(body.spec.makes).toEqual(["Tesla", "Volvo"]);
  });
});
