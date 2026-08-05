// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  EMPTY_TABS_STATE,
  type WorkspaceTabsState,
  applyUrlToState,
  closeAllContent,
  closeChat,
  closeChatsForSession,
  closeContent,
  closeContentToRight,
  closeOtherContent,
  contentTabIdFor,
  createDraftChatTab,
  createSessionChatTab,
  createSubagentChatTab,
  ensureChatPresent,
  loadTabsState,
  makeContentTab,
  openChat,
  openContent,
  promoteContent,
  projectUrlState,
  saveTabsState,
  selectActiveContentTab,
  selectActivePath,
  syncChatTitles,
  togglePinContent,
  workspaceTabsReducer,
  bindChatSession,
} from "./workspace-tabs";
import { parseUrlState, serializeUrlState } from "./workspace-links";

beforeEach(() => {
  if (typeof window !== "undefined") {
    window.localStorage.clear();
  }
});

function fileInput(id: string, title: string = id) {
  return {
    id,
    kind: "file" as const,
    path: id,
    title,
  };
}

describe("openContent — preview replacement (the original bug)", () => {
  it("replaces an active preview with a new preview in the same slot", () => {
    // Reproduces: ?path=tmp/companies.sql -> click skills/crm/SKILL.md
    let state: WorkspaceTabsState = EMPTY_TABS_STATE;
    state = openContent(state, {
      ...fileInput("tmp/companies.sql", "companies.sql"),
      preview: true,
    });
    expect(state.activeContentId).toBe("tmp/companies.sql");
    expect(state.contentTabs).toHaveLength(1);

    state = openContent(state, {
      ...fileInput("skills/crm/SKILL.md", "SKILL.md"),
      preview: true,
    });

    // Old tab gone, new tab takes the slot, active id matches the new id.
    // No "stale id" window — both move atomically.
    expect(state.contentTabs.map((t) => t.id)).toEqual(["skills/crm/SKILL.md"]);
    expect(state.activeContentId).toBe("skills/crm/SKILL.md");
    expect(selectActivePath(state)).toBe("skills/crm/SKILL.md");
  });

  it("focuses an existing tab instead of duplicating it", () => {
    let state: WorkspaceTabsState = EMPTY_TABS_STATE;
    state = openContent(state, { ...fileInput("a.md"), preview: false });
    state = openContent(state, { ...fileInput("b.md"), preview: false });
    expect(state.activeContentId).toBe("b.md");

    state = openContent(state, { ...fileInput("a.md"), preview: true });
    expect(state.contentTabs.map((t) => t.id)).toEqual(["a.md", "b.md"]);
    expect(state.activeContentId).toBe("a.md");
  });

  it("promotes an existing preview to permanent when reopened with preview:false", () => {
    let state: WorkspaceTabsState = EMPTY_TABS_STATE;
    state = openContent(state, { ...fileInput("a.md"), preview: true });
    expect(state.contentTabs[0].preview).toBe(true);

    state = openContent(state, { ...fileInput("a.md"), preview: false });
    expect(state.contentTabs[0].preview).toBe(false);
    expect(state.contentTabs).toHaveLength(1);
  });

  it("does not replace a permanent tab; appends a new preview slot instead", () => {
    let state: WorkspaceTabsState = EMPTY_TABS_STATE;
    state = openContent(state, { ...fileInput("a.md"), preview: false });
    state = openContent(state, { ...fileInput("b.md"), preview: true });

    expect(state.contentTabs.map((t) => t.id)).toEqual(["a.md", "b.md"]);
    expect(state.contentTabs[0].preview).toBe(false);
    expect(state.contentTabs[1].preview).toBe(true);
    expect(state.activeContentId).toBe("b.md");

    state = openContent(state, { ...fileInput("c.md"), preview: true });
    // c.md replaces b.md (the active preview), not a.md (permanent).
    expect(state.contentTabs.map((t) => t.id)).toEqual(["a.md", "c.md"]);
    expect(state.activeContentId).toBe("c.md");
  });
});

