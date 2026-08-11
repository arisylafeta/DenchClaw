/**
 * Workspace tabs state — single source of truth for the right-panel content
 * tabs and the center-column chat tabs.
 *
 * Replaces the older `tab-state.ts` + `chat-tabs.ts` + ad-hoc
 * `activePath` / `content` / `activeContentTabId` state in
 * `workspace-content.tsx`. The previous design had multiple racing pieces of
 * state plus a destructive cleanup effect; this module keeps every invariant
 * in pure reducer functions so the staleness window does not exist.
 *
 * Key invariants enforced by every reducer:
 *  - Tab ids are STABLE for the lifetime of a tab. Content tabs use the
 *    `path` (or a `kind:`-prefixed key for non-path views) as their id;
 *    preview replacement removes the old tab and inserts a new one with the
 *    new path-id atomically. There is no `generateTabId()` for previews.
 *  - Chat tab ids are likewise STABLE. A draft tab promoted to a real session
 *    via `bindChatSession` keeps its `draft:xxx` id so React does not remount
 *    the in-flight `<ChatPanel>` (which is keyed off `tab.id`). Lookups that
 *    care about the underlying session use the `sessionId` field.
 *  - `activeContentId` is either `null` or appears in
 *    `contentTabs.map(t => t.id)`. Updated atomically with the list.
 *  - `activeChatId` is non-null whenever `chatTabs.length > 0`. The
 *    `ensureChatPresent` helper re-adds a draft chat tab if the list ever
 *    becomes empty.
 */

import {
  type CalendarMode,
  type FilterGroup,
  type SortRule,
  type ViewType,
} from "./object-filters";
import {
  type WorkspaceUrlState,
  type CronDashboardView,
  type CronRunStatusFilter,
  type CrmView,
} from "./workspace-links";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Describes the kind of view a content tab renders. Mirrors the old
 * `ContentState.kind` discriminant, which kept content rendering type-safe.
 * The hook layer (`use-tab-content`) maps each kind to a fetcher and a
 * `ContentState` payload.
 */
export type ContentTabKind =
  | "object"
  | "directory"
  | "browse"
  | "document"
  | "richDocument"
  | "file"
  | "code"
  | "media"
  | "spreadsheet"
  | "html"
  | "database"
  | "report"
  | "app"
  | "cron-dashboard"
  | "cron-job"
  | "skills"
  | "cloud"
  | "crm-inbox"
  | "crm-calendar"
  | "crm-person"
  | "crm-company";

/**
 * Tab in the right-panel content strip.
 *
 * `id` is the canonical key. For most kinds it is the path, e.g.
 * `"knowledge/notes.md"` or `"~cron/job-1"`. For kinds that are not 1:1 with a
 * path (entry profiles, browse mode), it is a kind-prefixed string —
 * `"crm-person:abc123"`, `"browse:/abs/path"`. This keeps the id stable across
 * preview replacement.
 */
export type ContentTab = {
  id: string;
  kind: ContentTabKind;
  /** Workspace path, virtual path (`~cron`, `~skills`, etc.), or absolute path for browse. */
  path: string;
  title: string;
  icon?: string;
  /** True for ephemeral preview tabs that get replaced when the user opens another preview. */
  preview: boolean;
  /** Pinned tabs survive close-others / close-all. Pinned implies non-preview. */
  pinned: boolean;
  /** Optional kind-specific payload preserved across activations. */
  meta?: ContentTabMeta;
};

/**
 * Lightweight metadata carried on the tab itself so the loader can render
 * synchronously when the kind doesn't need a network fetch (browse,
 * cron-job, crm-person, crm-company). Non-essential — most tabs leave this
 * unset and let `useTabContent` do all the work.
 */
export type ContentTabMeta = {
  /** For `crm-person` / `crm-company`: the entry id to render. */
  entryId?: string;
  /** For `crm-person` / `crm-company`: the active profile subtab. */
  profileTab?: string;
  /** For `cron-job`: the cron job id. */
  cronJobId?: string;
  /** For `browse`: the absolute filesystem dir to list. */
  browsePath?: string;
};

export type ContentTabInput = Omit<ContentTab, "id" | "preview" | "pinned"> & {
  /** Optional explicit id; when omitted, derived from `kind` + `path` + `meta`. */
  id?: string;
  preview?: boolean;
  pinned?: boolean;
};

export type ChatTabVariant = "draft" | "session" | "subagent" | "gateway";

/**
 * Tab in the center-column chat strip.
 *
 * Chat tabs use a stable id chosen by `makeChatTab`:
 *  - draft chats: `"draft:<uuid>"`
 *  - real sessions: the `sessionId`
 *  - subagents: the `sessionKey`
 *  - gateway sessions: the `sessionKey`
 */
export type ChatTab = {
  id: string;
  variant: ChatTabVariant;
  title: string;
  preview: boolean;
  pinned: boolean;
  sessionId?: string;
  sessionKey?: string;
  parentSessionId?: string;
  channel?: string;
};

