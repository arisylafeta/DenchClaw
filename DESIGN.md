# DenchClaw interface contract

## Chat sidebar

The sidebar helps Ari and Alex find the right conversation without mixing direct chats with background work. Match the existing CRM shell, avatars and compact neutral styling rather than introducing a new theme.

- Reuse `--color-bg`, `--color-text`, `--color-text-muted`, `--color-border` and `--color-surface-hover`. Status colors retain the existing green working, amber attention and blue unread meanings.
- Use the existing system typography. Conversation names are the primary text; timestamps are smaller quiet secondary text. Use smaller agent avatars instead of repeating agent names in subtitles; keep participant names accessible through avatar labels and tooltips. Avoid repeated source labels when a section already supplies them.
- Use compact rows, restrained rounded corners and no card shadows or decorative gradients. Selected rows use a quiet surface fill, with visible keyboard focus.
- Chats is the first and default sidebar view on a fresh entry. Restore a user's explicit sidebar view choice independently; never rewrite content tabs, deep links or file-scoped chat routes to make Chats primary.
- Present collapsible Pinned, Chats, Groups, Discord, WhatsApp and Automation sections. Show other messaging sources only when present. Automation is closed and hidden from ordinary conversation history by default.
- Pinned conversations appear once, at the top, and return to their original section when unpinned. Hover or focus on the row's icon reveals pin/unpin, without selecting the chat. Offer an accessible touch action on mobile.
- Most recent and Project sort rows inside the existing sections, including Pinned; keep source grouping and filtering independent. Project uses only explicit session metadata, displays a safe leaf label rather than a path, and puts unknown projects last as `No project`. Persist the choice locally.
- Only confirmed running rows receive a restrained green flowing border. Awaiting input takes precedence; idle, unread and unknown status never animate. Reduced motion uses a static border.
- The chat-filter popup is opaque and compact, with a quiet selected fill and visible keyboard focus. Scope these styles to this popup, not the shared menu primitive. Hidden sources stay toggleable in the popup without a separate hidden-notice line.
- Display stored Discord server/channel names and WhatsApp contact/group names without rewriting session titles. Missing metadata uses the existing title. Preserve user renames with a local display override if required; never infer identity from message content.
- Keep filtering independent of routing. Source and agent filters must never change a selected conversation's exact profile/id key.
- Search, collapse state, pins and filters remain usable with unavailable browser storage. Persist view preferences in this browser, not shared agent state.
- The sidebar must fit a 280px mobile drawer at a 390px viewport and remain balanced at 1440px. No horizontal overflow; long names truncate with a full accessible label.
- Use real buttons for section toggles and pin actions, `aria-expanded` for collapse, labelled icons and visible focus. Respect reduced motion and keep text contrast at least 4.5:1.
- Verify default, pinned, collapsed, filtered, loading, empty, error and recovery states using synthetic data only. Never browser-test production CRM data or send provider messages.

Reference: the existing DenchClaw conversation rows and mobile drawer; Hermes Desktop's source/platform sections and independent profile filter. DenchClaw currently has one configured backend, so do not invent additional remote gateway connections.

## Responsive workspace panes

- At 1024px and wider, preserve the resizable sidebar, chat and content columns and their saved desktop preferences.
- From 768px through 1023px, content opens full-screen instead of squeezing beside chat. Back to chat, Escape or the content close control returns to chat; the chat header can reopen content.
- Below 768px, show only one of sidebar, chat or content. Opening sidebar or content replaces the other; closing either returns to chat. Keep content tabs and chat/file deep links independent of pane visibility.
- Reuse the `useIsMobile` matchMedia hook for both breakpoints. Full-screen pane switches do not animate, use labelled keyboard-focusable buttons, and hide underlying panes from keyboard and assistive technology.

## Mobile composer and PWA foundation

