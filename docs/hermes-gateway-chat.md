# Hermes gateway chat transport

Native Hermes solo chats can run over the Hermes gateway WebSocket (`/api/ws`, JSON-RPC) instead of the REST session SSE. Group chats already use the same gateway socket and are unchanged.

## Switch

`HERMES_CHAT_TRANSPORT=gateway|sse` (server environment, default `sse`). The server enforces it in both directions: with `gateway`, native solo sends on `/api/chat` and `/api/gateway/chat` return 409 `gateway_transport`; with `sse`, gateway submit/steer/interrupt commands return 409 `sse_transport`. The conversation list returns `transport` so the browser follows the server. Roll back by setting `sse` and restarting; Hermes data is untouched.

Required for `gateway`: `HERMES_GATEWAY_WS_URL`, and either `HERMES_GATEWAY_TOKEN` or `HERMES_GATEWAY_USERNAME` + `HERMES_GATEWAY_PASSWORD_FILE` (dashboard basic auth). Rotating the dashboard password breaks gateway chats and groups until the password file is updated.

Database: apply `apps/web/lib/crm-postgres/migrations/049_hermes_message_html.sql` (additive `hermes_message_html` table for mention-pill HTML) before enabling `gateway`. Take a database backup first.

## Behaviour

- One server-held authenticated gateway socket per Node process (`lib/hermes-gateway/manager.ts`). Browsers get one multiplexed SSE per tab: `GET /api/hermes/events?keys=...`, plus `POST /api/hermes/events/subscriptions`. Unsubscribing never closes or interrupts a Hermes session.
- SSE events: `connection`, `snapshot`, `gw` (id `generation:seq`), `request` (approval/clarify server requests), `gateway` (`connected|reconnecting|lost`), `resync` (`truncated_replay|session_reclaimed|generation_change|connection_restored`), `error`, heartbeat comments. Snapshot carries `gateway: connected|unavailable`, `messages[].pending: inflight|queued`, `subscriptionId` (echo of the per-key `subscriptionIds` the client sent in the SSE URL and subscriptions POST; stale snapshots are rejected) and `olderCursor` when more history exists. Snapshots hold the newest 200 rows and are sent in demand-paced chunks; older rows load via `GET /api/hermes/conversations/[key]/history?before=<cursor>&limit=200` (`{messages, olderCursor?}`). The snapshot sequence watermark is sampled before history is read so frames arriving during the read are replayed.
- Commands: `POST /api/hermes/conversations/[key]/{prompt,interrupt,steer,approval,clarify,subagent,branch}`.
- Source label for CRM chats is `crm`. Viewing a chat never resumes it from cold (no auto-continue); sending to an idle stored chat resumes then submits. Ordinary prompts always use `queued:true`.
- cron and webhook chats are hidden from the default list and are read-only (409 `automation_read_only`); "Continue as new chat" branches them.
- Queue semantics are the gateway's: adjacent texts may merge, Stop clears the queue.
- Limits: SSE live-event backlog cap 4 MiB per connection (slow consumers reconnect and receive a snapshot); CRM retains at most 128 sessions, 2 MiB replay per session, retires idle ones after 5 minutes unless a turn or a delegated child is running (retirement releases CRM retention only; Hermes keeps its own runtime lifecycle). Conversation-list status polling shares a 5 s cache and activates at most 8 runtimes per poll.
- Images are staged with `image.attach_bytes` and held under a per-session lock until Hermes claims them at turn start (no local deadline); a second submission queues behind it. A CRM outage longer than about 20 seconds can lead Hermes to interrupt a running turn (orphan reaping).
- All CRM users act as the dashboard user (`ari`) inside Hermes.
- Composer controls (gateway transport only): `GET /api/hermes/conversations/[key]/model-options` returns Hermes `model.options` unchanged plus `reasoning` from session-bound `config.get`. `POST .../model` accepts `{model, provider?, confirm?}`; `POST .../reasoning` accepts `{effort}` (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`; Hermes disabled aliases `false`/`disabled` also work). These require an existing live solo runtime and reject cron/webhook sources; they never cold-resume or change profile defaults. Both setters send `scope: "session"` and model selections additionally carry `--session` because Hermes model persistence is flag-driven. Responses preserve native `config.set` fields: `confirm_required`/`confirm_message` means nothing changed and the client must resend the same selection with `confirm: true` after approval; `deferred: true` means Hermes will apply the model at the next turn, not during streaming.
- Slash commands (gateway transport only): typing `/` at the start of the composer opens a borderless, grouped palette. Hermes supplies fuzzy command/skill ranking and argument suggestions through `POST .../slash-complete` (`{text}`), which returns `complete.slash` plus `commands.catalog` without cold-resuming the session. Arrow keys select, Tab completes, Enter runs, and Escape dismisses. Skills have a dedicated section; terminal-only commands are omitted.
- `POST .../slash-execute` (`{command}`) resumes an idle writable conversation, then calls `slash.exec`, falling back to `command.dispatch` only for RPC error 4018. Send/skill/alias directives become ordinary turns; prefill restores editable composer text. Other output is an ephemeral dismissible card, cleared on the next send or conversation switch and never saved as a chat message. `/new` and `/branch` open the returned conversation; `/compress`, `/compact`, `/undo`, and `/retry` refresh the transcript and discard older cached pages.

## Vendored code

`apps/web/vendor/hermes-gateway/` is a verbatim MIT copy (Nous Research) of the Hermes shared gateway client and generated contract, pinned to the installed Hermes revision (see its README). A test compares the contract's method names with the installed OpenRPC file.
