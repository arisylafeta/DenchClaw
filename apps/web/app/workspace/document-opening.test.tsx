// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState, type ComponentProps } from 'react'
import type { RightPanelContent } from '../components/workspace/right-panel-content'
import { createSessionChatTab, EMPTY_TABS_STATE, saveTabsState, workspaceTabsReducer } from '@/lib/workspace-tabs'
import { conversationKey } from '@/lib/hermes-conversations'

const fixture = vi.hoisted(() => ({
  width: 1440,
  params: new URLSearchParams(),
  ready: true, enabled: false,
  selected: null as { key: string; title: string } | null,
  lastCreatedKey: null as string | null,
  router: { push: vi.fn(), replace: vi.fn() },
  tree: [{ path: 'reports/sample.docx', name: 'sample.docx', type: 'file' }],
}))
const noop = () => {}
const mediaListeners = new Set<() => void>()
function resizeViewport(width: number) {
  act(() => {
    fixture.width = width
    for (const update of mediaListeners) {update()}
    window.dispatchEvent(new Event('resize'))
  })
}
const watcher = {
  tree: fixture.tree, loading: false, exists: true, workspaceRoot: '/synthetic',
  activeWorkspace: 'synthetic' as string | null, browseDir: null as string | null, parentDir: null,
  refresh: noop, reconnect: noop, setBrowseDir: noop, setShowHidden: noop,
  subscribeChanges: () => noop,
}
vi.mock('next/navigation', () => ({
  useSearchParams: () => fixture.params, useRouter: () => fixture.router,
}))
vi.mock('next/dynamic', () => ({ default: () => () => null }))
vi.mock('../hooks/use-workspace-watcher', () => ({ useWorkspaceWatcher: () => watcher }))
vi.mock('@/lib/search-index', () => ({ useSearchIndex: () => ({ search: noop }) }))
vi.mock('../components/workspace/hermes-conversations', () => ({
  useHermesConversations: () => ({ enabled: fixture.enabled, ready: fixture.ready, selected: fixture.selected, lastCreatedKey: fixture.lastCreatedKey, listing: fixture.enabled ? { sessions: [] } : null, newChat: () => {}, clear: () => {}, selectKey: async () => false }),
  HermesConversationList: () => null, HermesConversationPanel: () => null,
  HermesNewChatDialog: () => null,
}))
vi.mock('../components/workspace/toast', () => ({ ToastProvider: ({ children }: { children: React.ReactNode }) => children }))
vi.mock('../components/chat-panel', () => ({
  ChatPanel: ({ headerLeftSlot, headerRightSlot, initializing, conversationUnselected, onDraftChange, onNewChatSession, onToggleTerminal }: { headerLeftSlot?: React.ReactNode; headerRightSlot?: React.ReactNode; initializing?: boolean; conversationUnselected?: boolean; onDraftChange?: (dirty: boolean) => void; onNewChatSession?: () => void; onToggleTerminal?: () => void }) => {
    const [draft, setDraft] = useState('')
    return <><header data-chat-chrome="panel">{headerLeftSlot}{onNewChatSession && <button title="New chat" onClick={onNewChatSession}>New chat</button>}{onToggleTerminal && <button title="Open terminal (Cmd/Ctrl+J)" aria-label="Open terminal" onClick={onToggleTerminal}>Terminal</button>}{headerRightSlot}</header><textarea aria-label="Draft" value={draft} onChange={e => { setDraft(e.target.value); onDraftChange?.(!!e.target.value) }} /><button disabled={initializing || conversationUnselected}>Synthetic send</button><a href="/?path=reports%2Fsample.docx">Open generated document</a></>
  },
}))
// Keep the real shell, URL/link handlers, resolver, reducer and panel containers.
// Editors/data views are unrelated to visibility; expose their received tab identity
// and close control so assertions observe the actual desktop width/mobile drawer.
vi.mock('../components/workspace/right-panel-content', () => ({
  RightPanelContent: (props: ComponentProps<typeof RightPanelContent>) => {
    const [text, setText] = useState('')
    return <section data-testid="panel-content">
    {props.narrow && <button aria-label="Back to chat" onClick={props.onShowChat}>Chat</button>}
    <textarea aria-label="Unsaved artifact" value={text} onChange={e => setText(e.target.value)} />
    <span data-testid="active-path">{props.activeContentTab?.path}</span>
    <span data-testid="tab-count">{props.tabsState.contentTabs.length}</span>
    <button onClick={() => props.onSetRightPanelCollapsed(true)}>Close document panel</button>
  </section>
  },
}))
vi.mock('../components/workspace/workspace-sidebar', () => ({
  WorkspaceSidebar: ({ mobile, onClose, onSelect, customCrmObjects = [], loading }: { mobile?: boolean; onClose?: () => void; onSelect: (node: typeof fixture.tree[number]) => void; customCrmObjects?: { name: string }[]; loading?: boolean }) => <nav aria-label={mobile ? 'Mobile sidebar' : 'Desktop sidebar'}>
    {loading ? <span>Loading navigation</span> : customCrmObjects.map(object => <button key={object.name}>{object.name}</button>)}
    {mobile && <button aria-label="Close sidebar" onClick={onClose}>Back</button>}
    <button onClick={() => onSelect(fixture.tree[0])}>Select document</button>
  </nav>,
}))
for (const path of [
  '../components/workspace/file-manager-tree',
  '../components/workspace/object-table', '../components/workspace/object-kanban',
  '../components/workspace/object-calendar', '../components/workspace/object-timeline',
  '../components/workspace/object-gallery', '../components/workspace/object-list',
  '../components/workspace/view-type-switcher', '../components/workspace/view-settings-popover',
  '../components/workspace/icon-picker', '../components/workspace/document-view',
  '../components/workspace/file-viewer', '../components/workspace/spreadsheet-editor',
  '../components/workspace/html-viewer', '../components/workspace/app-viewer',
  '../components/workspace/code-editor', '../components/workspace/media-viewer',
  '../components/workspace/database-viewer', '../components/workspace/rich-document-editor',
  '../components/workspace/breadcrumbs', '../components/workspace/empty-state',
  '../components/charts/report-viewer', '../components/crm/inbox/inbox-view',
  '../components/crm/calendar-view', '../components/crm/person-profile',
  '../components/crm/company-profile', '../components/workspace/entry-detail-panel',
  '../components/dismantlers/dismantlers-view',
  '../components/marketplace-pulse/marketplace-pulse-view', '../components/leaderboard/leaderboard-view',
  '../components/cron/cron-dashboard', '../components/skill-store/skill-store-panel',
  '../components/settings/cloud-settings-panel', '../components/cron/cron-job-detail',
  '../components/cron/cron-session-view', '../components/workspace/object-filter-bar',
  '../components/workspace/chat-sessions-sidebar', '../components/workspace/group-chat',
]) vi.doMock(path, () => Object.fromEntries([
  'WorkspaceSidebar', 'FileManagerTree', 'ObjectTable', 'AddEntryModal', 'ObjectKanban',
  'ObjectCalendar', 'ObjectTimeline', 'ObjectGallery', 'ObjectList', 'ViewTypeSwitcher',
  'ViewSettingsPopover', 'IconPicker', 'DocumentView', 'FileViewer', 'isSpreadsheetFile',
  'SpreadsheetEditor', 'HtmlViewer', 'AppViewer', 'MonacoCodeEditor', 'MediaViewer',
  'detectMediaType', 'DatabaseViewer', 'DuckDBMissing', 'RichDocumentEditor', 'isDocxFile',
  'isTxtFile', 'textToHtml', 'Breadcrumbs', 'EmptyState', 'ReportViewer', 'InboxView',
  'CalendarView', 'PersonProfile', 'CompanyProfile', 'EntryDetailPanel', 'BulkTradesView',
  'DismantlersView', 'MarketplacePulseView', 'LeaderboardView', 'CronDashboard',
  'SkillStorePanel', 'CloudSettingsPanel', 'CronJobDetail', 'CronSessionView',
  'ObjectFilterBar', 'ChatSessionsSidebar', 'GroupBadge',
].map(name => [name, () => null])))

