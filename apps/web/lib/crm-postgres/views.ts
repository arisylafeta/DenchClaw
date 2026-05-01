import type { SavedView, ViewType, ViewTypeSettings } from "../object-filters";
import { normalizeFilterGroup } from "../object-filters";
import { queryPg, withPgTransaction, type PgTransaction } from "../postgres";

type ObjectRow = { id: string };

type SavedViewRow = {
  id?: string;
  name: string;
  view_type?: ViewType | null;
  filters?: SavedView["filters"] | null;
  sort?: SavedView["sort"] | null;
  columns?: string[] | null;
  column_widths?: Record<string, number> | null;
  settings?: ViewTypeSettings | null;
};

type ViewSettingsRow = {
  active_view_name?: string | null;
  settings?: ViewTypeSettings | null;
};

export type PostgresObjectViews = {
  views: SavedView[];
  activeView: string | undefined;
  viewSettings: ViewTypeSettings | undefined;
};

function toSavedView(row: SavedViewRow): SavedView {
  return {
    name: row.name,
    view_type: row.view_type ?? undefined,
    filters: row.filters ? normalizeFilterGroup(row.filters) : undefined,
    sort: row.sort ?? undefined,
    columns: row.columns ?? undefined,
    column_widths: row.column_widths ?? undefined,
    settings: row.settings ?? undefined,
  };
}

function generatedViewId(objectId: string, name: string): string {
  return `crm_saved_view:${objectId}:${encodeURIComponent(name)}`;
}

async function getObjectId(objectName: string): Promise<string | undefined> {
  const objects = await queryPg<ObjectRow>(
    "select id from crm_objects where name = $1 limit 1",
    [objectName],
  );
  return objects[0]?.id;
}

export async function getPostgresObjectViews(objectName: string): Promise<PostgresObjectViews> {
  const objectId = await getObjectId(objectName);
  if (!objectId) {
    return { views: [], activeView: undefined, viewSettings: undefined };
  }

  const viewRows = await queryPg<SavedViewRow>(
    `select name, view_type, filters, sort, columns, column_widths, settings
     from crm_saved_views
     where object_id = $1
     order by sort_order, name`,
    [objectId],
  );

  const settingsRows = await queryPg<ViewSettingsRow>(
    `select sv.name as active_view_name, ovs.settings
     from crm_object_view_settings ovs
     left join crm_saved_views sv on sv.id = ovs.active_view_id
     where ovs.object_id = $1
     limit 1`,
    [objectId],
  );

  return {
    views: viewRows.map(toSavedView),
    activeView: settingsRows[0]?.active_view_name ?? undefined,
    viewSettings: settingsRows[0]?.settings ?? undefined,
  };
}

export async function savePostgresObjectViews(
  objectName: string,
  views: SavedView[],
  activeView?: string,
  viewSettings?: ViewTypeSettings,
): Promise<boolean> {
  const objectId = await getObjectId(objectName);
  if (!objectId) return false;

  await withPgTransaction(async (tx: PgTransaction) => {
    const txQuery = async <T extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T[]> => {
      const result = await tx.query(sql, [...params]);
      return Array.isArray(result) ? result as T[] : result.rows as T[];
    };

    await txQuery("delete from crm_saved_views where object_id = $1", [objectId]);

    let activeViewId: string | null = null;
    for (const [index, view] of views.entries()) {
      const id = generatedViewId(objectId, view.name);
      const rows = await txQuery<{ id: string }>(
        `insert into crm_saved_views
          (id, object_id, name, view_type, filters, sort, columns, column_widths, settings, sort_order, updated_at)
         values ($1, $2, $3, coalesce($4, 'table'), $5, $6, $7, $8, $9, $10, now())
         returning id`,
        [
          id,
          objectId,
          view.name,
          view.view_type ?? null,
          view.filters ?? null,
          view.sort ?? null,
          view.columns ?? null,
          view.column_widths ?? null,
          view.settings ?? null,
          index,
        ],
      );

      if (view.name === activeView) {
        activeViewId = rows[0]?.id ?? id;
      }
    }

    await txQuery(
      `insert into crm_object_view_settings (object_id, active_view_id, settings, updated_at)
       values ($1, $2, coalesce($3, '{}'::jsonb), now())
       on conflict (object_id) do update set
         active_view_id = excluded.active_view_id,
         settings = excluded.settings,
         updated_at = now()`,
      [objectId, activeViewId, viewSettings ?? {}],
    );
  });

  return true;
}
