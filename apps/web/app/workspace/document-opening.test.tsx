// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { RightPanelContent } from '../components/workspace/right-panel-content'

const fixture = vi.hoisted(() => ({
  mobile: false,
  params: new URLSearchParams(),
  router: { push: vi.fn(), replace: vi.fn() },
  tree: [{ path: 'reports/sample.docx', name: 'sample.docx', type: 'file' }],
}))
const noop = () => {}
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
vi.mock('../hooks/use-mobile', () => ({ useIsMobile: () => fixture.mobile }))
vi.mock('../hooks/use-workspace-watcher', () => ({ useWorkspaceWatcher: () => watcher }))
vi.mock('@/lib/search-index', () => ({ useSearchIndex: () => ({ search: noop }) }))
vi.mock('../components/workspace/hermes-conversations', () => ({
  useHermesConversations: () => ({ enabled: false, ready: true }),
  HermesConversationList: () => null, HermesConversationPanel: () => null,
  HermesNewChatDialog: () => null,
}))
vi.mock('../components/workspace/toast', () => ({ ToastProvider: ({ children }: { children: React.ReactNode }) => children }))
vi.mock('../components/chat-panel', () => ({
  ChatPanel: () => <a href="/?path=reports%2Fsample.docx">Open generated document</a>,
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
for (const path of [
  '../components/workspace/workspace-sidebar', '../components/workspace/file-manager-tree',
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
  fixture.mobile = false
  fixture.params = new URLSearchParams()
  fixture.router.push.mockClear()
  fixture.router.replace.mockClear()
  localStorage.clear()
  localStorage.setItem('dench-workspace-right-panel-collapsed', '1')
  window.history.replaceState(null, '', '/')
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('min-width') ? !fixture.mobile : fixture.mobile, addEventListener: noop, removeEventListener: noop }))
  // All ancillary shell requests are synthetic; no server or provider is used.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ sessions: [], jobs: [] }) })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function panelIsOpen(container: HTMLElement) {
  if (fixture.mobile) return container.querySelector('.drawer-right') !== null
  const panel = screen.getByTestId('panel-content').closest('aside')!
  return parseFloat(panel.style.width) > 0
}

async function clickDocument() {
  expect(fireEvent.click(await screen.findByText('Open generated document'))).toBe(false)
}

// jsdom does not lay out CSS, so assert the real shell's rendered width/drawer,
// not toBeVisible (which considers zero-width clipped panels visible).
describe.each([false, true])('document opening (mobile=%s)', (mobile) => {
  it('reveals a collapsed panel on link click and reopens the same tab after explicit close', async () => {
    fixture.mobile = mobile
    const { container, rerender } = render(<WorkspaceShell />)
    expect(panelIsOpen(container)).toBe(false)
    await clickDocument()
    await waitFor(() => expect(panelIsOpen(container)).toBe(true))
    expect(screen.getByTestId('active-path').textContent).toBe('reports/sample.docx')
    expect(screen.getByTestId('tab-count').textContent).toBe('1')
    fireEvent.click(screen.getByText('Close document panel'))
    expect(panelIsOpen(container)).toBe(false)
    rerender(<WorkspaceShell />)
    expect(panelIsOpen(container)).toBe(false)
    await clickDocument()
    await waitFor(() => expect(panelIsOpen(container)).toBe(true))
    expect(screen.getByTestId('tab-count').textContent).toBe('1')
  })
})