const { WorkspaceShell } = await import('./workspace-content')

beforeEach(() => {
  fixture.width = 1440
  watcher.activeWorkspace = 'synthetic'
  fixture.ready = true; fixture.enabled = false
  fixture.selected = null; fixture.lastCreatedKey = null
  mediaListeners.clear()
  fixture.params = new URLSearchParams()
  fixture.router.push.mockClear()
  fixture.router.replace.mockClear()
  localStorage.clear()
  localStorage.setItem('dench-workspace-right-panel-collapsed', '1')
  window.history.replaceState(null, '', '/')
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() { return query.includes('min-width') ? fixture.width >= Number(query.match(/\d+/)?.[0]) : fixture.width <= Number(query.match(/\d+/)?.[0]) },
    addEventListener: (_event: string, listener: () => void) => mediaListeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => mediaListeners.delete(listener),
  }))
  // All ancillary shell requests are synthetic; no server or provider is used.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ sessions: [], jobs: [] }) })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function panelIsOpen(container: HTMLElement) {
  if (fixture.width < 1024) return container.querySelector('aside[aria-label="Files and content"]')?.getAttribute('aria-hidden') === 'false'
  const panel = screen.getByTestId('panel-content').closest('aside')!
  return parseFloat(panel.style.width) > 0
}

