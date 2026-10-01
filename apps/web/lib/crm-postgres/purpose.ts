// Discovery purpose is computed from existing explicit CRM signals, never send eligibility.
export type PurposeEntity = "company" | "people";

export function purposeEntity(objectName: string): PurposeEntity | null {
  if (objectName === "company" || objectName === "companies") return "company";
  return objectName === "people" ? "people" : null;
}

export function purposeField(entity: PurposeEntity) {
  return {
    id: `virtual_${entity}_purpose`,
    name: "Purpose",
    type: "enum",
    enum_values: ["Buyer", "Dismantler"],
    enum_multiple: true,
    read_only: true,
    description: "Computed discovery purpose, not email sending eligibility.",
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

function companyBuyer(alias: string): string {
  return `(not ${internal(alias)} and (
    ${rolesMatch(alias, "buyer")}
    or ${normalized(`${alias}.buyer_category`)} ~ '^(buyer|potential-buyer|buyer-prospect|repurposer|recycler|trader|battery-repurposer-second-life)$'
    or ${normalized(`${alias}.buyer_stage`)} in ('identified', 'contacted', 'responded', 'in-conversation', 'qualified', 'bidding', 'customer')
    or nullif(btrim(${alias}.buyer_evidence), '') is not null
    or ${buyerTags(alias)}
    or exists (select 1 from crm_people purpose_contact
      where purpose_contact.company_id = ${alias}.id
        and not ${internal("purpose_contact")}
        and ${buyerTags("purpose_contact")})
  ))`;
}

function companyDismantler(alias: string): string {
  return `(not ${internal(alias)} and (
    exists (select 1 from crm_dismantlers purpose_dismantler where purpose_dismantler.company_id = ${alias}.id)
    or ${tagsMatch(alias, "^(dismantler(-.*)?|auto-dismantler|ev-dismantler-reseller)$")}
    or ${rolesMatch(alias, "dismantler")}
    or ${normalized(`${alias}.buyer_category`)} = 'dismantler'
  ))`;
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
  return `(case when ${excluded} then '{}'::text[] else array_remove(array[
    case when ${buyer} then 'Buyer'::text end,
    case when ${dismantler} then 'Dismantler'::text end
  ], null) end)`;
}
