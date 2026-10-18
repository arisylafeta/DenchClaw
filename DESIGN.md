# DenchClaw interface contract

## Chat sidebar

The sidebar helps Ari and Alex find the right conversation without mixing direct chats with background work. Match the existing CRM shell, avatars and compact neutral styling rather than introducing a new theme.

- Reuse `--color-bg`, `--color-text`, `--color-text-muted`, `--color-border` and `--color-surface-hover`. Status colors retain the existing green working, amber attention and blue unread meanings.
- Use the existing system typography. Conversation names are the primary text; time and agent are quiet secondary text. Avoid repeated source labels when a section already supplies them.
- Use compact rows, restrained rounded corners and no card shadows or decorative gradients. Selected rows use a quiet surface fill, with visible keyboard focus.
- Chats is the first and default sidebar view on a fresh entry. Restore a user's explicit sidebar view choice independently; never rewrite content tabs, deep links or file-scoped chat routes to make Chats primary.
- Present collapsible Pinned, Chats, Groups, Discord, WhatsApp and Automation sections. Show other messaging sources only when present. Automation is closed and hidden from ordinary conversation history by default.
- Pinned conversations appear once, at the top, and return to their original section when unpinned. Hover or focus on the row's icon reveals pin/unpin, without selecting the chat. Offer an accessible touch action on mobile.
- Display stored Discord server/channel names and WhatsApp contact/group names without rewriting session titles. Missing metadata uses the existing title. Preserve user renames with a local display override if required; never infer identity from message content.
- Keep filtering independent of routing. Source and agent filters must never change a selected conversation's exact profile/id key.
- Search, collapse state, pins and filters remain usable with unavailable browser storage. Persist view preferences in this browser, not shared agent state.
- The sidebar must fit a 280px mobile drawer at a 390px viewport and remain balanced at 1440px. No horizontal overflow; long names truncate with a full accessible label.
- Use real buttons for section toggles and pin actions, `aria-expanded` for collapse, labelled icons and visible focus. Respect reduced motion and keep text contrast at least 4.5:1.
- Verify default, pinned, collapsed, filtered, loading, empty, error and recovery states using synthetic data only. Never browser-test production CRM data or send provider messages.

Reference: the existing DenchClaw conversation rows and mobile drawer; Hermes Desktop's source/platform sections and independent profile filter. DenchClaw currently has one configured backend, so do not invent additional remote gateway connections.
