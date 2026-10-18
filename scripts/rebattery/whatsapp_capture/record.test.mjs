import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toRecord, updateRecord, aliasRecord, membershipRecord, captureSocketOptions } from './record.mjs';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const opts = { account: '447700900000:3@s.whatsapp.net', origin: 'live', capturedAt: 't' };
const key = (extra = {}) => ({ remoteJid: '123456789@lid', remoteJidAlt: '447700900123@s.whatsapp.net', id: 'ABC', fromMe: false, ...extra });

test('inbound text keeps both LID and phone identity', () => {
  const r = toRecord({ key: key(), pushName: 'Mike', messageTimestamp: 1760600000, message: { conversation: 'CALB 72Ah at $6/cell?' } }, opts);
  assert.equal(r.direction, 'inbound');
  assert.equal(r.chatId, '123456789@lid');
  assert.equal(r.chatAltId, '447700900123@s.whatsapp.net');
  assert.equal(r.pushName, 'Mike');
  assert.equal(r.body, 'CALB 72Ah at $6/cell?');
  assert.equal(r.timestamp, 1760600000);
  assert.equal(r.kind, 'message');
});

test('phone-sent message is outbound and carries no pushName', () => {
  const r = toRecord({ key: key({ fromMe: true }), pushName: 'Alex', messageTimestamp: { toNumber: () => 1760600001 }, message: { extendedTextMessage: { text: 'Offer attached', contextInfo: { stanzaId: 'Q1' } } } }, opts);
  assert.equal(r.direction, 'outbound');
  assert.equal(r.pushName, null);
  assert.equal(r.quotedId, 'Q1');
  assert.equal(r.timestamp, 1760600001);
});

test('status, broadcast lists and newsletters are never captured', () => {
  for (const jid of ['status@broadcast', '12345@broadcast', '1203630@newsletter']) {
    assert.equal(toRecord({ key: key({ remoteJid: jid }), message: { conversation: 'x' } }, opts), null);
  }
});

test('group message records the participant', () => {
  const r = toRecord({ key: key({ remoteJid: '1203630@g.us', remoteJidAlt: undefined, participant: '99@lid', participantAlt: '4915100000@s.whatsapp.net' }), message: { conversation: 'hi' } }, opts);
  assert.equal(r.participant, '99@lid');
  assert.equal(r.participantAlt, '4915100000@s.whatsapp.net');
});

test('media inside an ephemeral wrapper yields metadata and caption only', () => {
  const r = toRecord({ key: key(), message: { ephemeralMessage: { message: { documentMessage: {
    mimetype: 'application/pdf', fileName: 'packing-list.pdf', fileLength: 2048, fileSha256: Buffer.from([1, 2]), caption: 'Lot 7', url: 'https://mmg/x', mediaKey: Buffer.from([9]),
  } } } } }, opts);
  assert.deepEqual(r.attachment, { type: 'document', mime: 'application/pdf', filename: 'packing-list.pdf', size: 2048, sha256: '0102', seconds: null });
  assert.equal(r.body, 'Lot 7');
  assert.ok(!JSON.stringify(r).includes('mmg'), 'download URL must not be persisted');
});

test('edits and deletions point at the original message', () => {
  const edit = toRecord({ key: key({ id: 'E1' }), message: { protocolMessage: { type: 14, key: { id: 'ABC' }, editedMessage: { conversation: '$5.80/cell' } } } }, opts);
  assert.deepEqual([edit.kind, edit.targetId, edit.body], ['edit', 'ABC', '$5.80/cell']);
  const revoke = toRecord({ key: key({ id: 'R1' }), message: { protocolMessage: { type: 0, key: { id: 'ABC' } } } }, opts);
  assert.deepEqual([revoke.kind, revoke.targetId, revoke.body], ['revoke', 'ABC', null]);
});

test('protocol-only traffic is dropped', () => {
  assert.equal(toRecord({ key: key(), message: { protocolMessage: { type: 3 } } }, opts), null);
  assert.equal(toRecord({ key: key(), message: { senderKeyDistributionMessage: {} } }, opts), null);
  assert.equal(toRecord({ key: key(), message: null }, opts), null);
});

