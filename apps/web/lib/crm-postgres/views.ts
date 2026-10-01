import type { SavedView, ViewTypeSettings } from "../object-filters";
import { queryPg } from "../postgres";

export type PostgresObjectViews = {
  views: SavedView[];
  activeView: string | undefined;
  viewSettings: ViewTypeSettings | undefined;
};

const USER_SCOPED_OBJECTS: Record<string, true> = {
  email_thread: true, email_message: true, interaction: true, work_task: true,
};

export async function getPostgresObjectViews(objectName: string, userId = ""): Promise<PostgresObjectViews> {
  const privateViews = Object.hasOwn(USER_SCOPED_OBJECTS, objectName);
  if (privateViews && !userId) return { views: [], activeView: undefined, viewSettings: undefined };
  const [row] = await queryPg<{
    views: SavedView[] | null;
    active_view: string | null;
    view_settings: ViewTypeSettings | null;
  }>(
    `select v.views, v.active_view, v.view_settings
     from crm_objects o
     left join ${privateViews ? "crm_private_object_views" : "crm_object_views"} v
       on v.object_id = o.id ${privateViews ? "and v.user_id = $2::uuid" : ""}
     where o.name = $1`,
    privateViews ? [objectName, userId] : [objectName],
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
  userId = "",
): Promise<boolean> {
  const privateViews = Object.hasOwn(USER_SCOPED_OBJECTS, objectName);
  if (privateViews && !userId) return false;
  const table = privateViews ? "crm_private_object_views" : "crm_object_views";
  const validActiveView = views.some((view) => view.name === activeView) ? activeView : null;
  const params: unknown[] = [objectName, JSON.stringify(views), validActiveView,
    viewSettings === undefined ? null : JSON.stringify(viewSettings), viewSettings !== undefined];
  if (privateViews) params.push(userId);
  const rows = await queryPg<{ object_id: string }>(
    `insert into ${table} (object_id, views, active_view, view_settings ${privateViews ? ", user_id" : ""})
     select id, $2::jsonb, $3, $4::jsonb ${privateViews ? ", $6::uuid" : ""} from crm_objects where name = $1
     on conflict (object_id ${privateViews ? ", user_id" : ""}) do update set
       views = excluded.views,
       active_view = excluded.active_view,
       view_settings = case when $5 then excluded.view_settings else ${table}.view_settings end,
       updated_at = now()
     returning object_id`, params,
  );
  return rows.length === 1;
}

export async function updatePostgresObjectViewState(
  objectName: string,
  changes: { activeView?: string | null; viewSettings?: ViewTypeSettings },
  userId = "",
): Promise<boolean> {
  const privateViews = Object.hasOwn(USER_SCOPED_OBJECTS, objectName);
  if (privateViews && !userId) return false;
  const table = privateViews ? "crm_private_object_views" : "crm_object_views";
  const params: unknown[] = [objectName, Object.hasOwn(changes, "activeView"), changes.activeView ?? null,
    Object.hasOwn(changes, "viewSettings"), changes.viewSettings === undefined ? null : JSON.stringify(changes.viewSettings)];
  if (privateViews) params.push(userId);
  const rows = await queryPg<{ object_id: string }>(
    `insert into ${table} (object_id, view_settings ${privateViews ? ", user_id" : ""})
     select id, $5::jsonb ${privateViews ? ", $6::uuid" : ""} from crm_objects where name = $1
     on conflict (object_id ${privateViews ? ", user_id" : ""}) do update set
       active_view = case when $2 then
         case when ${table}.views @> jsonb_build_array(jsonb_build_object('name', $3::text))
           then $3::text else null end
         else ${table}.active_view end,
       view_settings = case when $4 then excluded.view_settings else ${table}.view_settings end,
       updated_at = now()
     returning object_id`, params,
  );
  return rows.length === 1;
}
