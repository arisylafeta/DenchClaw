// Pure mapping from a Baileys WAMessage to one append-only capture record.
// The CRM ingest deduplicates on (account, chatId, messageId); replays are kept here.

const SKIPPED_JID = /(^status@broadcast$|@broadcast$|@newsletter$)/;
const CAPTURED_JID = /@(s\.whatsapp\.net|lid|g\.us)$/;
const MEDIA_TYPES = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'];
// Wrappers WhatsApp uses around the real content (ephemeral, view-once, edits, captions).
const WRAPPERS = [
  'ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension',
  'documentWithCaptionMessage', 'deviceSentMessage',
];

export function isCapturedChat(jid) {
  return typeof jid === 'string' && CAPTURED_JID.test(jid) && !SKIPPED_JID.test(jid);
}

function unwrap(message) {
  let content = message;
  for (let depth = 0; content && depth < 5; depth += 1) {
    const key = WRAPPERS.find(k => content[k]?.message);
    if (!key) break;
    content = content[key].message;
  }
  return content || {};
}

function positiveNumber(value) {
  if (value == null) return null;
  const n = typeof value?.toNumber === 'function' ? value.toNumber() : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function text(content) {
  return content.conversation
    ?? content.extendedTextMessage?.text
    ?? null;
}

export function toRecord(msg, { account, origin, capturedAt = new Date().toISOString() }) {
  const key = msg?.key;
  if (!key?.id || !isCapturedChat(key.remoteJid) || !msg.message) return null;
  const content = unwrap(msg.message);
  const protocol = content.protocolMessage;
  if (content.senderKeyDistributionMessage && Object.keys(content).length === 1) return null;
  if (protocol && protocol.type !== 0 && protocol.type !== 14) return null; // keep REVOKE(0) and MESSAGE_EDIT(14)

  let kind = 'message';
  let targetId = null;
  let body = text(content);
  let attachment = null;
  if (protocol) {
    kind = protocol.type === 0 ? 'revoke' : 'edit';
    targetId = protocol.key?.id ?? null;
    body = kind === 'edit' ? text(unwrap(protocol.editedMessage || {})) : null;
  } else if (content.reactionMessage) {
    kind = 'reaction';
    targetId = content.reactionMessage.key?.id ?? null;
    body = content.reactionMessage.text || null;
  } else {
    const mediaType = MEDIA_TYPES.find(t => content[t]);
    if (mediaType) {
      const media = content[mediaType];
      attachment = {
        type: mediaType.replace(/Message$/, ''),
        mime: media.mimetype ?? null,
        filename: media.fileName ?? null,
        size: positiveNumber(media.fileLength),
        sha256: media.fileSha256 ? Buffer.from(media.fileSha256).toString('hex') : null,
        seconds: media.seconds ?? null,
      };
      body = media.caption ?? null;
    }
    if (body == null && !attachment) {
      const type = Object.keys(content).find(k => k !== 'messageContextInfo');
      if (!type) return null;
      kind = 'other';
      body = null;
      attachment = { type, mime: null, filename: null, size: null, sha256: null, seconds: null };
    }
  }

  return {
    schema: 1,
    source: 'whatsapp_baileys',
    origin,
    account,
    chatId: key.remoteJid,
    chatAltId: key.remoteJidAlt ?? null,
    messageId: key.id,
    participant: key.participant ?? null,
    participantAlt: key.participantAlt ?? null,
    pushName: key.fromMe ? null : (msg.pushName ?? null),
    direction: key.fromMe ? 'outbound' : 'inbound',
    timestamp: positiveNumber(msg.messageTimestamp),
    kind,
    targetId,
    quotedId: content.extendedTextMessage?.contextInfo?.stanzaId ?? null,
    body,
    attachment,
    capturedAt,
  };
}
