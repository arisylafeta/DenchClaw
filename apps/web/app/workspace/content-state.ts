/**
 * Discriminated union describing what the right-panel content area should
 * render. Extracted into its own module so the new `useTabContent` hook and
 * `ContentRenderer` can share it without pulling in the rest of the
 * workspace-content god-component.
 */

import type { TreeNode } from "../components/workspace/file-manager-tree";
import type { MediaType } from "../components/workspace/media-viewer";
import type { CronJob } from "../types/cron";
import type { CronRunLogEntry } from "../types/cron";
import type { SavedView, ViewTypeSettings } from "@/lib/object-filters";

export type ReverseRelation = {
  fieldName: string;
  sourceObjectName: string;
  sourceObjectId: string;
  displayField: string;
  entries: Record<string, Array<{ id: string; label: string }>>;
};

export type ObjectData = {
  object: {
    id: string;
    name: string;
    description?: string;
    icon?: string;
    default_view?: string;
    display_field?: string;
  };
  fields: Array<{
    id: string;
    name: string;
    type: string;
    enum_values?: string[];
    enum_colors?: string[];
    enum_multiple?: boolean;
    related_object_id?: string;
    relationship_type?: string;
    related_object_name?: string;
    sort_order?: number;
  }>;
  statuses: Array<{
    id: string;
    name: string;
    color?: string;
    sort_order?: number;
  }>;
  entries: Record<string, unknown>[];
  relationLabels?: Record<string, Record<string, string>>;
  relationFaviconUrls?: Record<string, Record<string, string>>;
  reverseRelations?: ReverseRelation[];
  effectiveDisplayField?: string;
  savedViews?: SavedView[];
  activeView?: string;
  viewSettings?: ViewTypeSettings;
  totalCount?: number;
  page?: number;
  pageSize?: number;
};

export type FileData = {
  content: string;
  type: "markdown" | "yaml" | "code" | "text";
};

export type DenchAppManifest = {
  name: string;
  description?: string;
  icon?: string;
  version?: string;
  author?: string;
  entry?: string;
  runtime?: "static" | "esbuild" | "build";
  permissions?: string[];
  display?: "full" | "widget";
  widget?: {
    width?: number;
    height?: number;
    refreshInterval?: number;
  };
  routes?: Record<string, string>;
};

export type ContentState =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "object"; data: ObjectData }
  | { kind: "document"; data: FileData; title: string }
  | { kind: "file"; data: FileData; filename: string }
  | { kind: "code"; data: FileData; filename: string; filePath: string }
  | { kind: "media"; url: string; mediaType: MediaType; filename: string; filePath: string }
  | { kind: "spreadsheet"; url: string; filename: string; filePath: string }
  | { kind: "html"; rawUrl: string; contentUrl: string; filename: string }
  | { kind: "database"; dbPath: string; filename: string }
  | { kind: "report"; reportPath: string; filename: string }
  | { kind: "directory"; node: TreeNode }
  | { kind: "cron-dashboard" }
  | { kind: "skill-store" }
  | { kind: "cloud" }
  | { kind: "cron-job"; jobId: string; job: CronJob }
  | { kind: "cron-session"; jobId: string; job: CronJob; sessionId: string; run: CronRunLogEntry }
  | { kind: "duckdb-missing" }
  | { kind: "richDocument"; html: string; filePath: string; mode: "docx" | "txt" }
  | { kind: "app"; appPath: string; manifest: DenchAppManifest; filename: string }
  | { kind: "crm-inbox" }
  | { kind: "crm-calendar" }
  | { kind: "crm-person"; entryId: string; profileTab?: string }
  | { kind: "crm-company"; entryId: string; profileTab?: string };