export type ChatTabInput = Omit<ChatTab, "id" | "preview" | "pinned"> & {
  id?: string;
  preview?: boolean;
  pinned?: boolean;
};

export type WorkspaceTabsState = {
  contentTabs: ContentTab[];
  chatTabs: ChatTab[];
  /** `null` when nothing is open in the right panel (placeholder). */
  activeContentId: string | null;
  /** Always points at a chat tab once `ensureChatPresent` has run. */
  activeChatId: string | null;
};

export const EMPTY_TABS_STATE: WorkspaceTabsState = {
  contentTabs: [],
  chatTabs: [],
  activeContentId: null,
  activeChatId: null,
};

// ---------------------------------------------------------------------------
// Action shape
// ---------------------------------------------------------------------------

/** Shell-level URL state passed to `applyUrlToState` for hydration / popstate. */
export type ShellUrlState = {
  /** Cron jobs known at hydration time, used to enrich cron-job tabs. */
  cronJobIds?: ReadonlySet<string>;
  /** Workspace path resolver (returns the kind for a workspace-relative path). */
  resolveKind?: (path: string) => ContentTabKind | null;
};

export type WorkspaceTabsAction =
  | { type: "openContent"; tab: ContentTabInput }
  | { type: "closeContent"; id: string }
  | { type: "closeOtherContent"; id: string }
  | { type: "closeContentToRight"; id: string }
  | { type: "closeAllContent" }
  | { type: "activateContent"; id: string | null }
  | { type: "promoteContent"; id: string }
  | { type: "promoteContentByPath"; path: string }
  | { type: "togglePinContent"; id: string }
  | { type: "updateContentMeta"; id: string; meta: Partial<ContentTabMeta> }
  | { type: "reorderContent"; id: string; toIndex: number }
  | { type: "renameContent"; id: string; title: string }
  | { type: "openChat"; tab: ChatTabInput }
  | { type: "closeChat"; id: string }
  | { type: "closeChatsForSession"; sessionId: string }
  | { type: "activateChat"; id: string | null }
  | { type: "promoteChat"; id: string }
  | { type: "togglePinChat"; id: string }
  | { type: "renameChat"; id: string; title: string }
  | { type: "bindChatSession"; tabId: string; sessionId: string | null }
  | {
      type: "syncChatTitles";
      sessions: ReadonlyArray<{ id: string; title: string }>;
      subagents: ReadonlyArray<{ childSessionKey: string; label?: string; task: string }>;
    }
  | { type: "ensureChatPresent" }
  | {
      type: "applyUrl";
      url: WorkspaceUrlState;
      shell: ShellUrlState;
    }
  | { type: "replace"; state: WorkspaceTabsState };

// ---------------------------------------------------------------------------
// Tab constructors / id helpers
// ---------------------------------------------------------------------------

/**
 * Build a stable content-tab id from kind + path. Kinds that share their path
 * with another kind (e.g. CRM entry profiles) get a prefix so the same path
 * can host multiple tabs. The id is what URL routing keys off; making it
 * deterministic is what allows preview replacement to be a clean two-step.
 */
export function contentTabIdFor(kind: ContentTabKind, path: string, meta?: ContentTabMeta): string {
  switch (kind) {
    case "crm-person":
      return `crm-person:${meta?.entryId ?? path}`;
    case "crm-company":
      return `crm-company:${meta?.entryId ?? path}`;
    case "browse":
      return `browse:${meta?.browsePath ?? path}`;
    default:
      return path;
  }
}

export function makeContentTab(input: ContentTabInput): ContentTab {
  const id = input.id ?? contentTabIdFor(input.kind, input.path, input.meta);
  const preview = input.preview ?? true;
  const pinned = input.pinned ?? false;
  return {
    id,
    kind: input.kind,
    path: input.path,
    title: input.title,
    icon: input.icon,
    meta: input.meta,
    preview: pinned ? false : preview,
    pinned,
  };
}

/** Stable id for a chat tab. */
export function chatTabIdFor(variant: ChatTabVariant, params: {
  sessionId?: string;
  sessionKey?: string;
  draftId?: string;
}): string {
  if (variant === "draft") return `draft:${params.draftId ?? randomDraftId()}`;
  if (variant === "subagent" || variant === "gateway") {
    if (params.sessionKey) return params.sessionKey;
  }
  if (params.sessionId) return params.sessionId;
  return `draft:${randomDraftId()}`;
}

function randomDraftId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function makeChatTab(input: ChatTabInput): ChatTab {
  const id = input.id ?? chatTabIdFor(input.variant, {
    sessionId: input.sessionId,
    sessionKey: input.sessionKey,
  });
  const preview = input.preview ?? true;
  const pinned = input.pinned ?? false;
  return {
    id,
    variant: input.variant,
    title: input.title,
    preview: pinned ? false : preview,
    pinned,
    sessionId: input.sessionId,
    sessionKey: input.sessionKey,
    parentSessionId: input.parentSessionId,
    channel: input.channel,
  };
}

