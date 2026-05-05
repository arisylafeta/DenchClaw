import { queryPg } from "../postgres";

type DbObject = {
  id?: string | null;
  name: string;
  description?: string | null;
  default_view?: string;
};

type DbObjectRow = {
  id?: string | null;
  name: string;
  description?: string | null;
  default_view?: string | null;
};

export async function loadPostgresTreeObjects(): Promise<Map<string, DbObject>> {
  const rows = await queryPg<DbObjectRow>(`
    select id, name, description, default_view
    from crm_objects
    where hidden_in_sidebar = false
    order by sort_order, name
  `);
  const objects = new Map<string, DbObject>();
  for (const row of rows) {
    objects.set(row.name, {
      ...row,
      default_view: row.default_view ?? undefined,
    });
  }
  return objects;
}
