// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { HermesChatsController } from '../components/workspace/hermes-conversations'
import type { ChatTabRuntimeSnapshot } from '@/lib/chat-session-registry'

// Isolate the workspace's actual list boundary from unrelated editors and panels.
// HermesConversationList and its authoritative server-list status rendering remain real.
for (const path of [
  '../components/workspace/workspace-sidebar', '../components/workspace/file-manager-tree',
  '../hooks/use-workspace-watcher', '../components/workspace/right-panel-content',
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
  '../components/charts/report-viewer', '../components/crm/inbox-view',
  '../components/crm/calendar-view', '../components/crm/person-profile',
  '../components/crm/company-profile', '../components/chat-panel',
  '../components/workspace/entry-detail-panel',
  '../components/dismantlers/dismantlers-view', '../components/marketplace-pulse/marketplace-pulse-view',
  '../components/campaigns/campaigns-view', '../components/leaderboard/leaderboard-view',
  '../components/cron/cron-dashboard', '../components/skill-store/skill-store-panel',
  '../components/settings/cloud-settings-panel', '../components/cron/cron-job-detail',
  '../components/cron/cron-session-view', '../hooks/use-mobile',
  '../components/workspace/object-filter-bar', '../components/workspace/toast',
  '../components/workspace/chat-sessions-sidebar', '../components/workspace/group-chat',
  '../components/workspace/right-panel', '@/lib/search-index',
]) vi.doMock(path, () => ({}))
vi.mock('next/dynamic', () => ({ default: () => () => null }))

afterEach(cleanup)
it('ignores stale hidden-panel runtime flags and follows server running/awaiting state through workspace-content', async () => {
  // Module-loading boundary: the runtime vi.doMock registrations above must precede this import.
  const { WorkspaceHermesConversationList } = await import('./workspace-content')
  const row = { access: { visibility: 'private', ownerId: 'user', canShare: true, canDelete: true, canWrite: true, canApprove: false }, key: 'solo:p:stored', id: 'stored', profile: 'p', kind: 'solo', title: 'Hidden chat', source: 'crm', working: false, blocked: false, updatedAt: 100, participants: [{ profile: 'p', name: 'P' }] }
  const chats = { userId: 'user', accountId: 'user', listing: { userId: 'user', sessions: [row], profiles: ['p'], backend: 'hermes', warnings: [], groupsAvailable: false }, filter: null, selected: null, seen: { [row.key]: 100 }, select: vi.fn() } as unknown as HermesChatsController
  const snapshots = { hidden: { tabId: 'hidden', sessionId: row.key, isStreaming: true, awaiting: true } } as unknown as Record<string, ChatTabRuntimeSnapshot>
  const view = render(<WorkspaceHermesConversationList chats={chats} snapshots={snapshots} visibleTabId="other" />)
  expect(screen.queryByRole('img', { name: 'Running' })).toBeNull()
  expect(screen.queryByRole('img', { name: 'Needs your attention' })).toBeNull()
  row.working = true
  view.rerender(<WorkspaceHermesConversationList chats={chats} snapshots={snapshots} visibleTabId="other" />)
  expect(screen.getByRole('img', { name: 'Running' })).toBeTruthy()
  row.blocked = true
  view.rerender(<WorkspaceHermesConversationList chats={chats} snapshots={snapshots} visibleTabId="other" />)
  expect(screen.getByRole('img', { name: 'Needs your attention' })).toBeTruthy()
  row.working = false; row.blocked = false
  view.rerender(<WorkspaceHermesConversationList chats={chats} snapshots={snapshots} visibleTabId="hidden" />)
  expect(screen.getByRole('img', { name: 'Needs your attention' })).toBeTruthy()
})
