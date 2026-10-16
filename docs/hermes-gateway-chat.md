# Hermes gateway chat transport

Native Hermes solo chats can run over the Hermes gateway WebSocket (`/api/ws`, JSON-RPC) instead of the REST session SSE. Group chats already use the same gateway socket and are unchanged.

## Switch

`HERMES_CHAT_TRANSPORT=gateway|sse` (server environment, default `sse`). The server enforces it in both directions: with `gateway`, native solo sends on `/api/chat` and `/api/gateway/chat` return 409 `gateway_transport`; with `sse`, gateway submit/steer/interrupt commands return 409 `sse_transport`. The conversation list returns `transport` so the browser follows the server. Roll back by setting `sse` and restarting; Hermes data is untouched.

Required for `gateway`: `HERMES_GATEWAY_WS_URL`, and either `HERMES_GATEWAY_TOKEN` or `HERMES_GATEWAY_USERNAME` + `HERMES_GATEWAY_PASSWORD_FILE` (dashboard basic auth). Rotating the dashboard password breaks gateway chats and groups until the password file is updated.

Database: apply `apps/web/lib/crm-postgres/migrations/046_hermes_message_html.sql` (additive `hermes_message_html` table for mention-pill HTML) before enabling `gateway`. Take a database backup first.

## Behaviour

- One server-held authenticated gateway socket per Node process (`lib/hermes-gateway/manager.ts`). Browsers get one multiplexed SSE per tab: `GET /api/hermes/events?keys=...`, plus `POST /api/hermes/events/subscriptions`. Unsubscribing never closes or interrupts a Hermes session.
- SSE events: `connection`, `snapshot`, `gw` (id `generation:seq`), `request` (approval/clarify server requests), `gateway` (`connected|reconnecting|lost`), `resync` (`truncated_replay|session_reclaimed|generation_change|connection_restored`), `error`, heartbeat comments. Snapshot carries `gateway: connected|unavailable` and `messages[].pending: inflight|queued`.
- Commands: `POST /api/hermes/conversations/[key]/{prompt,interrupt,steer,approval,clarify,subagent,branch}`.
- Source label for CRM chats is `crm`. Viewing a chat never resumes it from cold (no auto-continue); sending to an idle stored chat resumes then submits. Ordinary prompts always use `queued:true`.
- cron and webhook chats are hidden from the default list and are read-only (409 `automation_read_only`); "Continue as new chat" branches them.
- Queue semantics are the gateway's: adjacent texts may merge, Stop clears the queue.
- Limits: SSE output cap 4 MiB per connection (slow consumers reconnect and receive a snapshot); CRM retains at most 128 sessions, 2 MiB replay per session, retires idle ones after 5 minutes (this releases CRM retention only; Hermes keeps its own runtime lifecycle). A CRM outage longer than about 20 seconds can lead Hermes to interrupt a running turn (orphan reaping).
- All CRM users act as the dashboard user (`ari`) inside Hermes.

## Vendored code

`apps/web/vendor/hermes-gateway/` is a verbatim MIT copy (Nous Research) of the Hermes shared gateway client and generated contract, pinned to the installed Hermes revision (see its README). A test compares the contract's method names with the installed OpenRPC file.
