import { expect, it } from 'vitest'
import { routeSlashResult, slashSection, slashVisible } from './slash-commands'

it('routes command directives without putting command output into the transcript', () => {
  for (const type of ['send', 'skill']) {expect(routeSlashResult({ type, message: 'expanded prompt' })).toEqual({ type: 'send', text: 'expanded prompt', notice: undefined })}
  expect(routeSlashResult({ type: 'alias', target: 'target prompt' })).toEqual({ type: 'send', text: 'target prompt', notice: undefined })
  expect(routeSlashResult({ type: 'prefill', message: '<edit me>', notice: 'Restored' })).toEqual({ type: 'prefill', text: '<edit me>', notice: 'Restored' })
  for (const type of [undefined, 'exec', 'plugin']) {expect(routeSlashResult({ type, output: 'status', warning: 'warning' })).toEqual({ type: 'output', text: 'status\n\nwarning' })}
  const conversation = { key: 'solo:test' }
  expect(routeSlashResult({ conversation })).toEqual({ type: 'conversation', conversation })
  expect(() => routeSlashResult({ type: 'skill' })).toThrow('empty message')
  expect(slashVisible('/quit')).toBe(false)
  expect(slashVisible('/model')).toBe(true)
  expect(slashSection({ text: '/docx', display: '/docx', meta: '', kind: 'skill' }, {})).toBe('Skills')
  expect(slashSection({ text: '/custom', display: '/custom', meta: '' }, { categories: [{ name: 'Plugins', pairs: [['/custom', 'custom command']] }] })).toBe('Plugins')
})