test('dual-delivered edits share logical ID but retain independent provenance', () => {
  const envelope = toRecord({ key: key({ id: 'EDIT' }), messageTimestamp: 1700000000, message: {
    protocolMessage: { type: 14, key: { id: 'ABC' }, timestampMs: 1700000010123, editedMessage: { conversation: 'synthetic edit' } },
  } }, opts);
  const update = updateRecord({ key: key(), update: {
    message: { editedMessage: { message: { conversation: 'synthetic edit' } } }, messageTimestamp: 1700000010,
  } }, opts);
  assert.equal(envelope.eventId, update.eventId);
  assert.equal(envelope.envelopeId, 'EDIT');
  assert.equal(update.envelopeId, null);
  assert.equal(update.targetId, 'ABC');
  assert.equal(update.provenance.event, 'messages.update');
  assert.equal(updateRecord({ key: key(), update: { status: 4 } }, opts), null);
  const deletion = updateRecord({ key: key(), update: { message: null, messageStubType: 1, key: key({ id: 'REVOKE' }) } }, opts);
  assert.equal(deletion.targetId, 'ABC');
  assert.equal(deletion.envelopeId, 'REVOKE');
});

test('timestamp-less add remove add remains three replay-stable occurrences', () => {
  const events = ['add', 'remove', 'add'].map((action, i) => membershipRecord({
    id: 'synthetic@g.us', action, participants: [{ id: 'synthetic@lid' }],
  }, { ...opts, captureRunId: 'synthetic-run', sequence: i + 1 }));
  assert.equal(new Set(events.map(e => e.eventId)).size, 3);
  assert.equal(events[0].provenance.sequence, 1);
  assert.equal(events[0].timestampSource, 'capture_fallback');
  assert.deepEqual(JSON.parse(JSON.stringify(events)).map(e => e.eventId), events.map(e => e.eventId));
  assert.equal(membershipRecord({ id: 'status@broadcast' }, opts), null);
});

test('media replies and media edits retain references without quoted bodies', () => {
  const message = { imageMessage: { caption: 'synthetic', contextInfo: {
    stanzaId: 'EARLIER', participant: 'synthetic@lid', quotedMessage: { conversation: 'must not persist' },
  } } };
  const r = toRecord({ key: key(), message }, opts);
  assert.equal(r.quotedId, 'EARLIER');
  assert.equal(r.quotedParticipant, 'synthetic@lid');
  assert.ok(!JSON.stringify(r).includes('must not persist'));
  const edit = updateRecord({ key: key(), update: { message: { editedMessage: { message } }, messageTimestamp: 1700000010 } }, opts);
  assert.equal(edit.attachment.type, 'image');
  assert.equal(edit.body, 'synthetic');
});

test('expiry flags survive wrappers and view-once bodies never persist', () => {
  const r = toRecord({ key: key(), messageTimestamp: 1700000000, message: { ephemeralMessage: {
    message: { extendedTextMessage: { text: 'synthetic', contextInfo: { expiration: 60 } } },
  } } }, opts);
  assert.equal(r.flags.ephemeral, true);
  assert.equal(r.flags.expirationSeconds, 60);
  assert.equal(r.flags.expiresAt, new Date(1700000060000).toISOString());
  for (const wrapper of ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension']) {
    const once = toRecord({ key: key(), message: { [wrapper]: { message: { imageMessage: {
      caption: 'secret synthetic body', fileName: 'secret synthetic filename', fileSha256: Buffer.from('secret'),
    } } } } }, opts);
    assert.equal(once.flags.viewOnce, true);
    assert.equal(once.body, null);
    assert.ok(!JSON.stringify(once).includes('secret'));
  }
});

test('unknown types are metadata-only and trusted aliases require PN/LID', () => {
  const r = toRecord({ key: key(), message: { futureMessage: { body: 'synthetic unknown body' } } }, opts);
  assert.equal(r.kind, 'other');
  assert.equal(r.attachment.type, 'futureMessage');
  assert.equal(r.body, null);
  assert.ok(!JSON.stringify(r).includes('synthetic unknown body'));
  assert.equal(aliasRecord({ lid: 'synthetic@lid', pn: 'synthetic@g.us' }, opts), null);
  assert.equal(aliasRecord({ lid: 'synthetic@lid', pn: 'synthetic@s.whatsapp.net' }, opts).kind, 'identity_alias');
});