export function createDraftChatTab(title: string = "New Chat"): ChatTab {
  return makeChatTab({
    id: chatTabIdFor("draft", { draftId: randomDraftId() }),
    variant: "draft",
    title,
    preview: true,
  });
}

export function createSessionChatTab(params: { sessionId: string; title?: string }): ChatTab {
  return makeChatTab({
    id: params.sessionId,
    variant: "session",
    title: params.title || "New Chat",
    sessionId: params.sessionId,
  });
}

export function createSubagentChatTab(params: {
  sessionKey: string;
  parentSessionId: string;
  title?: string;
}): ChatTab {
  return makeChatTab({
    id: params.sessionKey,
    variant: "subagent",
    title: params.title || "Subagent",
    sessionKey: params.sessionKey,
    parentSessionId: params.parentSessionId,
  });
}

export function createGatewayChatTab(params: {
  sessionKey: string;
  sessionId: string;
  channel: string;
  title?: string;
}): ChatTab {
  return makeChatTab({
    id: params.sessionKey,
    variant: "gateway",
    title: params.title || "Channel Chat",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    channel: params.channel,
  });
}

// ---------------------------------------------------------------------------
// Content-tab kind / icon inference
// ---------------------------------------------------------------------------

/** Infer the content-tab kind from a workspace path. Used by URL hydration. */
export function inferContentTabKindFromPath(path: string): ContentTabKind {
  if (path === "~cron") return "cron-dashboard";
  if (path.startsWith("~cron/")) return "cron-job";
  if (path === "~skills") return "skills";
  if (path === "~cloud") return "cloud";
  if (path === "~crm/inbox") return "crm-inbox";
  if (path === "~crm/calendar") return "crm-calendar";
  return "file";
}

