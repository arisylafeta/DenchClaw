import { queryPg } from "../postgres";
import { buildRegistry, type Registry, type RegistryRows } from "../bulk-registry";

const TTL_MS = 30_000;
let cached: { at: number; registry: Registry } | null = null;

/** The attribute registry from the database. Cached briefly in the server process; edits show within seconds. */
export async function loadRegistry(): Promise<Registry> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.registry;
  const [attributes, kinds, options, requiredFiles, documentTypes] = await Promise.all([
    queryPg<RegistryRows["attributes"][number]>(
      `select key, side, label, type, needed_for, visibility, group_name, min::float8 as min, max::float8 as max, sort_order from crm_bulk_attributes`),
    queryPg<RegistryRows["kinds"][number]>(`select attribute_key, kind, label, sort_order from crm_bulk_attribute_kinds`),
    queryPg<RegistryRows["options"][number]>(`select attribute_key, value, sort_order from crm_bulk_attribute_options`),
    queryPg<RegistryRows["requiredFiles"][number]>(`select file_type, label, needed_for, sort_order from crm_bulk_required_files`),
    queryPg<RegistryRows["documentTypes"][number]>(`select doc_type, sort_order from crm_bulk_document_types`),
  ]);
  const registry = buildRegistry({ attributes, kinds, options, requiredFiles, documentTypes });
  cached = { at: Date.now(), registry };
  return registry;
}

/** For tests and after an admin edit. */
export function clearRegistryCache() {
  cached = null;
}
