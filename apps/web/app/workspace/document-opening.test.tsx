// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { RightPanelContent } from '../components/workspace/right-panel-content'

const fixture = vi.hoisted(() => ({
  width: 1440,
  params: new URLSearchParams(),
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
  activeWorkspace: 'synthetic', browseDir: null, parentDir: null,
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
  useHermesConversations: () => ({ enabled: false, ready: true }),
  HermesConversationList: () => null, HermesConversationPanel: () => null,
  HermesNewChatDialog: () => null,
}))
vi.mock('../components/workspace/toast', () => ({ ToastProvider: ({ children }: { children: React.ReactNode }) => children }))
vi.mock('../components/chat-panel', () => ({
  ChatPanel: ({ headerLeftSlot, headerRightSlot }: { headerLeftSlot?: React.ReactNode; headerRightSlot?: React.ReactNode }) => <>{headerLeftSlot}{headerRightSlot}<a href="/?path=reports%2Fsample.docx">Open generated document</a></>,
}))
// Keep the real shell, URL/link handlers, resolver, reducer and panel containers.
// Editors/data views are unrelated to visibility; expose their received tab identity
// and close control so assertions observe the actual desktop width/mobile drawer.
vi.mock('../components/workspace/right-panel-content', () => ({
  RightPanelContent: (props: ComponentProps<typeof RightPanelContent>) => <section data-testid="panel-content">
    <span data-testid="active-path">{props.activeContentTab?.path}</span>
    <span data-testid="tab-count">{props.tabsState.contentTabs.length}</span>
    <button onClick={() => props.onSetRightPanelCollapsed(true)}>Close document panel</button>
  </section>,
}))
vi.mock('../components/workspace/workspace-sidebar', () => ({
  WorkspaceSidebar: ({ mobile, onClose, onSelect }: { mobile?: boolean; onClose?: () => void; onSelect: (node: typeof fixture.tree[number]) => void }) => <nav aria-label={mobile ? 'Mobile sidebar' : 'Desktop sidebar'}>
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
  '../components/bulk-trades/bulk-trades-view', '../components/dismantlers/dismantlers-view',
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
  if (fixture.width < 1024) return container.querySelector('aside[aria-label="Files and content"]') !== null
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
      expect(screen.getByRole('button', { name: 'Back to chat' })).toBe(document.activeElement)
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

describe('responsive pane navigation', () => {
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
