import type { SavedView, ViewTypeSettings } from "../object-filters";
import { queryPg } from "../postgres";

export type PostgresObjectViews = {
  views: SavedView[];
  activeView: string | undefined;
  viewSettings: ViewTypeSettings | undefined;
};

export async function getPostgresObjectViews(objectName: string): Promise<PostgresObjectViews> {
  const [row] = await queryPg<{
    views: SavedView[] | null;
    active_view: string | null;
    view_settings: ViewTypeSettings | null;
  }>(
    `select v.views, v.active_view, v.view_settings
     from crm_objects o
     left join crm_object_views v on v.object_id = o.id
     where o.name = $1`,
    [objectName],
  );
  return {
    views: row?.views ?? [],
    activeView: row?.active_view ?? undefined,
    viewSettings: row?.view_settings ?? undefined,
  };
}

export async function savePostgresObjectViews(
  objectName: string,
  views: SavedView[],
  activeView?: string,
  viewSettings?: ViewTypeSettings,
): Promise<boolean> {
  const validActiveView = views.some((view) => view.name === activeView) ? activeView : null;
  const rows = await queryPg<{ object_id: string }>(
    `insert into crm_object_views (object_id, views, active_view, view_settings)
     select id, $2::jsonb, $3, $4::jsonb from crm_objects where name = $1
     on conflict (object_id) do update set
       views = excluded.views,
       active_view = excluded.active_view,
       view_settings = case when $5 then excluded.view_settings else crm_object_views.view_settings end,
       updated_at = now()
     returning object_id`,
    [
      objectName,
      JSON.stringify(views),
      validActiveView,
      viewSettings === undefined ? null : JSON.stringify(viewSettings),
      viewSettings !== undefined,
    ],
  );
  return rows.length === 1;
}
