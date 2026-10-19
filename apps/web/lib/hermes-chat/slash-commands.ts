import type { HermesConversation } from '../hermes-conversations'

export interface SlashItem { text: string; display: string; meta: string; kind?: string }
export interface SlashCatalog {
  categories?: { name: string; pairs: [string, string][] }[]
  commands?: Record<string, { category?: string; desktop?: string; argument_mode?: string }>
  warning?: string
}
export interface SlashCompletion { items: SlashItem[]; replace_from: number; catalog: SlashCatalog }

// Desktop's unavailable commands have no meaningful web composer surface.
// /model and /fast are deliberately offered here alongside their native controls.
const hidden: Record<string, true> = Object.fromEntries(['quit', 'exit', 'clear', 'paste', 'busy', 'config', 'copy', 'cron', 'footer', 'gateway', 'history', 'image', 'indicator', 'platforms', 'plugins', 'redraw', 'reload', 'restart', 'sb', 'set-home', 'sethome', 'snap', 'snapshot', 'statusbar', 'toolsets', 'update', 'verbose', 'density', 'details', 'logs', 'mouse', 'approve', 'deny', 'voice', 'pets', 'login', 'curator', 'insights', 'kanban', 'reload-mcp', 'reload-skills', 'reload_mcp', 'reload_skills'].map(name => [name, true as const]))
export function slashName(text: string): string { return text.trim().replace(/^\/+/, '').split(/\s+/, 1)[0].toLowerCase() }
export function slashVisible(text: string, catalog?: SlashCatalog): boolean {
  const name = slashName(text)
  const desktop = catalog?.commands?.[`/${name}`]?.desktop ?? catalog?.commands?.[name]?.desktop
  return !hidden[name] && !['terminal', 'messaging', 'composer-voice', 'settings'].includes(desktop ?? '') && (desktop !== 'advanced' || name === 'fast')
}
export function slashSection(item: SlashItem, catalog: SlashCatalog): string {
  if (item.kind === 'skill') {return 'Skills'}
  const name = slashName(item.text)
  const category = catalog.categories?.find(section => section.pairs.some(([command]) => slashName(command) === name))?.name
    ?? catalog.commands?.[`/${name}`]?.category ?? catalog.commands?.[name]?.category ?? ''
  if (/skill/i.test(category)) {return 'Skills'}
  if (/plugin|quick|custom/i.test(category)) {return 'Plugins'}
  if (/model|config|provider/i.test(category) || ['model', 'fast', 'reasoning'].includes(name)) {return 'Model'}
  if (/session|conversation/i.test(category) || ['new', 'branch', 'invite', 'title', 'goal', 'compress', 'compact', 'undo', 'retry'].includes(name)) {return 'Session'}
  return 'Tools'
}
export type SlashAction = { type: 'send' | 'prefill'; text: string; notice?: string } | { type: 'output'; text: string } | { type: 'conversation'; conversation: HermesConversation }
export function routeSlashResult(result: Record<string, unknown>): SlashAction {
  if (result.conversation && typeof result.conversation === 'object') {return { type: 'conversation', conversation: result.conversation as HermesConversation }}
  const notice = typeof result.notice === 'string' ? result.notice : undefined
  if (result.type === 'send' || result.type === 'skill' || result.type === 'alias' || result.type === 'prefill') {
    const text = result.type === 'alias' ? result.target : result.message
    if (typeof text !== 'string' || !text.trim()) {throw new Error('Command returned an empty message')}
    return { type: result.type === 'prefill' ? 'prefill' : 'send', text, notice }
  }
  if (typeof result.output === 'string') {return { type: 'output', text: [result.output, result.warning].filter(value => typeof value === 'string' && value).join('\n\n') }}
  throw new Error('Command returned an unsupported result')
}

/** Commands that rewrite the transcript; Hermes refuses them while a reply is streaming. */
export function slashNeedsIdleSession(command: string): boolean { return ['compress', 'compact', 'undo', 'retry'].includes(slashName(command)) }
/** Hermes' own refusal text for a command sent mid-reply. */
export function isBusyRefusal(output: string): boolean { return /^\s*session busy\b/i.test(output) }
