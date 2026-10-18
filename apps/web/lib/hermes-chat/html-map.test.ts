import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { mapMessageHtml, messageTextHash, type MessageHtmlRow } from './html-map'
import type { SourcedMessage } from './snapshot'
const user = (id: string, text: string, clientIds?: string[]): SourcedMessage => ({ id, role: 'user', source: 'durable', clientIds, startedAt: 0, pending: false, segments: [{ id: `${id}:text`, type: 'text', text, startedAt: 0 }] })
const html = (id: string, text: string, created_at?: string): MessageHtmlRow => ({ client_message_id: id, text_hash: messageTextHash(text), html: `<b>${id}</b>`, created_at })

describe('CRM mention HTML identity', () => {
  it('uses browser-safe normalized UTF-8 SHA256 compatible with the server store', () => {
    for (const text of ['', 'abc', 'many\n  spaces', '🔋 café', 'a'.repeat(200)]) {
      expect(messageTextHash(text)).toBe(createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex'))
    }
  })
  it('maps repeated texts in chronological order with interleaved different prompts', () => {
    const result = mapMessageHtml([user('1', 'same'), user('2', 'other'), user('3', 'same')], [html('a', 'same'), html('b', 'other'), html('c', 'same')])
    expect([...result].sort()).toEqual([['1', '<b>a</b>'], ['2', '<b>b</b>'], ['3', '<b>c</b>']])
  })
  it('falls back to plain text for queue merges and unresolved duplicate counts', () => {
    expect(mapMessageHtml([user('1', 'first\n\nsecond')], [html('a', 'first'), html('b', 'second')]).size).toBe(0)
    expect(mapMessageHtml([user('1', 'same'), user('2', 'same')], [html('a', 'same')]).size).toBe(0)
    expect(mapMessageHtml([user('1', 'same')], [html('a', 'same'), html('b', 'same')]).size).toBe(0)
  })
  it('does not guess when duplicate chronology is ambiguous or known client identities disagree', () => {
    expect(mapMessageHtml([user('1', 'same'), user('2', 'same')], [html('a', 'same', 'now'), html('b', 'same', 'now')]).size).toBe(0)
    expect(mapMessageHtml([user('1', 'same', ['a', 'b'])], [html('a', 'same')]).size).toBe(0)
    expect(mapMessageHtml([user('1', 'same', ['wrong'])], [html('a', 'same')]).size).toBe(0)
    expect(mapMessageHtml([user('1', 'first'), user('2', 'second')], [html('b', 'second'), html('a', 'first')]).size).toBe(0)
  })
})