async function clickDocument() {
  expect(fireEvent.click(await screen.findByText('Open generated document'))).toBe(false)
}

// jsdom does not lay out CSS, so assert the real shell's rendered width/drawer,
// not toBeVisible (which considers zero-width clipped panels visible).
describe.each([1440, 1024, 1023, 768, 767, 390])('document opening (width=%s)', (width) => {
  it('reveals a collapsed panel on link click and reopens the same tab after explicit close', async () => {
    fixture.width = width
    const { container, rerender } = render(<WorkspaceShell />)
    expect(panelIsOpen(container)).toBe(false)
    await clickDocument()
    await waitFor(() => expect(panelIsOpen(container)).toBe(true))
    expect(screen.getByTestId('active-path').textContent).toBe('reports/sample.docx')
    const chat = container.querySelector('main')!
    if (width < 1024) {
      const panel = screen.getByRole('complementary', { name: 'Files and content' })
      expect(panel.className).toContain('fixed inset-0')
      expect(panel.style.width).toBe('100%')
      expect(chat.getAttribute('aria-hidden')).toBe('true')
      await waitFor(() => expect(screen.getByRole('button', { name: 'Back to chat' })).toBe(document.activeElement))
    } else {
      expect(chat.getAttribute('aria-hidden')).toBe('false')
      expect(screen.queryByRole('button', { name: 'Back to chat' })).toBeNull()
    }
    expect(screen.getByTestId('tab-count').textContent).toBe('1')
    fireEvent.click(screen.getByText('Close document panel'))
    expect(panelIsOpen(container)).toBe(false)
    expect(container.querySelector('main')!.getAttribute('aria-hidden')).toBe('false')
    rerender(<WorkspaceShell />)
    expect(panelIsOpen(container)).toBe(false)
    await clickDocument()
    await waitFor(() => expect(panelIsOpen(container)).toBe(true))
    expect(screen.getByTestId('tab-count').textContent).toBe('1')
  })
})

