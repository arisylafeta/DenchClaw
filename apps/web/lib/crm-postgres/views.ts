import type { SavedView, ViewTypeSettings } from "../object-filters";

export type PostgresObjectViews = {
  views: SavedView[];
  activeView: string | undefined;
  viewSettings: ViewTypeSettings | undefined;
};

// crm_saved_views and crm_object_view_settings tables were dropped.
// Saved view persistence is a no-op until a replacement storage is introduced.

export async function getPostgresObjectViews(_objectName: string): Promise<PostgresObjectViews> {
  return { views: [], activeView: undefined, viewSettings: undefined };
}

export async function savePostgresObjectViews(
  _objectName: string,
  _views: SavedView[],
  _activeView?: string,
  _viewSettings?: ViewTypeSettings,
): Promise<boolean> {
  return true;
}
