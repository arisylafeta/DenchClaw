import { describe, expect, it } from "vitest";
import { getCanonicalField, normalizeObjectName } from "./field-registry";

describe("field registry", () => {
  it("maps existing people display names to canonical columns", () => {
    expect(getCanonicalField("people", "Full Name")).toEqual({ table: "crm_people", column: "full_name" });
    expect(getCanonicalField("people", "Email Address")).toEqual({ table: "crm_people", column: "email" });
    expect(getCanonicalField("people", "Company")).toEqual({ table: "crm_people", column: "company_id" });
  });

  it("maps existing company display names to canonical columns", () => {
    expect(getCanonicalField("company", "Company Name")).toEqual({ table: "crm_companies", column: "name" });
    expect(getCanonicalField("company", "Domain")).toEqual({ table: "crm_companies", column: "domain" });
  });

  it("returns null for source-specific custom fields", () => {
    expect(getCanonicalField("people", "Twenty createdByWorkspaceMemberId")).toBeNull();
  });

  it("normalizes object aliases", () => {
    expect(normalizeObjectName("company")).toBe("company");
    expect(normalizeObjectName("companies")).toBe("company");
  });
});
