# Capture JSONL schema and operations

## Version 2

One UTF-8 JSON object per complete newline, append-only. `schema: 2`, `source: whatsapp_baileys`. Schema 1 lines remain valid legacy input and retain their existing fields; they lack expiry policy and must be labelled `expiry policy unavailable`. Do not rewrite old lines or assume capture order is source chronology. Readers must reject unknown schema versions visibly, not silently skip them.

Common fields: `account` (raw paired account JID), `origin` (`live` or `history`), `chatId`, `chatAltId`, `messageId`, `participant`, `participantAlt`, `direction`, `timestamp` (provider seconds or null), `timestampSource` (`provider` or labelled `capture_fallback`), `capturedAt` (UTC ISO), `kind`, `eventId` (SHA-256 observation/logical mutation identity). Null means unknown, not absent at source. Strip device suffixes only for genuine phone JIDs when canonicalising accounts. Never infer a phone number from group/LID digits.

`provenance` contains `event` (provider event or explicit `message.key`/`account.paired` evidence), `sourceId`, `sourceTimestamp`, `captureRunId` (process UUID) and increasing `sequence` assigned before append. Sequence is process-local and may have gaps. Restart creates a new run ID. Capture timestamps are not claimed source timestamps.

Kinds:

- `message`, `other`: normal content or unsupported metadata. `body` nullable text; `attachment` nullable `{type,mime,filename,size,sha256,seconds}`. No media download URLs, encryption keys or quoted bodies are stored.
- `edit`, `revoke`: `targetId` is the original provider message ID. `envelopeId` is the independently known mutation envelope ID, never the target substituted as an envelope. `messageId` retains the provider event's key and may be the target on `messages.update`. `mutationTimestamp` is provider seconds or null. For dual-delivered edits with source time, `eventId` correlates account/chat/target/kind/time/canonical body and metadata; retain each delivery's provenance even when projecting one logical mutation. `correlation: uncertain` means missing source time: preserve observations rather than silently merging. `revoke` has no body.
- `reaction`: target in `targetId`, reaction in nullable `body`.
- `identity_alias`: trusted PN/LID pair in `pn`, `lid`, with `evidence` naming the source. No name-based inference. Account-scoped pair identity is deterministic.
- `membership`: `action`, `participants` (provider participant objects or JIDs), `author`, `authorPn`. `chatId` is the group. Prefer provider key/time when available. Without a source key, event identity includes capture-run/sequence, so add/remove/add remains three observations; replaying those same lines adds none. Reconnect duplicates without provenance remain uncertain observations, not precise membership intervals.

Messages have `quotedId`, `quotedParticipant`, `quotedChatId` references for text and media replies, never quoted content. `flags` contains `ephemeral`, `expirationSeconds`, `expiresAt` (UTC ISO when duration and source timestamp are known), `viewOnce`, `expiryPolicyAvailable: true`. Expiry is metadata for downstream purge, not a promise that append-only JSONL performs retention itself. View-once bodies/captions, filenames and hashes are not persisted. Shorter source expiry must be honoured by importer/retention. Unknown message types retain only type metadata.

## Capture boundary

Baileys 7.0.0-rc13 is pinned. Socket construction disables `enableRecentMessageCache` and automatic session recreation, sets `maxMsgRetryCount: 0`, and supplies an empty `getMessage`. These are dependency-internal controls, not just replacements of public send methods. Tests execute the installed retry receipt and resend closures offline, using synthetic inputs, and show the unsafe cache-enabled control can relay while the capture configuration cannot. Protocol acknowledgements still occur. This is not network-level read-only and does not prove future Baileys versions safe. Run `npm test` after dependency changes before deployment.

## Operations and recovery

Standalone service: `rebattery-whatsapp-capture.service`. State stays outside Git in `/root/.rebattery/whatsapp-capture/` (directory 0700, JSONL/status 0600). It has no HTTP/command interface or agent dispatch. Matcha owns health triage; Ari/Alex own account recovery. Never send a message to test capture. Do not restart or re-pair without the deployment/recovery owner's approval. Preserve the live web-version resolver, recognised Chrome identity, session and `syncFullHistory: false`.

Read only status metadata for health: `heartbeatAt` updates every 30 seconds; stale beyond 90 seconds requires investigation. Check `state`, `gapSince`, `lastGap.catchUpVerified` (always false until independently reconciled), `reconnects`, `nextReconnectAt`, `diskAvailableBytes`, `diskError`, `appendError`, `statusError`. A successful reconnect does not prove catch-up or complete history. Disk/append failures emit only an error code, attempt a status write and terminate on append failure to avoid silent continued loss. If the status disk itself is unwritable, the previous status necessarily remains stale and stderr is the fallback. An append failure may leave an incomplete last line for importer reconciliation. Never print chat bodies, real phone numbers, auth files or raw provider errors in incident reports.

Rollback must preserve this no-content-resend boundary, external auth and JSONL. No earlier cache-enabled revision is a safe rollback. Retain capture/quarantine for 30 days subject to shorter expiry and erasure policy; downstream business retention and copied model artefacts require the shared retention workflow. No provider history/media fetch is authorised here. Representative live/reconnect completeness remains unverified until separately approved observation.