describe('independent CRM navigation', () => {
  it.each([1440, 820, 390])('keeps canonical objects mounted when file-browser and chat readiness state changes at %spx', async width => {
    fixture.width = width
    const canonicalTree = [
      { name: 'bulk_trades', path: 'bulk_trades', type: 'object', icon: 'truck' },
      { name: 'supplier', path: 'supplier', type: 'object', defaultView: 'kanban' },
    ]
    const fetcher = vi.fn(async (_url: string) => Response.json({ tree: canonicalTree, exists: true, sessions: [], jobs: [] }))
    vi.stubGlobal('fetch', fetcher)
    watcher.tree = canonicalTree
    const view = render(<WorkspaceShell />)
    if (width < 768) fireEvent.click(screen.getByRole('button', { name: 'Open sidebar' }))
    const bulkTrades = await screen.findByRole('button', { name: 'bulk_trades' })
    expect(screen.getByRole('button', { name: 'supplier' })).toBeTruthy()
    const metadataRequests = () => fetcher.mock.calls.filter(([url]) => url.startsWith('/api/workspace/tree')).length
    const initialRequests = metadataRequests()
    try {
      watcher.tree = []
      watcher.browseDir = '/synthetic/reports'
      watcher.loading = true
      fixture.ready = false
      view.rerender(<WorkspaceShell />)
      expect(screen.getByRole('button', { name: 'bulk_trades' })).toBe(bulkTrades)
      expect(screen.queryByText('Loading navigation')).toBeNull()
      watcher.loading = false
      fixture.ready = true
      view.rerender(<WorkspaceShell />)
      await act(async () => {})
      expect(screen.getByRole('button', { name: 'bulk_trades' })).toBe(bulkTrades)
      expect(metadataRequests()).toBe(initialRequests)
    } finally {
      watcher.tree = fixture.tree
      watcher.browseDir = null
      watcher.loading = false
    }
  })
})

describe('initial composer shell', () => {
  it('does not hide an early typed draft when a different saved chat restores', async () => {
    fixture.width = 390; fixture.ready = false; watcher.activeWorkspace = null
    const saved = workspaceTabsReducer(EMPTY_TABS_STATE, { type: 'openChat', tab: createSessionChatTab({ sessionId: 'saved-session', title: 'Saved chat' }) })
    saveTabsState(saved, 'synthetic')
    const view = render(<WorkspaceShell />)
    const draft = screen.getByRole('textbox', { name: 'Draft' })
    fireEvent.change(draft, { target: { value: 'Do not hide this draft' } })
    watcher.activeWorkspace = 'synthetic'
    view.rerender(<WorkspaceShell />)
    await act(async () => {})
    expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(draft)
    expect(draft).toHaveValue('Do not hide this draft')
  })
  it('binds a newly chosen agent chat without remounting the editable draft', async () => {
    fixture.width = 390; fixture.ready = true; fixture.enabled = true
    const view = render(<WorkspaceShell />)
    const draft = screen.getByRole('textbox', { name: 'Draft' })
    fireEvent.change(draft, { target: { value: 'Draft for my chosen agent' } })
    fixture.selected = { key: conversationKey('solo', 'created', 'alpha'), title: 'Created chat' }
    fixture.lastCreatedKey = fixture.selected.key
    view.rerender(<WorkspaceShell />)
    await act(async () => {})
    expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(draft)
    expect(draft).toHaveValue('Draft for my chosen agent')
    expect(screen.getByRole('button', { name: 'Synthetic send' })).toBeEnabled()
  })
  it('preserves text typed before the workspace identity arrives', async () => {
    fixture.width = 390; fixture.ready = false
    watcher.activeWorkspace = null
    const view = render(<WorkspaceShell />)
    const draft = screen.getByRole('textbox', { name: 'Draft' })
    fireEvent.change(draft, { target: { value: 'Typed before workspace identity' } })
    watcher.activeWorkspace = 'synthetic'
    view.rerender(<WorkspaceShell />)
    expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(draft)
    expect(draft).toHaveValue('Typed before workspace identity')
  })
  it('keeps the exact deep-link editor node while native key lookup settles', async () => {
    fixture.width = 390; fixture.ready = false
    fixture.params = new URLSearchParams('chat=solo%3Aalpha%3Anative-session')
    window.history.replaceState(null, '', `/?${fixture.params}`)
    const view = render(<WorkspaceShell />)
    const draft = screen.getByRole('textbox', { name: 'Draft' })
    fireEvent.change(draft, { target: { value: 'Typed during exact native lookup' } })
    fixture.ready = true; fixture.enabled = true
    view.rerender(<WorkspaceShell />)
    await act(async () => {})
    expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(draft)
    expect(draft).toHaveValue('Typed during exact native lookup')
  })
  it.each([390, 768, 820, 1024])('keeps the same editable draft through backend identification at %spx', async width => {
    fixture.width = width; fixture.ready = false
    const view = render(<WorkspaceShell />)
    const draft = screen.getByRole('textbox', { name: 'Draft' })
    expect(draft.closest('[class="hidden"]')).toBeNull()
    expect(screen.queryByLabelText('Loading chat')).toBeNull()
    expect(screen.getByRole('button', { name: 'Synthetic send' })).toBeDisabled()
    fireEvent.change(draft, { target: { value: 'Draft before backend discovery' } })
    fixture.ready = true; fixture.enabled = true
    view.rerender(<WorkspaceShell />)
    expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(draft)
    expect(draft).toHaveValue('Draft before backend discovery')
    // Native chat has not been chosen: no legacy send and no implicit route.
    expect(screen.getByRole('button', { name: 'Synthetic send' })).toBeDisabled()
    expect(fixture.router.push.mock.calls.some(([url]) => String(url).includes('chat='))).toBe(false)
  })
})