describe("activeContentId is always valid (no stale-id window)", () => {
  it("opening a tab leaves activeContentId pointing at it (not at the replaced one)", () => {
    let state: WorkspaceTabsState = EMPTY_TABS_STATE;
    state = openContent(state, { ...fileInput("first.md"), preview: true });
    const beforeId = state.activeContentId;
    state = openContent(state, { ...fileInput("second.md"), preview: true });

    // The old id no longer points at any tab — but activeContentId moved with it.
    expect(state.contentTabs.some((t) => t.id === beforeId)).toBe(false);
    expect(state.activeContentId).not.toBe(beforeId);
    expect(state.contentTabs.some((t) => t.id === state.activeContentId)).toBe(true);
  });

  it("closing the active tab moves activeContentId to a sibling (or null)", () => {
    let state: WorkspaceTabsState = EMPTY_TABS_STATE;
    state = openContent(state, { ...fileInput("a.md"), preview: false });
    state = openContent(state, { ...fileInput("b.md"), preview: false });
    state = openContent(state, { ...fileInput("c.md"), preview: false });
    expect(state.activeContentId).toBe("c.md");

    state = closeContent(state, "c.md");
    expect(state.contentTabs.map((t) => t.id)).toEqual(["a.md", "b.md"]);
    expect(state.activeContentId).toBe("b.md");

    state = closeContent(state, "b.md");
    expect(state.activeContentId).toBe("a.md");

    state = closeContent(state, "a.md");
    expect(state.contentTabs).toHaveLength(0);
    expect(state.activeContentId).toBe(null);
  });

  it("closeOther / closeToRight / closeAll preserve a valid activeContentId", () => {
    let state: WorkspaceTabsState = EMPTY_TABS_STATE;
    state = openContent(state, { ...fileInput("a.md"), preview: false });
    state = openContent(state, { ...fileInput("b.md"), preview: false });
    state = openContent(state, { ...fileInput("c.md"), preview: false });
    state = openContent(state, { ...fileInput("d.md"), preview: false });

    state = closeContentToRight(state, "b.md");
    expect(state.contentTabs.map((t) => t.id)).toEqual(["a.md", "b.md"]);
    expect(state.contentTabs.some((t) => t.id === state.activeContentId)).toBe(true);

    state = closeOtherContent(state, "a.md");
    expect(state.contentTabs.map((t) => t.id)).toEqual(["a.md"]);
    expect(state.activeContentId).toBe("a.md");

    state = closeAllContent(state);
    expect(state.contentTabs).toHaveLength(0);
    expect(state.activeContentId).toBe(null);
  });

  it("closeAll keeps pinned tabs and activeContentId at one of them", () => {
    let state: WorkspaceTabsState = EMPTY_TABS_STATE;
    state = openContent(state, { ...fileInput("a.md"), preview: false, pinned: true });
    state = openContent(state, { ...fileInput("b.md"), preview: false });

    state = closeAllContent(state);
    expect(state.contentTabs.map((t) => t.id)).toEqual(["a.md"]);
    expect(state.contentTabs[0].pinned).toBe(true);
    // Active was on b.md (which is gone) so it falls back to null since the
    // pinned a.md was not the active tab.
    expect(state.activeContentId).toBe(null);
  });
});

describe("preview / pin promotion", () => {
  it("promoteContent removes the preview flag", () => {
    let state: WorkspaceTabsState = EMPTY_TABS_STATE;
    state = openContent(state, { ...fileInput("a.md"), preview: true });
    state = promoteContent(state, "a.md");
    expect(state.contentTabs[0].preview).toBe(false);
  });

  it("togglePinContent unsets preview when pinning", () => {
    let state: WorkspaceTabsState = EMPTY_TABS_STATE;
    state = openContent(state, { ...fileInput("a.md"), preview: true });
    state = togglePinContent(state, "a.md");
    expect(state.contentTabs[0].pinned).toBe(true);
    expect(state.contentTabs[0].preview).toBe(false);
  });

  it("makeContentTab forces preview:false when pinned:true", () => {
    const tab = makeContentTab({ ...fileInput("a.md"), preview: true, pinned: true });
    expect(tab.pinned).toBe(true);
    expect(tab.preview).toBe(false);
  });
});

describe("ensureChatPresent invariant", () => {
  it("creates a draft chat when chatTabs is empty", () => {
    const next = ensureChatPresent(EMPTY_TABS_STATE);
    expect(next.chatTabs).toHaveLength(1);
    expect(next.chatTabs[0].variant).toBe("draft");
    expect(next.activeChatId).toBe(next.chatTabs[0].id);
  });

  it("does not duplicate chat tabs when one already exists", () => {
    const draft = createDraftChatTab();
    const state: WorkspaceTabsState = {
      ...EMPTY_TABS_STATE,
      chatTabs: [draft],
      activeChatId: draft.id,
    };
    const next = ensureChatPresent(state);
    expect(next).toBe(state);
  });

  it("re-points activeChatId when it goes stale", () => {
    const draft = createDraftChatTab();
    const state: WorkspaceTabsState = {
      ...EMPTY_TABS_STATE,
      chatTabs: [draft],
      activeChatId: "ghost",
    };
    const next = ensureChatPresent(state);
    expect(next.activeChatId).toBe(draft.id);
  });

  it("closeChat preserves the invariant by re-creating a draft", () => {
    const tab = createSessionChatTab({ sessionId: "sess-1", title: "S1" });
    const state: WorkspaceTabsState = ensureChatPresent({
      ...EMPTY_TABS_STATE,
      chatTabs: [tab],
      activeChatId: tab.id,
    });
    const next = closeChat(state, tab.id);
    expect(next.chatTabs).toHaveLength(1);
    expect(next.chatTabs[0].variant).toBe("draft");
  });
});