/** Build a default title from a path when none was provided. */
export function inferContentTabTitle(path: string, fallback?: string): string {
  if (fallback) return fallback;
  if (path === "~cron") return "Cron";
  if (path.startsWith("~cron/")) return path.slice("~cron/".length) || "Cron Job";
  if (path === "~skills") return "Skills";
  if (path === "~cloud") return "Cloud";
  if (path === "~crm/inbox") return "Inbox";
  if (path === "~crm/calendar") return "Calendar";
  return path.split("/").pop() || path;
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export function selectActiveContentTab(state: WorkspaceTabsState): ContentTab | null {
  if (!state.activeContentId) return null;
  return state.contentTabs.find((t) => t.id === state.activeContentId) ?? null;
}

export function selectActiveChatTab(state: WorkspaceTabsState): ChatTab | null {
  if (!state.activeChatId) return null;
  return state.chatTabs.find((t) => t.id === state.activeChatId) ?? null;
}

export function selectActivePath(state: WorkspaceTabsState): string | null {
  return selectActiveContentTab(state)?.path ?? null;
}

export function findContentTabByPath(
  state: WorkspaceTabsState,
  path: string,
): ContentTab | null {
  return state.contentTabs.find((t) => t.path === path) ?? null;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function withActiveContent(state: WorkspaceTabsState, id: string | null): WorkspaceTabsState {
  if (id !== null && !state.contentTabs.some((t) => t.id === id)) {
    return { ...state, activeContentId: null };
  }
  if (state.activeContentId === id) return state;
  return { ...state, activeContentId: id };
}

function withActiveChat(state: WorkspaceTabsState, id: string | null): WorkspaceTabsState {
  if (id !== null && !state.chatTabs.some((t) => t.id === id)) {
    return { ...state, activeChatId: null };
  }
  if (state.activeChatId === id) return state;
  return { ...state, activeChatId: id };
}

function findActivePreviewIndex(tabs: ContentTab[], activeId: string | null): number {
  // Prefer the active preview tab (the slot the user is currently looking at).
  if (activeId) {
    const i = tabs.findIndex((t) => t.id === activeId && t.preview);
    if (i !== -1) return i;
  }
  return tabs.findIndex((t) => t.preview);
}

/**
 * Insert or focus a content tab.
 *
 * Behavior:
 *  - If a tab with this id already exists: focus it. If `input.preview === false`
 *    promote it to permanent. No new tab created.
 *  - Otherwise, if the requested tab is preview AND there is an existing
 *    preview tab in the same slot: REPLACE the existing preview with the new
 *    tab atomically. The new active id matches the new tab's id immediately.
 *  - Otherwise append the new tab and focus it.
 */
export function openContent(
  state: WorkspaceTabsState,
  input: ContentTabInput,
): WorkspaceTabsState {
  const tab = makeContentTab(input);

  const existingIdx = state.contentTabs.findIndex((t) => t.id === tab.id);
  if (existingIdx !== -1) {
    let nextTabs = state.contentTabs;
    const existing = state.contentTabs[existingIdx];
    const metadataChanged =
      existing.kind !== tab.kind ||
      existing.path !== tab.path ||
      JSON.stringify(existing.meta ?? {}) !== JSON.stringify(tab.meta ?? {});
    if (metadataChanged) {
      nextTabs = [...state.contentTabs];
      nextTabs[existingIdx] = {
        ...nextTabs[existingIdx],
        kind: tab.kind,
        path: tab.path,
        meta: tab.meta,
      };
    }
    if (!tab.preview && state.contentTabs[existingIdx].preview) {
      if (nextTabs === state.contentTabs) {
        nextTabs = [...state.contentTabs];
      }
      nextTabs[existingIdx] = { ...nextTabs[existingIdx], preview: false };
    }
    if (nextTabs === state.contentTabs && state.activeContentId === tab.id) {
      return state;
    }
    return { ...state, contentTabs: nextTabs, activeContentId: tab.id };
  }

  if (tab.preview) {
    const previewIdx = findActivePreviewIndex(state.contentTabs, state.activeContentId);
    if (previewIdx !== -1) {
      const nextTabs = [...state.contentTabs];
      nextTabs[previewIdx] = tab;
      return { ...state, contentTabs: nextTabs, activeContentId: tab.id };
    }
  }

  return {
    ...state,
    contentTabs: [...state.contentTabs, tab],
    activeContentId: tab.id,
  };
}

export function closeContent(
  state: WorkspaceTabsState,
  id: string,
): WorkspaceTabsState {
  const idx = state.contentTabs.findIndex((t) => t.id === id);
  if (idx === -1) return state;
  if (state.contentTabs[idx].pinned) return state;

  const nextTabs = state.contentTabs.filter((t) => t.id !== id);

  let activeId = state.activeContentId;
  if (activeId === id) {
    if (nextTabs.length === 0) {
      activeId = null;
    } else if (idx < nextTabs.length) {
      activeId = nextTabs[idx].id;
    } else {
      activeId = nextTabs[nextTabs.length - 1].id;
    }
  }

  return { ...state, contentTabs: nextTabs, activeContentId: activeId };
}

export function closeOtherContent(
  state: WorkspaceTabsState,
  id: string,
): WorkspaceTabsState {
  const keep = state.contentTabs.filter((t) => t.id === id || t.pinned);
  return { ...state, contentTabs: keep, activeContentId: id };
}

export function closeContentToRight(
  state: WorkspaceTabsState,
  id: string,
): WorkspaceTabsState {
  const idx = state.contentTabs.findIndex((t) => t.id === id);
  if (idx === -1) return state;
  const keep = state.contentTabs.filter((t, i) => i <= idx || t.pinned);
  const activeStillPresent = keep.some((t) => t.id === state.activeContentId);
  return {
    ...state,
    contentTabs: keep,
    activeContentId: activeStillPresent ? state.activeContentId : id,
  };
}

export function closeAllContent(state: WorkspaceTabsState): WorkspaceTabsState {
  const keep = state.contentTabs.filter((t) => t.pinned);
  const activeStillPresent = keep.some((t) => t.id === state.activeContentId);
  return {
    ...state,
    contentTabs: keep,
    activeContentId: activeStillPresent ? state.activeContentId : null,
  };
}

export function activateContent(
  state: WorkspaceTabsState,
  id: string | null,
): WorkspaceTabsState {
  return withActiveContent(state, id);
}

export function promoteContent(
  state: WorkspaceTabsState,
  id: string,
): WorkspaceTabsState {
  let changed = false;
  const nextTabs = state.contentTabs.map((t) => {
    if (t.id !== id || !t.preview) return t;
    changed = true;
    return { ...t, preview: false };
  });
  return changed ? { ...state, contentTabs: nextTabs } : state;
}

export function promoteContentByPath(
  state: WorkspaceTabsState,
  path: string,
): WorkspaceTabsState {
  const tab = state.contentTabs.find((t) => t.path === path);
  if (!tab) return state;
  return promoteContent(state, tab.id);
}

export function togglePinContent(
  state: WorkspaceTabsState,
  id: string,
): WorkspaceTabsState {
  let changed = false;
  const nextTabs = state.contentTabs.map((t) => {
    if (t.id !== id) return t;
    changed = true;
    const pinned = !t.pinned;
    return { ...t, pinned, preview: pinned ? false : t.preview };
  });
  return changed ? { ...state, contentTabs: nextTabs } : state;
}

export function updateContentMeta(
  state: WorkspaceTabsState,
  id: string,
  meta: Partial<ContentTabMeta>,
): WorkspaceTabsState {
  let changed = false;
  const nextTabs = state.contentTabs.map((tab) => {
    if (tab.id !== id) return tab;
    const nextMeta = { ...(tab.meta ?? {}), ...meta };
    if (JSON.stringify(tab.meta ?? {}) === JSON.stringify(nextMeta)) {
      return tab;
    }
    changed = true;
    return { ...tab, meta: nextMeta };
  });
  return changed ? { ...state, contentTabs: nextTabs } : state;
}

export function reorderContent(
  state: WorkspaceTabsState,
  id: string,
  toIndex: number,
): WorkspaceTabsState {
  const fromIndex = state.contentTabs.findIndex((t) => t.id === id);
  if (fromIndex === -1 || fromIndex === toIndex) return state;
  const clamped = Math.max(0, Math.min(state.contentTabs.length - 1, toIndex));
  const nextTabs = [...state.contentTabs];
  const [moved] = nextTabs.splice(fromIndex, 1);
  nextTabs.splice(clamped, 0, moved);
  return { ...state, contentTabs: nextTabs };
}

export function renameContent(
  state: WorkspaceTabsState,
  id: string,
  title: string,
): WorkspaceTabsState {
  let changed = false;
  const nextTabs = state.contentTabs.map((t) => {
    if (t.id !== id || t.title === title) return t;
    changed = true;
    return { ...t, title };
  });
  return changed ? { ...state, contentTabs: nextTabs } : state;
}

// --- chat tab reducers ---

export function openChat(
  state: WorkspaceTabsState,
  input: ChatTabInput,
): WorkspaceTabsState {
  const tab = makeChatTab(input);
  let existingIdx = state.chatTabs.findIndex((t) => t.id === tab.id);
  // Also dedupe by `sessionId` for session-variant tabs: a draft tab promoted
  // to a session keeps its `draft:xxx` id (so React doesn't unmount the
  // ChatPanel — see `bindChatSession`), but conceptually represents the same
  // session. Re-opening that session from history must focus the existing tab
  // instead of creating a parallel one.
  if (existingIdx === -1 && tab.variant === "session" && tab.sessionId) {
    existingIdx = state.chatTabs.findIndex(
      (t) => t.variant === "session" && t.sessionId === tab.sessionId,
    );
  }
  if (existingIdx !== -1) {
    const existing = state.chatTabs[existingIdx];
    let nextTabs = state.chatTabs;
    if (!tab.preview && existing.preview) {
      nextTabs = [...state.chatTabs];
      nextTabs[existingIdx] = { ...nextTabs[existingIdx], preview: false };
    }
    if (nextTabs === state.chatTabs && state.activeChatId === existing.id) {
      return state;
    }
    return { ...state, chatTabs: nextTabs, activeChatId: existing.id };
  }
  return {
    ...state,
    chatTabs: [...state.chatTabs, tab],
    activeChatId: tab.id,
  };
}

export function closeChat(
  state: WorkspaceTabsState,
  id: string,
): WorkspaceTabsState {
  const idx = state.chatTabs.findIndex((t) => t.id === id);
  if (idx === -1) return state;
  if (state.chatTabs[idx].pinned) return state;

  const nextTabs = state.chatTabs.filter((t) => t.id !== id);

  let activeId = state.activeChatId;
  if (activeId === id) {
    if (nextTabs.length === 0) {
      activeId = null;
    } else if (idx < nextTabs.length) {
      activeId = nextTabs[idx].id;
    } else {
      activeId = nextTabs[nextTabs.length - 1].id;
    }
  }

  return ensureChatPresent({ ...state, chatTabs: nextTabs, activeChatId: activeId });
}

export function closeChatsForSession(
  state: WorkspaceTabsState,
  sessionId: string,
): WorkspaceTabsState {
  const nextTabs = state.chatTabs.filter((t) => {
    if (t.pinned) return true;
    return t.sessionId !== sessionId && t.parentSessionId !== sessionId;
  });
  if (nextTabs.length === state.chatTabs.length) return state;

  const activeStillPresent = nextTabs.some((t) => t.id === state.activeChatId);
  const fallbackId = activeStillPresent
    ? state.activeChatId
    : nextTabs[nextTabs.length - 1]?.id ?? null;
  return ensureChatPresent({ ...state, chatTabs: nextTabs, activeChatId: fallbackId });
}

export function activateChat(
  state: WorkspaceTabsState,
  id: string | null,
): WorkspaceTabsState {
  return withActiveChat(state, id);
}

export function promoteChat(
  state: WorkspaceTabsState,
  id: string,
): WorkspaceTabsState {
  let changed = false;
  const nextTabs = state.chatTabs.map((t) => {
    if (t.id !== id || !t.preview) return t;
    changed = true;
    return { ...t, preview: false };
  });
  return changed ? { ...state, chatTabs: nextTabs } : state;
}

export function togglePinChat(
  state: WorkspaceTabsState,
  id: string,
): WorkspaceTabsState {
  let changed = false;
  const nextTabs = state.chatTabs.map((t) => {
    if (t.id !== id) return t;
    changed = true;
    const pinned = !t.pinned;
    return { ...t, pinned, preview: pinned ? false : t.preview };
  });
  return changed ? { ...state, chatTabs: nextTabs } : state;
}

export function renameChat(
  state: WorkspaceTabsState,
  id: string,
  title: string,
): WorkspaceTabsState {
  let changed = false;
  const nextTabs = state.chatTabs.map((t) => {
    if (t.id !== id || t.title === title) return t;
    changed = true;
    return { ...t, title };
  });
  return changed ? { ...state, chatTabs: nextTabs } : state;
}

export function bindChatSession(
  state: WorkspaceTabsState,
  tabId: string,
  sessionId: string | null,
): WorkspaceTabsState {
  const tab = state.chatTabs.find((t) => t.id === tabId);
  if (!tab) return state;

  // If a real session tab for this id already exists, focus it and drop the
  // (typically draft) tab that was being bound.
  if (sessionId) {
    const existing = state.chatTabs.find(
      (t) => t.id !== tabId && t.variant === "session" && t.sessionId === sessionId,
    );
    if (existing) {
      const tabs = tab.pinned
        ? state.chatTabs
        : state.chatTabs.filter((t) => t.id !== tabId);
      return ensureChatPresent({ ...state, chatTabs: tabs, activeChatId: existing.id });
    }
  }

  // Otherwise mutate the tab in place. Promote it from "draft" to "session"
  // when it gains a session id.
  //
  // CRITICAL: keep the tab `id` STABLE across the bind. The chat panel stack
  // renders `<div key={tab.id}><ChatPanel .../></div>`, so changing the id
  // would unmount the in-flight ChatPanel and remount a fresh one, dropping
  // its useChat stream + reconnect attempts mid-send. The `sessionId` field
  // is what downstream code (URL projection, lookups, history) reads, not
  // the opaque tab id.
  const nextSessionId = sessionId ?? undefined;
  if (tab.sessionId === nextSessionId && (sessionId == null || tab.variant === "session")) {
    return state;
  }
  const nextTab: ChatTab = {
    ...tab,
    sessionId: nextSessionId,
    variant: sessionId ? "session" : "draft",
    id: tab.id,
  };
  const nextTabs = state.chatTabs.map((t) => (t.id === tabId ? nextTab : t));
  const activeChatId = state.activeChatId === tabId ? nextTab.id : state.activeChatId;
  return { ...state, chatTabs: nextTabs, activeChatId };
}

export function syncChatTitles(
  state: WorkspaceTabsState,
  sessions: ReadonlyArray<{ id: string; title: string }>,
  subagents: ReadonlyArray<{ childSessionKey: string; label?: string; task: string }>,
): WorkspaceTabsState {
  const titleBySessionId = new Map(sessions.map((s) => [s.id, s.title]));
  const titleBySessionKey = new Map(
    subagents.map((sa) => [sa.childSessionKey, sa.label || sa.task]),
  );
  let changed = false;
  const nextTabs = state.chatTabs.map((t) => {
    if (t.variant === "session" && t.sessionId) {
      const next = titleBySessionId.get(t.sessionId);
      if (next && next !== t.title) {
        changed = true;
        return { ...t, title: next };
      }
    }
    if (t.variant === "subagent" && t.sessionKey) {
      const next = titleBySessionKey.get(t.sessionKey);
      if (next && next !== t.title) {
        changed = true;
        return { ...t, title: next };
      }
    }
    return t;
  });
  return changed ? { ...state, chatTabs: nextTabs } : state;
}

export function ensureChatPresent(state: WorkspaceTabsState): WorkspaceTabsState {
  if (state.chatTabs.length > 0) {
    if (state.activeChatId && state.chatTabs.some((t) => t.id === state.activeChatId)) {
      return state;
    }
    return { ...state, activeChatId: state.chatTabs[0].id };
  }
  const draft = createDraftChatTab();
  return { ...state, chatTabs: [draft], activeChatId: draft.id };
}

// ---------------------------------------------------------------------------
// URL projection
// ---------------------------------------------------------------------------

/**
 * Project the active workspace state onto a URL state. The chat panel state
 * (`activeSessionId`, `activeSubagentKey`) is fed in separately because the
 * URL only carries chat info when no content tab is open.
 */
export function projectUrlState(
  state: WorkspaceTabsState,
  shell: {
    chatSessionId: string | null;
    chatSubagentKey: string | null;
    entryModal: { objectName: string; entryId: string } | null;
    browseDir: string | null;
    showHidden: boolean;
    terminalOpen: boolean;
    cron: {
      view: CronDashboardView;
      calMode: CalendarMode;
      date: string | null;
      runFilter: CronRunStatusFilter;
      run: number | null;
    };
    /** Object-view params that are owned by ObjectView and projected through. */
    objectViewParams?: Partial<{
      viewType: ViewType;
      view: string;
      filters: FilterGroup;
      search: string;
      sort: SortRule[];
      page: number;
      pageSize: number;
      cols: string[];
    }>;
  },
): Partial<WorkspaceUrlState> {
  const tab = selectActiveContentTab(state);
  const out: Partial<WorkspaceUrlState> = {};

  if (tab) {
    if (tab.kind === "crm-person" && tab.meta?.entryId) {
      out.entry = { objectName: "people", entryId: tab.meta.entryId };
      if (tab.meta.profileTab && tab.meta.profileTab !== "overview") {
        out.profileTab = tab.meta.profileTab;
      }
    } else if (tab.kind === "crm-company" && tab.meta?.entryId) {
      out.entry = { objectName: "company", entryId: tab.meta.entryId };
      if (tab.meta.profileTab && tab.meta.profileTab !== "overview") {
        out.profileTab = tab.meta.profileTab;
      }
    } else {
      out.path = tab.path;
    }
    if (shell.entryModal) {
      out.entry = shell.entryModal;
    }
    if (tab.kind === "cron-dashboard") {
      if (shell.cron.view !== "overview") out.cronView = shell.cron.view;
      if (shell.cron.view === "calendar" && shell.cron.calMode !== "month") out.cronCalMode = shell.cron.calMode;
      if ((shell.cron.view === "calendar" || shell.cron.view === "timeline") && shell.cron.date) {
        out.cronDate = shell.cron.date;
      }
    } else if (tab.kind === "cron-job") {
      if (shell.cron.runFilter !== "all") out.cronRunFilter = shell.cron.runFilter;
      if (shell.cron.run != null) out.cronRun = shell.cron.run;
    }
    if (shell.objectViewParams) {
      const o = shell.objectViewParams;
      if (o.viewType) out.viewType = o.viewType;
      if (o.view) out.view = o.view;
      if (o.filters) out.filters = o.filters;
      if (o.search) out.search = o.search;
      if (o.sort) out.sort = o.sort;
      if (o.page != null) out.page = o.page;
      if (o.pageSize != null) out.pageSize = o.pageSize;
      if (o.cols) out.cols = o.cols;
    }
  } else if (shell.chatSessionId) {
    out.chat = shell.chatSessionId;
    if (shell.chatSubagentKey) out.subagent = shell.chatSubagentKey;
  }

  if (shell.browseDir) out.browse = shell.browseDir;
  if (shell.showHidden) out.hidden = true;
  if (shell.terminalOpen) out.terminal = true;
  return out;
}

// ---------------------------------------------------------------------------
// URL hydration
// ---------------------------------------------------------------------------

/**
 * Build a content tab from a URL state's `path`. Returns `null` for chat-only
 * URLs (where `path` is null).
 */
export function contentTabFromUrl(
  url: WorkspaceUrlState,
  shell: ShellUrlState,
): ContentTab | null {
  if (!url.path) {
    if (url.crm === "people") {
      return makeContentTab({
        kind: "object",
        path: "people",
        title: "People",
        preview: false,
      });
    }
    if (url.crm === "companies") {
      return makeContentTab({
        kind: "object",
        path: "company",
        title: "Companies",
        preview: false,
      });
    }
    if (url.crm === "inbox") {
      return makeContentTab({
        kind: "crm-inbox",
        path: "~crm/inbox",
        title: "Inbox",
        preview: false,
      });
    }
    if (url.crm === "calendar") {
      return makeContentTab({
        kind: "crm-calendar",
        path: "~crm/calendar",
        title: "Calendar",
        preview: false,
      });
    }
    return null;
  }

  const path = url.path;
  // Direct CRM object URLs must hydrate as CRM object tabs even when the
  // workspace tree / kind resolver is not yet available.
  if (path === "people") {
    return makeContentTab({
      kind: "object",
      path: "people",
      title: "People",
      preview: false,
    });
  }
  if (path === "company" || path === "companies") {
    return makeContentTab({
      kind: "object",
      path: "company",
      title: "Companies",
      preview: false,
    });
  }
  const kind = shell.resolveKind?.(path) ?? inferContentTabKindFromPath(path);
  return makeContentTab({
    kind,
    path,
    title: inferContentTabTitle(path),
    preview: true,
  });
}

/**
 * Apply a URL state to the tabs state, opening/focusing the appropriate
 * content tab and routing the browse / hidden flags through. Idempotent: if
 * the URL already matches the current state the result equals the input.
 */
export function applyUrlToState(
  state: WorkspaceTabsState,
  url: WorkspaceUrlState,
  shell: ShellUrlState,
): WorkspaceTabsState {
  let next = state;

  // Entry modals overlay path tabs; the entry id is handled by the shell, but
  // people/company entries get routed to the dedicated profile tab here.
  if (url.entry) {
    const isPerson = url.entry.objectName === "people";
    const isCompany = url.entry.objectName === "company" || url.entry.objectName === "companies";
    if (isPerson || isCompany) {
      const kind: ContentTabKind = isPerson ? "crm-person" : "crm-company";
      const path = isPerson ? "people" : "company";
      next = openContent(next, {
        id: contentTabIdFor(kind, path, { entryId: url.entry.entryId }),
        kind,
        path,
        title: isPerson ? "Person" : "Company",
        meta: {
          entryId: url.entry.entryId,
          ...(url.profileTab ? { profileTab: url.profileTab } : {}),
        },
        preview: true,
      });
      return next;
    }
  }

  const tab = contentTabFromUrl(url, shell);
  if (tab) {
    next = openContent(next, tab);
  } else if (!url.chat) {
    // Bare URL: clear the active content. The placeholder shows.
    next = { ...next, activeContentId: null };
  }

  return next;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const STORAGE_PREFIX = "dench:workspace-tabs";

function storageKey(workspaceId?: string | null): string {
  return `${STORAGE_PREFIX}:${workspaceId || "default"}`;
}

type PersistedShape = {
  contentTabs: ContentTab[];
  chatTabs: ChatTab[];
  activeContentId: string | null;
  activeChatId: string | null;
};

export function loadTabsState(workspaceId: string | null): WorkspaceTabsState {
  if (typeof window === "undefined") return EMPTY_TABS_STATE;
  try {
    const raw = window.localStorage.getItem(storageKey(workspaceId));
    if (!raw) return EMPTY_TABS_STATE;
    const parsed = JSON.parse(raw) as Partial<PersistedShape>;
    const contentTabs = Array.isArray(parsed.contentTabs)
      ? parsed.contentTabs.filter(isContentTab)
      : [];
    const chatTabs = Array.isArray(parsed.chatTabs)
      ? parsed.chatTabs.filter(isChatTab)
      : [];
    let activeContentId: string | null = parsed.activeContentId ?? null;
    if (activeContentId && !contentTabs.some((t) => t.id === activeContentId)) {
      activeContentId = null;
    }
    let activeChatId: string | null = parsed.activeChatId ?? null;
    if (activeChatId && !chatTabs.some((t) => t.id === activeChatId)) {
      activeChatId = chatTabs[0]?.id ?? null;
    }
    return { contentTabs, chatTabs, activeContentId, activeChatId };
  } catch {
    return EMPTY_TABS_STATE;
  }
}

export function saveTabsState(
  state: WorkspaceTabsState,
  workspaceId: string | null,
): void {
  if (typeof window === "undefined") return;
  try {
    const payload: PersistedShape = {
      contentTabs: state.contentTabs.map(stripContentTab),
      // Drafts have ephemeral ids; persisting them only adds noise on reload.
      // (The hydration effect re-creates a fresh draft via ensureChatPresent.)
      chatTabs: state.chatTabs
        .filter((t) => t.variant !== "draft" || t.pinned)
        .map(stripChatTab),
      activeContentId: state.activeContentId,
      activeChatId: state.activeChatId,
    };
    window.localStorage.setItem(storageKey(workspaceId), JSON.stringify(payload));
  } catch {
    // localStorage full / unavailable — ignore.
  }
}

function isContentTab(value: unknown): value is ContentTab {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.path === "string" &&
    typeof v.title === "string" &&
    typeof v.kind === "string"
  );
}

function isChatTab(value: unknown): value is ChatTab {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.title === "string" &&
    typeof v.variant === "string"
  );
}

function stripContentTab(tab: ContentTab): ContentTab {
  return {
    id: tab.id,
    kind: tab.kind,
    path: tab.path,
    title: tab.title,
    icon: tab.icon,
    meta: tab.meta,
    preview: tab.preview,
    pinned: tab.pinned,
  };
}

function stripChatTab(tab: ChatTab): ChatTab {
  return {
    id: tab.id,
    variant: tab.variant,
    title: tab.title,
    sessionId: tab.sessionId,
    sessionKey: tab.sessionKey,
    parentSessionId: tab.parentSessionId,
    channel: tab.channel,
    preview: tab.preview,
    pinned: tab.pinned,
  };
}

// ---------------------------------------------------------------------------
// Reducer entry point
// ---------------------------------------------------------------------------

export function workspaceTabsReducer(
  state: WorkspaceTabsState,
  action: WorkspaceTabsAction,
): WorkspaceTabsState {
  switch (action.type) {
    case "openContent":
      return openContent(state, action.tab);
    case "closeContent":
      return closeContent(state, action.id);
    case "closeOtherContent":
      return closeOtherContent(state, action.id);
    case "closeContentToRight":
      return closeContentToRight(state, action.id);
    case "closeAllContent":
      return closeAllContent(state);
    case "activateContent":
      return activateContent(state, action.id);
    case "promoteContent":
      return promoteContent(state, action.id);
    case "promoteContentByPath":
      return promoteContentByPath(state, action.path);
    case "togglePinContent":
      return togglePinContent(state, action.id);
    case "updateContentMeta":
      return updateContentMeta(state, action.id, action.meta);
    case "reorderContent":
      return reorderContent(state, action.id, action.toIndex);
    case "renameContent":
      return renameContent(state, action.id, action.title);

    case "openChat":
      return openChat(state, action.tab);
    case "closeChat":
      return closeChat(state, action.id);
    case "closeChatsForSession":
      return closeChatsForSession(state, action.sessionId);
    case "activateChat":
      return activateChat(state, action.id);
    case "promoteChat":
      return promoteChat(state, action.id);
    case "togglePinChat":
      return togglePinChat(state, action.id);
    case "renameChat":
      return renameChat(state, action.id, action.title);
    case "bindChatSession":
      return bindChatSession(state, action.tabId, action.sessionId);
    case "syncChatTitles":
      return syncChatTitles(state, action.sessions, action.subagents);
    case "ensureChatPresent":
      return ensureChatPresent(state);

    case "applyUrl":
      return applyUrlToState(state, action.url, action.shell);

    case "replace":
      return action.state;
  }
}
