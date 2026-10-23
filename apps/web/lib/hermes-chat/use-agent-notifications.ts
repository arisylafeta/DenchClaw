'use client'
import { useEffect, useRef } from 'react'
import { appIsBackgrounded, showAgentNotification } from '../agent-notify'
import { bundledProfileAvatar } from '../profile-avatars'
import { messageText } from './reducer'
import type { ChatMessage } from './reducer'

interface Options {
  /** This chat's own turn is running. */
  active: boolean
  messages: ChatMessage[]
  conversationKey?: string
  title?: string
  /** Solo agent profile; its avatar becomes the notification icon. */
  profile?: string | null
}

const clip = (text: string, max = 140) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Notify when a backgrounded app gets its first response text, and when the agent finishes. */
export function useAgentNotifications({ active, messages, conversationKey, title, profile }: Options) {
  const wasActive = useRef(false)
  const announcedStart = useRef(false)
  const latest = useRef({ messages, conversationKey, title, profile })
  latest.current = { messages, conversationKey, title, profile }

  const lastAssistantText = () => {
    for (let i = latest.current.messages.length - 1; i >= 0; i--) {
      const m = latest.current.messages[i]
      if (m.role === 'user') return ''
      if (m.role === 'assistant') { const t = messageText(m).trim(); if (t) return t }
    }
    return ''
  }
  const notify = (kind: 'start' | 'done', body: string) => {
    const { conversationKey: key, title: t, profile: p } = latest.current
    const icon = (p && bundledProfileAvatar(p)) || (p ? `/api/workspace/avatar?name=${encodeURIComponent(p)}` : undefined)
    void showAgentNotification({
      kind,
      title: t || (p ? p : 'ReBattery CRM'),
      body,
      icon,
      tag: `agent-${key ?? 'chat'}`,
      url: '/',
    })
  }

  useEffect(() => {
    if (active && !wasActive.current) announcedStart.current = false
    if (!active && wasActive.current) {
      if (appIsBackgrounded()) notify('done', clip(lastAssistantText()) || 'Finished')
      announcedStart.current = false
    }
    wasActive.current = active
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  useEffect(() => {
    if (!active || announcedStart.current) return
    const text = lastAssistantText()
    if (!text) return
    announcedStart.current = true
    if (appIsBackgrounded()) notify('start', `Started: ${clip(text, 110)}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, messages])
}