describe("chat tab lifecycle", () => {
  it("openChat focuses an existing chat for the same id", () => {
    const tab = createSessionChatTab({ sessionId: "sess-1", title: "First" });
    let state: WorkspaceTabsState = openChat(EMPTY_TABS_STATE, tab);
    expect(state.chatTabs).toHaveLength(1);

    state = openChat(state, createSessionChatTab({ sessionId: "sess-1", title: "Renamed" }));
    expect(state.chatTabs).toHaveLength(1);
    expect(state.activeChatId).toBe("sess-1");
  });

  it("subagent chats are keyed by sessionKey", () => {
    const sub = createSubagentChatTab({ sessionKey: "agent:abc", parentSessionId: "p1", title: "Child" });
    let state: WorkspaceTabsState = openChat(EMPTY_TABS_STATE, sub);
    expect(state.chatTabs[0].id).toBe("agent:abc");
    state = openChat(state, createSubagentChatTab({ sessionKey: "agent:abc", parentSessionId: "p1" }));
    expect(state.chatTabs).toHaveLength(1);
  });

  it("closeChatsForSession removes parent + subagent tabs", () => {
    let state: WorkspaceTabsState = EMPTY_TABS_STATE;
    state = openChat(state, createSessionChatTab({ sessionId: "p1" }));
    state = openChat(state, createSubagentChatTab({ sessionKey: "k1", parentSessionId: "p1" }));
    state = openChat(state, createSessionChatTab({ sessionId: "p2" }));

    state = closeChatsForSession(state, "p1");
    expect(state.chatTabs.map((t) => t.id)).toEqual(["p2"]);
    expect(state.activeChatId).toBe("p2");
  });

  it("syncChatTitles updates titles from sessions and subagents", () => {
    let state: WorkspaceTabsState = EMPTY_TABS_STATE;
    state = openChat(state, createSessionChatTab({ sessionId: "s1", title: "Old" }));
    state = openChat(state, createSubagentChatTab({ sessionKey: "k1", parentSessionId: "s1", title: "Sub Old" }));
    state = syncChatTitles(
      state,
      [{ id: "s1", title: "Renamed Session" }],
      [{ childSessionKey: "k1", task: "T", label: "New Sub" }],
    );
    expect(state.chatTabs[0].title).toBe("Renamed Session");
    expect(state.chatTabs[1].title).toBe("New Sub");
  });

  it("bindChatSession promotes a draft to a session and reuses an existing session tab if any", () => {
    const draft = createDraftChatTab();
    let state: WorkspaceTabsState = openChat(EMPTY_TABS_STATE, draft);
    state = bindChatSession(state, draft.id, "s1");
    expect(state.chatTabs).toHaveLength(1);
    expect(state.chatTabs[0].variant).toBe("session");
    expect(state.chatTabs[0].sessionId).toBe("s1");
    // The tab `id` stays STABLE across the bind so React doesn't unmount the
    // in-flight ChatPanel (it uses `key={tab.id}` on the panel wrapper).
    expect(state.chatTabs[0].id).toBe(draft.id);
    expect(state.activeChatId).toBe(draft.id);

    // Bind a second draft to the SAME session — the existing tab wins, the
    // duplicate draft is dropped, and the active id matches the existing tab.
    const draft2 = createDraftChatTab();
    state = openChat(state, draft2);
    state = bindChatSession(state, draft2.id, "s1");
    expect(state.chatTabs).toHaveLength(1);
    expect(state.activeChatId).toBe(draft.id);
  });
});

