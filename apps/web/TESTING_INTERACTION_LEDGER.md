# Web Interaction Ledger

This ledger maps every high-value user interaction to concrete automated tests.
Rows are written as behavior invariants (what must stay true), not implementation
details (how it is coded).

## Coverage Principles

- Prefer threat/invariant tests over shape/snapshot tests.
- Cover interaction boundaries where regressions are expensive:
  - stream/event handling,
  - run lifecycle transitions,
  - workspace/object state synchronization,
  - destructive file operations and path safety.
- Keep tests deterministic: avoid network dependencies, isolate state per test.

## Interaction Matrix

| Area | Interaction | Invariant Protected | Test Owner / File |
| --- | --- | --- | --- |
| Chat stream parsing | `user-message` boundary in SSE stream | New user turn always resets streaming accumulators and starts a clean message segment | `app/components/chat-panel.stream-parser.test.ts` (new) |
| Chat stream parsing | Reasoning start/delta/end events | Reasoning text is contiguous and reasoning state is closed on end | `app/components/chat-panel.stream-parser.test.ts` (new) |
| Chat stream parsing | Tool input/output/error events | Tool call state transitions are monotonic (`input -> output|error`) per `toolCallId` | `app/components/chat-panel.stream-parser.test.ts` (new) |
| Chat stream parsing | Partial/unknown events | Parser ignores unrecognized events without corrupting prior parsed parts | `app/components/chat-panel.stream-parser.test.ts` (new) |
| Chat runtime | Initial send, queue, and stop behavior | A running session cannot start overlapping runs; queued messages are preserved until resumed | `lib/active-runs.test.ts` (existing) + `app/api/chat/chat.test.ts` (existing) |
| Chat runtime | Stream replay after reconnect | Replay emits buffered events in order and does not duplicate already-seen global sequence events | `lib/active-runs.test.ts` (existing) |
| Chat runtime | Silent token filtering | `NO_REPLY` full and partial token leaks never appear in final text | `lib/active-runs.test.ts` (existing, add cases) |
| Chat message rendering | Tool and report block grouping | Mixed tool/report/diff parts render in stable groups without dropping order | `app/components/chat-message.test.tsx` (new) |
| Chat message rendering | Tool status badges | Tool states reflect terminal result (`success` vs `error`) consistently | `app/components/chat-message.test.tsx` (new) |
| Chat question cards | `dench-question` block rendering and answer submit | Structured MCQ blocks render as accessible choices, hide raw JSON, and submit selected answers as normal user turns | `lib/question-blocks.test.ts` (new) + `app/components/chat-message.test.tsx` (new) |
| Subagent lifecycle | Registration + independent stream | Subagents continue streaming independently of parent run closure | `lib/subagent-runs.test.ts` (existing) + `lib/active-runs.test.ts` (existing) |
| Subagent lifecycle | Follow-up messaging | User follow-up persists before spawn and stream resumes from same subagent session key | `lib/subagent-runs.test.ts` (existing, add cases) |
| Subagent lifecycle | Abort from panel | Abort transitions run to non-running immediately and unblocks next action | `lib/subagent-runs.test.ts` (existing, add cases) |
| Workspace tree | Browse/fetch races | Stale fetch responses do not overwrite newer tree state | `app/hooks/use-workspace-watcher.test.ts` (new) |
| Workspace tree | Context actions (rename/delete/mkdir) | File operations reject traversal/system-file violations and apply only under workspace root | `app/api/workspace/file-ops.test.ts` (existing) |
| Workspace tree | Search/filter in sidebar | Search result selection opens the exact target and does not mutate unrelated open branches | `app/components/workspace/workspace-sidebar.test.tsx` (new) |
| Workspace routing | URL-driven state (`path`, `entry`, `chat`, `send`) | Query params hydrate expected panel state exactly once per route change | `app/workspace/page.url-state.test.tsx` (new) |
| Object views | Active view from `.object.yaml` on first load | Active view display and actual table filter/query state are consistent on initial render | `app/workspace/page.object-view-sync.test.tsx` (new) |
| Object views | Active view refresh via SSE update | When server updates active view, table/filter/column state atomically follows server value | `app/workspace/page.object-view-sync.test.tsx` (new) |
| Object views | Manual load/save/toggle view | Loading/saving/toggling views never desynchronizes selected view label from filters | `app/workspace/page.object-view-sync.test.tsx` (new) |
| Object table | Pagination, search, sort boundaries | Pagination/search/sort query composition is stable and server page resets when required | `app/workspace/page.object-view-sync.test.tsx` (new) + `app/api/workspace/objects.test.ts` (existing) |
| Reports | Multi-panel execution | Partial panel failures are isolated; successful panels still render | `app/components/charts/report-viewer.test.tsx` (new) |
| Profile lockdown | Single profile UX and API lock | Web profile switch/init surfaces remain immutable (403) and UI does not expose forbidden actions | `app/api/profiles/route.test.ts` (existing), `app/api/workspace/init/route.test.ts` (existing) |

## Completion Criteria

- Every row above has either an existing passing test or a new passing test in
  the mapped file.
- High-risk rows (chat stream, subagent lifecycle, object view sync) include at
  least one failure-mode regression test.
- Added tests are deterministic and repeatable in CI and local runs.