describe('responsive pane navigation', () => {
  it.each([390, 820])('does not add a second workspace header above the artifact at %spx', async width => {
    fixture.width = width
    const { container } = render(<WorkspaceShell />)
    await clickDocument()
    await waitFor(() => expect(panelIsOpen(container)).toBe(true))
    const aside = screen.getByRole('complementary', { name: 'Files and content' })
    expect(aside.children).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Back to chat' })).toHaveLength(1)
  })

  it.each([390, 820])('uses one chat header with navigation controls at %spx', width => {
    fixture.width = width
    const { container } = render(<WorkspaceShell />)
    const toggle = screen.getByRole('button', { name: /^(Open|Close) sidebar$/ })
    const header = toggle.closest('header')
    expect(header).not.toBeNull()
    expect(container.querySelector('main')!.querySelectorAll('header')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Open files & content' }).closest('header')).toBe(header)
    expect(screen.getAllByTitle('New chat')).toHaveLength(1)
    expect(screen.getByTitle('New chat').closest('header')).toBe(header)
    expect(screen.getByRole('button', { name: 'Open terminal' }).closest('header')).toBe(header)
  })
  it.each([390, 768, 820, 1024])('preserves unsaved editor and draft nodes across return/reopen at %spx', async width => {
    fixture.width = width
    const { container } = render(<WorkspaceShell />)
    const draft = screen.getByRole('textbox', { name: 'Draft' })
    fireEvent.change(draft, { target: { value: 'Unsent chat draft' } })
    await clickDocument()
    await waitFor(() => expect(panelIsOpen(container)).toBe(true))
    const editor = screen.getByRole('textbox', { name: 'Unsaved artifact' })
    fireEvent.change(editor, { target: { value: 'Unsaved document changes' } })
    fireEvent.click(screen.getByRole('button', { name: 'Close document panel' }))
    const aside = editor.closest('aside')!
    expect(aside).toHaveAttribute('aria-hidden', 'true')
    expect(aside).toHaveAttribute('inert')
    expect(draft).toHaveValue('Unsent chat draft')
    await clickDocument()
    await waitFor(() => expect(panelIsOpen(container)).toBe(true))
    expect(screen.getByRole('textbox', { name: 'Unsaved artifact' })).toBe(editor)
    expect(editor).toHaveValue('Unsaved document changes')
    expect(screen.getByRole('textbox', { name: 'Draft', hidden: true })).toBe(draft)
  })
  it('keeps mobile sidebar, artifact and chat mutually exclusive, including keyboard switches', async () => {
    fixture.width = 390
    const { container } = render(<WorkspaceShell />)
    const chat = container.querySelector('main')!
    fireEvent.click(screen.getByRole('button', { name: 'Open sidebar' }))
    expect(screen.getByRole('navigation', { name: 'Mobile sidebar' })).toBeTruthy()
    expect(chat.getAttribute('aria-hidden')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Select document' }))
    await waitFor(() => expect(panelIsOpen(container)).toBe(true))
    expect(screen.queryByRole('navigation', { name: 'Mobile sidebar' })).toBeNull()
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
    expect(panelIsOpen(container)).toBe(false)
    expect(screen.getByRole('navigation', { name: 'Mobile sidebar' })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true, shiftKey: true })
    expect(panelIsOpen(container)).toBe(true)
    expect(screen.queryByRole('navigation', { name: 'Mobile sidebar' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Back to chat' }))
    expect(chat.getAttribute('aria-hidden')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Open sidebar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close sidebar' }))
    expect(chat.getAttribute('aria-hidden')).toBe('false')
    expect(screen.queryByRole('navigation', { name: 'Mobile sidebar' })).toBeNull()
  })

  it('returns to tablet chat with Escape and can reopen content from the header', async () => {
    fixture.width = 900
    const { container } = render(<WorkspaceShell />)
    await clickDocument()
    await waitFor(() => expect(panelIsOpen(container)).toBe(true))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(panelIsOpen(container)).toBe(false)
    expect(container.querySelector('main')!.getAttribute('aria-hidden')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Open files & content' }))
    expect(panelIsOpen(container)).toBe(true)
  })

  it('responds to viewport changes without losing tabs or desktop panel preferences', async () => {
    const { container } = render(<WorkspaceShell />)
    await clickDocument()
    await waitFor(() => expect(panelIsOpen(container)).toBe(true))
    const desktopWidth = screen.getByTestId('panel-content').closest('aside')!.style.width
    resizeViewport(900)
    expect(panelIsOpen(container)).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Open files & content' }))
    resizeViewport(390)
    expect(screen.getByRole('complementary', { name: 'Files and content' }).style.width).toBe('100%')
    expect(screen.queryByRole('navigation', { name: 'Mobile sidebar' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Back to chat' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open sidebar' }))
    resizeViewport(900)
    expect(container.querySelector('main')!.getAttribute('aria-hidden')).toBe('false')
    resizeViewport(1440)
    expect(panelIsOpen(container)).toBe(true)
    expect(screen.getByTestId('panel-content').closest('aside')!.style.width).toBe(desktopWidth)
    expect(screen.getByTestId('tab-count').textContent).toBe('1')
  })

  it.each([900, 390])('reveals content deep links at width %s without replacing the chat route', async (width) => {
    fixture.width = width
    fixture.params = new URLSearchParams('path=reports%2Fsample.docx&chat=existing-chat')
    window.history.replaceState(null, '', `/?${fixture.params}`)
    const { container } = render(<WorkspaceShell />)
    await waitFor(() => expect(panelIsOpen(container)).toBe(true))
    expect(screen.getByTestId('active-path').textContent).toBe('reports/sample.docx')
    fireEvent.click(screen.getByRole('button', { name: 'Back to chat' }))
    expect(container.querySelector('main')!.getAttribute('aria-hidden')).toBe('false')
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true, shiftKey: true })
    expect(screen.getByTestId('tab-count').textContent).toBe('1')
  })
})