test('installed Baileys retry receipt closures cannot relay cached phone-sent content under capture config', async () => {
  // Execute the installed dependency's actual closures, not a reimplementation.
  // Socket/network/session boundaries are offline fakes; no provider is contacted.
  const entry = import.meta.resolve('@whiskeysockets/baileys');
  const recv = readFileSync(new URL('./Socket/messages-recv.js', entry), 'utf8');
  const send = readFileSync(new URL('./Socket/messages-send.js', entry), 'utf8');
  const defaults = readFileSync(new URL('./Defaults/index.js', entry), 'utf8');
  const { MessageRetryManager } = await import(new URL('./Utils/message-retry-manager.js', entry));
  const { DEFAULT_CONNECTION_CONFIG } = await import(new URL('./Defaults/index.js', entry));
  assert.match(defaults, /enableRecentMessageCache: true/);
  const constructor = send.match(/const messageRetryManager = enableRecentMessageCache[^;]+;/)?.[0];
  assert.ok(constructor, 'dependency cache construction changed: review safety boundary');
  const start = recv.indexOf('    const willSendMessageAgain =');
  const end = recv.indexOf('    const handleNotification =', start);
  assert.ok(start > 0 && end > start, 'dependency receipt closures changed: review fixture');
  const realClosures = recv.slice(start, end);
  async function exercise(overrides) {
    const effective = { ...DEFAULT_CONNECTION_CONFIG, ...overrides };
    let relays = 0, acks = 0, fallbackReads = 0;
    const logger = { debug() {}, info() {}, warn() {}, error(error) { throw new Error('offline retry harness failed', { cause: error }); } };
    const counts = new Map();
    const context = {
      ...effective, logger, MessageRetryManager,
      getMessage: async key => { fallbackReads++; return effective.getMessage(key); },
      msgRetryCache: { get: async key => counts.get(key), set: async (key, value) => counts.set(key, value) },
      receiptMutex: { mutex: fn => fn() },
      authState: { creds: { me: { id: 'self@s.whatsapp.net' } }, keys: { set: async () => {} } },
      areJidsSameUser: (a, b) => a === b, isJidGroup: jid => jid.endsWith('@g.us'),
      isJidStatusBroadcast: () => false, getStatusFromReceiptType: () => undefined,
      getBinaryNodeChildren: () => [], getBinaryNodeChild: node => node.content[0],
      getBinaryNodeChildUInt: () => undefined, jidDecode: () => ({ device: 1 }),
      extractE2ESessionFromRetryReceipt: () => null,
      signalRepository: { jidToSignalProtocolAddress: jid => jid, getSessionInfo: async () => null },
      assertSessions: async () => {}, relayMessage: async () => { relays++; },
      sendMessageAck: async () => { acks++; },
    };
    vm.createContext(context);
    vm.runInContext(`${constructor}\nglobalThis.manager = messageRetryManager;\n${realClosures}\nglobalThis.receipt = handleReceipt;`, context);
    context.manager?.addRecentMessage('peer@s.whatsapp.net', 'PHONE_SENT', { conversation: 'synthetic phone-sent body' });
    await context.receipt({ tag: 'receipt', attrs: { from: 'peer@s.whatsapp.net', id: 'PHONE_SENT', type: 'retry' },
      content: [{ tag: 'retry', attrs: { count: '1' } }] });
    context.manager?.clear();
    return { manager: context.manager, relays, acks, fallbackReads, effective };
  }
  const unsafe = await exercise({ enableRecentMessageCache: true, maxMsgRetryCount: 5 });
  assert.equal(unsafe.relays, 1, 'positive control must reproduce internal relay from cache');
  const safe = await exercise(captureSocketOptions);
  assert.equal(safe.manager, null, 'effective config constructs no recent-message cache');
  assert.equal(safe.relays, 0);
  assert.equal(safe.acks, 1, 'protocol acknowledgement remains available');
  assert.equal(safe.fallbackReads, 0, 'retry guard prevents even store lookup');
  assert.equal(await safe.effective.getMessage({ id: 'PHONE_SENT' }), undefined);
  // Independently prove the empty-store/cache boundary even without retry-count guard.
  const noStore = await exercise({ ...captureSocketOptions, maxMsgRetryCount: 5 });
  assert.equal(noStore.manager, null);
  assert.equal(noStore.fallbackReads, 1);
  assert.equal(noStore.relays, 0);
});
