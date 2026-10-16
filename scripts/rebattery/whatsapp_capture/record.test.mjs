import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toRecord } from './record.mjs';

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