describe("URL roundtrip / popstate idempotency", () => {
  it("applyUrl + projectUrlState are idempotent for a file URL", () => {
    const url = parseUrlState("path=knowledge/notes.md");
    let state: WorkspaceTabsState = applyUrlToState(EMPTY_TABS_STATE, url, {});
    expect(selectActivePath(state)).toBe("knowledge/notes.md");

    // Apply the same URL again — state is unchanged.
    const next = applyUrlToState(state, url, {});
    expect(next.contentTabs.map((t) => t.id)).toEqual(state.contentTabs.map((t) => t.id));
    expect(next.activeContentId).toBe(state.activeContentId);
  });

  it("applyUrl with a virtual path (~cron) opens a cron-dashboard tab", () => {
    const url = parseUrlState("path=~cron");
    const state = applyUrlToState(EMPTY_TABS_STATE, url, {});
    expect(state.activeContentId).toBe("~cron");
    expect(selectActiveContentTab(state)?.kind).toBe("cron-dashboard");
  });

  it("applyUrl with crm=people opens the people object tab", () => {
    const url = parseUrlState("crm=people");
    const state = applyUrlToState(EMPTY_TABS_STATE, url, {});
    expect(state.activeContentId).toBe("people");
    expect(selectActiveContentTab(state)?.kind).toBe("object");
  });

  it("maps path=people to the people object view without a tree resolver", () => {
    const state = applyUrlToState(EMPTY_TABS_STATE, parseUrlState("path=people"), {});
    const active = selectActiveContentTab(state);
    expect(active?.kind).toBe("object");
    expect(active?.path).toBe("people");
    expect(active?.preview).toBe(false);
  });

  it("maps path=company to the company object view without a tree resolver", () => {
    const state = applyUrlToState(EMPTY_TABS_STATE, parseUrlState("path=company"), {});
    const active = selectActiveContentTab(state);
    expect(active?.kind).toBe("object");
    expect(active?.path).toBe("company");
    expect(active?.preview).toBe(false);
  });

  it("maps legacy path=companies URLs to the canonical company object", () => {
    const state = applyUrlToState(EMPTY_TABS_STATE, parseUrlState("path=companies"), {});
    const active = selectActiveContentTab(state);
    expect(active?.kind).toBe("object");
    expect(active?.path).toBe("company");
    expect(active?.preview).toBe(false);
  });

  it("opening the Companies sidebar nav after viewing People activates the company tab (regression: 'click Companies, nothing opens')", () => {
    // Mirrors `handleNavigate("crm-companies")` → `openTabForNode` flow.
    let state: WorkspaceTabsState = EMPTY_TABS_STATE;
    state = openContent(state, {
      id: contentTabIdFor("object", "people"),
      kind: "object",
      path: "people",
      title: "People",
      preview: false,
    });
    expect(selectActiveContentTab(state)?.path).toBe("people");

    state = openContent(state, {
      id: contentTabIdFor("object", "company"),
      kind: "object",
      path: "company",
      title: "Companies",
      preview: false,
    });

    const active = selectActiveContentTab(state);
    expect(active?.kind).toBe("object");
    expect(active?.path).toBe("company");
    expect(active?.preview).toBe(false);
    expect(state.contentTabs.map((t) => t.path)).toEqual(["people", "company"]);
  });

  it("clicking Companies again while already active is a no-op (no duplicate tabs, focus preserved)", () => {
    let state: WorkspaceTabsState = openContent(EMPTY_TABS_STATE, {
      id: contentTabIdFor("object", "company"),
      kind: "object",
      path: "company",
      title: "Companies",
      preview: false,
    });
    const before = state;
    state = openContent(state, {
      id: contentTabIdFor("object", "company"),
      kind: "object",
      path: "company",
      title: "Companies",
      preview: false,
    });
    expect(state).toBe(before);
    expect(state.contentTabs).toHaveLength(1);
  });

  it("applyUrl with entry=people:abc opens a crm-person tab", () => {
    const url = parseUrlState("entry=people:abc");
    const state = applyUrlToState(EMPTY_TABS_STATE, url, {});
    expect(state.activeContentId).toBe("crm-person:abc");
    expect(selectActiveContentTab(state)?.meta?.entryId).toBe("abc");
  });

  it("round-trips a CRM company profile and selected subtab through browser history", () => {
    let state: WorkspaceTabsState = openContent(EMPTY_TABS_STATE, {
      id: contentTabIdFor("crm-company", "company", { entryId: "co_1" }),
      kind: "crm-company",
      path: "company",
      title: "Company",
      meta: { entryId: "co_1", profileTab: "team" },
      preview: true,
    });

    const companyUrl = serializeUrlState(projectUrlState(state, {
      chatSessionId: null,
      chatSubagentKey: null,
      entryModal: null,
      browseDir: null,
      showHidden: false,
      terminalOpen: false,
      cron: {
        view: "overview",
        calMode: "month",
        date: null,
        runFilter: "all",
        run: null,
      },
    }));
    expect(companyUrl).toBe("entry=company%3Aco_1&profileTab=team");

    state = applyUrlToState(state, parseUrlState("entry=people:p_1"), {});
    expect(selectActiveContentTab(state)?.kind).toBe("crm-person");

    state = applyUrlToState(state, parseUrlState(companyUrl), {});
    const active = selectActiveContentTab(state);
    expect(active?.kind).toBe("crm-company");
    expect(active?.path).toBe("company");
    expect(active?.meta).toMatchObject({ entryId: "co_1", profileTab: "team" });
  });

  it("applyUrl with no path clears the active content", () => {
    let state: WorkspaceTabsState = openContent(EMPTY_TABS_STATE, fileInput("a.md"));
    const url = parseUrlState("");
    state = applyUrlToState(state, url, {});
    expect(state.activeContentId).toBe(null);
  });

  it("contentTabIdFor produces stable ids for entry profiles", () => {
    const personId = contentTabIdFor("crm-person", "people", { entryId: "abc" });
    expect(personId).toBe("crm-person:abc");
    const companyId = contentTabIdFor("crm-company", "companies", { entryId: "def" });
    expect(companyId).toBe("crm-company:def");
    expect(contentTabIdFor("file", "x.md")).toBe("x.md");
  });
});

