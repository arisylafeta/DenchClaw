'use client'
import { useEffect, useRef } from 'react'
import { appIsBackgrounded, showAgentNotification } from '../agent-notify'
import { bundledProfileAvatar } from '../profile-avatars'
import type { HermesConversation } from '../hermes-conversations'

type Seen = { working: boolean; blocked: boolean }

/**
 * Notify for every listed chat that finishes or starts waiting for input, including chats whose
 * tab is hidden (their own panel is unsubscribed). The listing refresh is the signal, so a chat
 * you are looking at in a focused window stays quiet.
 */
export function useConversationNotifications(rows: HermesConversation[] | undefined, selectedKey: string | undefined) {
  const previous = useRef<Map<string, Seen> | null>(null)
  useEffect(() => {
    if (!rows) return
    const next = new Map<string, Seen>()
    const before = previous.current
    for (const row of rows) {
      const now: Seen = { working: row.working === true, blocked: row.blocked === true }
      next.set(row.key, now)
      const was = before?.get(row.key)
      if (!was || row.source === 'cron') continue
      if (selectedKey === row.key && !appIsBackgrounded()) continue
      const kind = !was.blocked && now.blocked ? 'input' : was.working && !now.working && !now.blocked && row.working === false ? 'done' : null
      if (!kind) continue
      const profile = row.profile ?? row.participants[0]?.profile
      void showAgentNotification({
        kind,
        title: row.title || profile || 'ReBattery CRM',
        body: kind === 'input' ? 'Waiting for your input' : 'Finished',
        icon: (profile && bundledProfileAvatar(profile)) || (profile ? `/api/workspace/avatar?name=${encodeURIComponent(profile)}` : undefined),
        tag: `agent-${row.key}`,
        url: '/',
      })
    }
    previous.current = next
  }, [rows, selectedKey])
}