- Keep a single real, editable composer mounted during discovery and history loading. Gate sends and commands, not typing; retain the draft through saved-tab restoration and explicit agent selection.
- Normal chat reserves at least three visible text lines inside the editable content at every width, including compact chat chrome. Include vertical padding in the minimum; phone input retains its stronger 96px floor and 16px text. Compact popover editors stay compact. Keep chat in normal flex flow above the keyboard and bottom safe area.
- Clarification matches ReBattery Jules' `joules-prompt-stack.tsx` and `joules-composer.tsx`: questions and numbered choices above a compact, borderless answer row with an adjacent send arrow, all inside the existing single composer surface. No visible Other heading, large answer textarea or separate Submit answer row. Single choices advance immediately; multi-select uses checkboxes and Continue. Preserve Hermes request/qid identity, locked answers and Skip, rather than sending ordinary prompts. Keep the normal draft and attachments mounted but hidden while answering.
- Size narrow workspace shells to the visual viewport without interpreting pinch zoom as a keyboard resize. Retain browser zoom.
- Native drafts without a chosen agent show an explicit agent-choice action, not an endless loading skeleton or an implicit send to an arbitrary profile.
- PWA metadata and public icons support standalone installation. Do not cache private chats, documents, API responses or authenticated HTML; this phase adds no service worker, offline queue or push prompt.

## Native Hermes command composer

- Show provider-exposed reasoning as streaming 12px muted plain text in the existing work trace. Preserve line breaks and wrap long tokens without clipping; keep tools distinct. Auto-collapse completed work to its duration summary unless manually toggled, and retain non-empty reasoning after reload regardless of duration. Never substitute status text or fabricate reasoning when none is supplied.
- Keep public assistant prose fully visible in chronological order when tools continue. Group only contiguous tools and explicit reasoning into work disclosures, never demote an already-visible response to a clipped trace label.

- Limit model-picker choices to Anthropic, OpenAI (including its Codex route) and OpenCode. Keep route identifiers intact and never silently change the active session or configured credentials when filtering choices.
- Match the native model picker: borderless `@base-ui/react` popover above the composer, rounded neutral surface, compact system type, muted descriptions and a quiet hover/keyboard selection fill.
- The composer itself is the slash search field; do not add a second search input. Show Session, Model, Tools, Skills and Plugins sections from Hermes metadata, with collapsible headings and one-line descriptions. Keep skills separate and hide terminal-only commands.
- Keep focus in the composer while Arrow keys select, Tab completes, Enter runs and Escape dismisses. Argument completions replace only Hermes' indicated suffix.
- Command results use the transcript's existing muted, icon-led notice line, not a box above the composer or a chat bubble. Show the command and a clipped summary; reveal full multiline output on demand. Errors use the error tone. Queued rewrite commands use the same row with Cancel, then update to the result or cancelled state. Preserve completed notices through history resync for the mounted conversation.
- Fit a 390px viewport without horizontal overflow; preserve visible focus, readable descriptions and approximately 44px command-row targets.

## Narrow artifact and sidebar navigation

- Render one chat header at every width. Put narrow sidebar, Files, terminal and new-chat controls in the existing ChatPanel header slots, never a second workspace bar above it; retain subagent return and conversation actions.
- Before matchMedia hydration, CSS must hide desktop sidebar chrome below 768px. The initial chat uses the actual editable composer, not an input-shaped skeleton.
- Keep artifact editor/cache owners mounted when returning to chat. Hide and inert inactive panes; navigation visibility must not discard drafts or dirty editor state.
- Below 1024px, Files and the artifact use the full content width separately. Keep the chat-return toggle inside the existing file-search or artifact-tab toolbar, never a second workspace header. Keep safe-area padding and do not float controls over documents.
- The sidebar uses the existing outlined panel toggle icon with an expanded state, never Back. Back to chat is reserved for artifact return.
- Touch conversation rows retain avatars and separate visible 44px pin/rename actions. Only selection receives the selected fill. Avatar-to-pin overlays and row hover fill require both hover capability and a fine pointer; keyboard feedback uses focus-visible.
- Content tabs scroll horizontally inside their bounded strip, expose full accessible titles and labelled close controls, and use 44px targets in narrow panes. Preserve desktop sizing and saved layout preferences.