describe("storage", () => {
  it("persists and restores content tabs", () => {
    if (typeof window === "undefined") return;
    let state: WorkspaceTabsState = EMPTY_TABS_STATE;
    state = openContent(state, { ...fileInput("a.md"), preview: false });
    state = openContent(state, { ...fileInput("b.md"), preview: true });
    saveTabsState(state, "ws-1");

    const loaded = loadTabsState("ws-1");
    expect(loaded.contentTabs.map((t) => t.id)).toEqual(["a.md", "b.md"]);
    expect(loaded.contentTabs[1].preview).toBe(true);
    expect(loaded.activeContentId).toBe("b.md");
  });

  it("drops draft chat tabs on persist (they are recreated on load)", () => {
    if (typeof window === "undefined") return;
    let state: WorkspaceTabsState = EMPTY_TABS_STATE;
    state = openChat(state, createSessionChatTab({ sessionId: "s1", title: "Real" }));
    state = openChat(state, createDraftChatTab());
    saveTabsState(state, "ws-2");

    const loaded = loadTabsState("ws-2");
    expect(loaded.chatTabs.map((t) => t.id)).toEqual(["s1"]);
  });

  it("normalizes a stale activeContentId from storage to null", () => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      "dench:workspace-tabs:ws-3",
      JSON.stringify({
        contentTabs: [{ id: "a.md", kind: "file", path: "a.md", title: "A", preview: false, pinned: false }],
        chatTabs: [],
        activeContentId: "ghost",
        activeChatId: null,
      }),
    );
    const loaded = loadTabsState("ws-3");
    expect(loaded.activeContentId).toBe(null);
  });
});

describe("workspaceTabsReducer", () => {
  it("dispatches openContent and the bug-repro replacement", () => {
    let state: WorkspaceTabsState = EMPTY_TABS_STATE;
    state = workspaceTabsReducer(state, {
      type: "openContent",
      tab: { ...fileInput("tmp/companies.sql"), preview: true },
    });
    state = workspaceTabsReducer(state, {
      type: "openContent",
      tab: { ...fileInput("skills/crm/SKILL.md"), preview: true },
    });
    expect(state.contentTabs.map((t) => t.id)).toEqual(["skills/crm/SKILL.md"]);
    expect(state.activeContentId).toBe("skills/crm/SKILL.md");
  });

  it("dispatches activateContent and ignores unknown ids", () => {
    let state: WorkspaceTabsState = openContent(EMPTY_TABS_STATE, fileInput("a.md"));
    state = workspaceTabsReducer(state, { type: "activateContent", id: "ghost" });
    // Activating an unknown id falls back to null (not a stale tab).
    expect(state.activeContentId).toBe(null);
  });

  it("dispatches replace for full restoration", () => {
    const replacement: WorkspaceTabsState = {
      contentTabs: [makeContentTab(fileInput("x.md"))],
      chatTabs: [createDraftChatTab()],
      activeContentId: "x.md",
      activeChatId: null,
    };
    const next = workspaceTabsReducer(EMPTY_TABS_STATE, { type: "replace", state: replacement });
    expect(next).toBe(replacement);
  });
});
