// Pure provider-to-JSONL mapping. No provider operations or media downloads.
import { createHash } from 'node:crypto';
const CAPTURED_JID = /@(s\.whatsapp\.net|lid|g\.us)$/;
const MEDIA_TYPES = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'];
const WRAPPERS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage', 'deviceSentMessage', 'editedMessage'];
export const captureSocketOptions = Object.freeze({
  enableRecentMessageCache: false,
  enableAutoSessionRecreation: false,
  // Also refuse the legacy retry branch before session queries or relay.
  maxMsgRetryCount: 0,
  getMessage: async () => undefined,
});
export function isCapturedChat(jid) {
  return typeof jid === 'string' && CAPTURED_JID.test(jid);
}
function number(value) {
  if (value == null) return null;
  const n = typeof value?.toNumber === 'function' ? value.toNumber() : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function unwrap(message) {
  let content = message || {};
  let ephemeral = false;
  let viewOnce = false;
  for (let depth = 0; depth < 10; depth++) {
    const key = WRAPPERS.find(k => content[k]?.message);
    if (!key) break;
    ephemeral ||= key === 'ephemeralMessage';
    viewOnce ||= key.startsWith('viewOnce');
    content = content[key].message;
  }
  return { content, ephemeral, viewOnce };
}
function hash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function base(key, opts, kind) {
  const capturedAt = opts.capturedAt ?? new Date().toISOString();
  return {
    schema: 2, source: 'whatsapp_baileys', origin: opts.origin, account: opts.account,
    chatId: key.remoteJid ?? null, chatAltId: key.remoteJidAlt ?? null,
    messageId: key.id ?? null, participant: key.participant ?? null,
    participantAlt: key.participantAlt ?? null, direction: key.fromMe ? 'outbound' : 'inbound',
    kind, targetId: null, envelopeId: key.id ?? null, timestamp: null,
    timestampSource: 'capture_fallback', capturedAt,
    provenance: { event: opts.event ?? 'messages.upsert', sourceId: key.id ?? null,
      sourceTimestamp: null, captureRunId: opts.captureRunId ?? null, sequence: opts.sequence ?? null },
  };
}
export function toRecord(msg, opts) {
  const key = msg?.key;
  if (!key?.id || !isCapturedChat(key.remoteJid) || !msg.message) return null;
  const outer = unwrap(msg.message);
  const protocol = outer.content.protocolMessage;
  if (outer.content.senderKeyDistributionMessage && Object.keys(outer.content).length === 1) return null;
  if (protocol && protocol.type !== 0 && protocol.type !== 14) return null;
  const kind = opts.kind ?? (protocol ? (protocol.type === 0 ? 'revoke' : 'edit') : outer.content.reactionMessage ? 'reaction' : 'message');
  const inner = protocol?.type === 14 ? unwrap(protocol.editedMessage) : outer;
  const content = inner.content;
  const mediaType = MEDIA_TYPES.find(t => content[t]);
  const media = mediaType ? content[mediaType] : null;
  const context = content.extendedTextMessage?.contextInfo ?? media?.contextInfo ?? {};
  const viewOnce = outer.viewOnce || inner.viewOnce || media?.viewOnce === true;
  const expirationSeconds = number(context.expiration ?? msg.ephemeralDuration);
  const timestamp = number(msg.messageTimestamp);
  const mutationTimestamp = kind === 'edit' || kind === 'revoke'
    ? (number(protocol?.timestampMs) ? Math.floor(number(protocol.timestampMs) / 1000) : timestamp) : null;
  const r = base(key, opts, kind);
  Object.assign(r, {
    pushName: key.fromMe || viewOnce ? null : (msg.pushName ?? null), timestamp,
    timestampSource: timestamp ? 'provider' : 'capture_fallback',
    targetId: opts.targetId ?? protocol?.key?.id ?? content.reactionMessage?.key?.id ?? null,
    envelopeId: opts.envelopeId === undefined ? key.id : opts.envelopeId,
    mutationTimestamp, correlation: mutationTimestamp ? 'source_time_content' : 'uncertain',
    quotedId: context.stanzaId ?? null, quotedParticipant: context.participant ?? null,
    quotedChatId: context.remoteJid ?? null,
    body: viewOnce || kind === 'revoke' ? null : (content.conversation ?? content.extendedTextMessage?.text ?? media?.caption ?? content.reactionMessage?.text ?? null),
    attachment: media ? { type: mediaType.replace(/Message$/, ''), mime: media.mimetype ?? null,
      filename: viewOnce ? null : (media.fileName ?? null), size: number(media.fileLength),
      sha256: viewOnce ? null : (media.fileSha256 ? Buffer.from(media.fileSha256).toString('hex') : null), seconds: media.seconds ?? null } : null,
    flags: { ephemeral: outer.ephemeral || inner.ephemeral || !!expirationSeconds,
      expirationSeconds, expiresAt: expirationSeconds && timestamp ? new Date(((number(msg.ephemeralStartTimestamp) ?? timestamp) + expirationSeconds) * 1000).toISOString() : null,
      viewOnce, expiryPolicyAvailable: true },
  });
  if (r.body == null && !r.attachment && kind === 'message') {
    const type = Object.keys(content).find(k => k !== 'messageContextInfo');
    if (!type) return null;
    r.kind = 'other';
    r.attachment = { type, mime: null, filename: null, size: null, sha256: null, seconds: null };
  }
  r.provenance.sourceId = r.envelopeId;
  r.provenance.sourceTimestamp = mutationTimestamp ?? timestamp;
  const logical = [r.account, r.chatId, r.kind, r.targetId, mutationTimestamp, r.body, r.attachment];
  r.eventId = hash(kind === 'edit' || kind === 'revoke'
    ? [...logical, ...(mutationTimestamp ? [] : [r.envelopeId, r.provenance.captureRunId, r.provenance.sequence])]
    : [r.account, r.chatId, key.id, r.kind, r.body, r.attachment]);
  return r;
}
export function updateRecord({ key, update }, opts) {
  if (!update) return null;
  if (update.message === null && update.messageStubType === 1) {
    return toRecord({ key, messageTimestamp: update.messageTimestamp,
      message: { protocolMessage: { type: 0, key } } },
    { ...opts, event: opts.event ?? 'messages.update', kind: 'revoke', targetId: key.id, envelopeId: update.key?.id ?? null });
  }
  if (!update.message?.editedMessage) return null;
  return toRecord({ key, message: update.message, messageTimestamp: update.messageTimestamp },
    { ...opts, event: opts.event ?? 'messages.update', kind: 'edit', targetId: key.id, envelopeId: null });
}
export function aliasRecord({ lid, pn }, opts) {
  if (!/@lid$/.test(lid ?? '') || !/@s\.whatsapp\.net$/.test(pn ?? '')) return null;
  const r = base({}, { ...opts, event: opts.event ?? 'lid-mapping.update' }, 'identity_alias');
  return { ...r, lid, pn, evidence: opts.event ?? 'lid-mapping.update', eventId: hash([opts.account, 'alias', lid, pn]) };
}
export function membershipRecord(event, opts) {
  if (!/@g\.us$/.test(event?.id ?? '')) return null;
  const r = base({ remoteJid: event.id, id: event.key?.id }, { ...opts, event: 'group-participants.update' }, 'membership');
  r.timestamp = number(event.timestamp);
  r.timestampSource = r.timestamp ? 'provider' : 'capture_fallback';
  r.provenance.sourceTimestamp = r.timestamp;
  return { ...r, action: event.action, participants: event.participants ?? [], author: event.author ?? null,
    authorPn: event.authorPn ?? null,
    eventId: hash([opts.account, event.id, event.key?.id ?? null, event.action, event.participants,
      ...(event.key?.id ? [] : [opts.captureRunId, opts.sequence])]) };
}
