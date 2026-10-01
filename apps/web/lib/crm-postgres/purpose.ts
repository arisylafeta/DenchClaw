// Discovery purpose is computed from existing explicit CRM signals, never send eligibility.
export type PurposeEntity = "company" | "people";

export function purposeEntity(objectName: string): PurposeEntity | null {
  if (objectName === "company" || objectName === "companies") return "company";
  return objectName === "people" ? "people" : null;
}

// What a company is to us. Stored in crm_companies.purpose (editable, filled by the CRM clean-up); where it is empty
// the computed Buyer/Dismantler rules below still apply, so a company no tool has classified yet is not lost.
export const COMPANY_PURPOSES = ["Buyer", "Supplier", "Dismantler", "Recycler", "Partner", "Investor", "Service provider"];

export function purposeField(entity: PurposeEntity) {
  return {
    id: `virtual_${entity}_purpose`,
    name: "Purpose",
    type: "enum",
    enum_values: entity === "company" ? COMPANY_PURPOSES : ["Buyer", "Dismantler"],
    enum_multiple: true,
    read_only: entity !== "company",
    description: entity === "company"
      ? "What the company is to us. Set by hand or by the CRM clean-up; where empty, worked out from tags and buyer fields."
      : "Computed discovery purpose, not email sending eligibility.",
    sort_order: 0,
  };
}

function normalized(expression: string): string {
  return `lower(regexp_replace(btrim(coalesce(${expression}, '')), '[[:space:]_-]+', '-', 'g'))`;
}

function tagsMatch(alias: string, pattern: string): string {
  return `exists (select 1 from unnest(coalesce(${alias}.tags, '{}'::text[])) purpose_tag(value)
    where ${normalized("purpose_tag.value")} ~ '${pattern}')`;
}

function internal(alias: string): string {
  return tagsMatch(alias, "^(internal|internal-contact|internal-company)$");
}

function buyerTags(alias: string): string {
  return tagsMatch(alias, "^(buyer(-.*)?|potential-buyer(-contact)?|qualified-buyer|inbound-buyer|channel-buyer|niche-buyer|repurposer(-.*)?|strategic-repurposer|direct-repurposer|ev-battery-repurposing|supply-updates?|new-to-supply-updates?)$");
}

function rolesMatch(alias: string, purpose: "buyer" | "dismantler"): string {
  return `(${normalized(`${alias}.platform_role`)} = '${purpose}' or exists (
    select 1 from unnest(coalesce(${alias}.roles, '{}'::text[])) purpose_role(value)
    where ${normalized("purpose_role.value")} = '${purpose}'
  ))`;
}

function storedPurpose(alias: string): string {
  return `nullif(${alias}.purpose, '{}'::text[])`;
}

function companyBuyer(alias: string): string {
  return `(not ${internal(alias)} and case when ${storedPurpose(alias)} is not null then 'Buyer' = any(${alias}.purpose) else (
    ${rolesMatch(alias, "buyer")}
    or ${normalized(`${alias}.buyer_category`)} ~ '^(buyer|potential-buyer|buyer-prospect|repurposer|recycler|trader|battery-repurposer-second-life)$'
    or ${normalized(`${alias}.buyer_stage`)} in ('identified', 'contacted', 'responded', 'in-conversation', 'qualified', 'bidding', 'customer')
    or nullif(btrim(${alias}.buyer_evidence), '') is not null
    or ${buyerTags(alias)}
    or exists (select 1 from crm_people purpose_contact
      where purpose_contact.company_id = ${alias}.id
        and not ${internal("purpose_contact")}
        and ${buyerTags("purpose_contact")})
  ) end)`;
}

function companyDismantler(alias: string): string {
  return `(not ${internal(alias)} and case when ${storedPurpose(alias)} is not null then 'Dismantler' = any(${alias}.purpose) else (
    exists (select 1 from crm_dismantlers purpose_dismantler where purpose_dismantler.company_id = ${alias}.id)
    or ${tagsMatch(alias, "^(dismantler(-.*)?|auto-dismantler|ev-dismantler-reseller)$")}
    or ${rolesMatch(alias, "dismantler")}
    or ${normalized(`${alias}.buyer_category`)} = 'dismantler'
  ) end)`;
}

// Only callers' trusted aliases are accepted; field/filter values never become SQL.
export function purposeFieldExpression(fieldId: string, alias: string): string | null {
  const entity = fieldId === "virtual_company_purpose" ? "company"
    : fieldId === "virtual_people_purpose" ? "people" : null;
  if (!entity) return null;
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error("Invalid purpose table alias");
  let buyer: string;
  let dismantler: string;
  let excluded = internal(alias);
  if (entity === "people") {
    buyer = `(${buyerTags(alias)} or exists (
      select 1 from crm_companies purpose_company where purpose_company.id = ${alias}.company_id
        and ${companyBuyer("purpose_company")}))`;
    dismantler = `(${tagsMatch(alias, "^(dismantler(-.*)?|auto-dismantler|ev-dismantler-reseller)$")} or exists (
      select 1 from crm_companies purpose_company where purpose_company.id = ${alias}.company_id
        and ${companyDismantler("purpose_company")}))`;
    excluded = `(${excluded} or exists (select 1 from crm_companies purpose_internal_company
      where purpose_internal_company.id = ${alias}.company_id and ${internal("purpose_internal_company")}))`;
  } else {
    buyer = companyBuyer(alias);
    dismantler = companyDismantler(alias);
  }
  const stored = entity === "company" ? `when ${storedPurpose(alias)} is not null then ${alias}.purpose ` : "";
  return `(case when ${excluded} then '{}'::text[] ${stored}else array_remove(array[
    case when ${buyer} then 'Buyer'::text end,
    case when ${dismantler} then 'Dismantler'::text end
  ], null) end)`;
}
