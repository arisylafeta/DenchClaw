import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { toRecord, mediaPlan, mediaRecord, MEDIA_MAX_BYTES } from './record.mjs';
import { createMediaPipeline, errorCode } from './media.mjs';

const opts = { account: '447700900000:3@s.whatsapp.net', origin: 'live', capturedAt: 't' };
const data = Buffer.from('synthetic datasheet bytes');
const sha = createHash('sha256').update(data).digest();
const key = (id = 'M1') => ({ remoteJid: '123456789@lid', id, fromMe: false });
const doc = (extra = {}, id = 'M1') => ({ key: key(id), messageTimestamp: 1760600000,
  message: { documentMessage: { mimetype: 'application/pdf', fileName: 'sds.pdf', fileLength: data.length, fileSha256: sha, mediaKey: Buffer.from('k'), ...extra } } });
const wrap = (message, tag) => ({ key: key(), messageTimestamp: 1760600000, message: { [tag]: { message } } });

test('image, video, audio and document are eligible; stickers, view-once, expired and oversized are not', () => {
  for (const type of ['image', 'video', 'audio', 'document']) {
    const r = toRecord({ key: key(), message: { [`${type}Message`]: { mimetype: 'x/y', fileLength: 5, fileSha256: sha } } }, opts);
    assert.deepEqual(mediaPlan(r), { download: true }, type);
  }
  assert.equal(mediaPlan(toRecord({ key: key(), message: { stickerMessage: { mimetype: 'image/webp', fileSha256: sha } } }, opts)), null);
  assert.equal(mediaPlan(toRecord({ key: key(), message: { imageMessage: { viewOnce: true, fileSha256: sha } } }, opts)), null);
  assert.equal(mediaPlan(toRecord(wrap({ imageMessage: { fileSha256: sha } }, 'viewOnceMessageV2'), opts)), null);
  const expired = toRecord({ ...doc(), messageTimestamp: 100, message: { ephemeralMessage: { message: doc().message } }, ephemeralDuration: 60 }, opts);
  assert.equal(mediaPlan(expired), null);
  assert.deepEqual(mediaPlan(toRecord(doc({ fileLength: MEDIA_MAX_BYTES + 1 }), opts)), { skip: 'too_large' });
  assert.deepEqual(mediaPlan(toRecord(doc({ fileSha256: undefined }), opts)), { skip: 'no_sha256' });
  const revoke = toRecord({ key: key(), message: { protocolMessage: { type: 0, key: { id: 'M1' } } } }, opts);
  assert.equal(mediaPlan(revoke), null);
});

test('media record maps outcome onto the message with ref and hash, never keys or urls', () => {
  const r = toRecord(doc(), opts);
  const m = mediaRecord(r, { status: 'stored', ref: 'whatsapp-media/a/b/M1-' + sha.toString('hex'), size: data.length, attempts: 1 }, { ...opts, event: 'media.download' });
  assert.equal(m.kind, 'media');
  assert.equal(m.targetId, 'M1');
  assert.equal(m.messageId, 'M1');
  assert.equal(m.media.status, 'stored');
  assert.equal(m.media.sha256, sha.toString('hex'));
  assert.equal(m.media.filename, 'sds.pdf');
  assert.ok(m.media.storedAt);
  assert.doesNotMatch(JSON.stringify(m), /mediaKey|directPath|url/i);
  const failed = mediaRecord(r, { status: 'failed', error: 'media_expired', attempts: 1 }, opts);
  assert.notEqual(failed.eventId, m.eventId);
});

function harness({ download, put, remove, delays = [10, 20], concurrency = 2, downloadTimeoutMs }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-media-'));
  const records = [];
  let clock = 1_000_000;
  const pipeline = createMediaPipeline({
    dir, download, concurrency, delays, now: () => clock, ...(downloadTimeoutMs ? { downloadTimeoutMs } : {}),
    store: { put: async (r, buf) => put(r, buf), ...(remove ? { remove } : {}) },
    record: (r, result) => records.push({ id: r.messageId, ...result }),
  });
  return { pipeline, records, dir, tick: ms => { clock += ms; }, files: () => readdirSync(dir).filter(n => n.endsWith('.json')), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

test('successful download is verified, stored and the queue entry removed', async () => {
  const h = harness({ download: async () => data, put: async () => ({ ref: 'REF' }) });
  h.pipeline.submit(doc(), toRecord(doc(), opts));
  await settle();
  assert.deepEqual(h.records.map(r => [r.id, r.status, r.ref]), [['M1', 'stored', 'REF']]);
  assert.deepEqual(h.files(), []);
  assert.equal(h.pipeline.stats().stored, 1);
  h.cleanup();
});

test('a failed download never throws, is recorded, persisted and retried later', async () => {
  let calls = 0;
  const h = harness({ download: async () => { if (++calls === 1) throw Object.assign(new Error('gone'), { status: 410 }); return data; }, put: async () => ({ ref: 'REF' }) });
  h.pipeline.submit(doc(), toRecord(doc(), opts));
  await settle();
  assert.equal(h.records[0].status, 'failed');
  assert.equal(h.records[0].error, 'media_expired');
  assert.ok(h.records[0].retryAt);
  assert.equal(h.files().length, 1, 'retry state survives a restart');
  h.pipeline.pump();
  await settle();
  assert.equal(h.records.length, 1, 'not retried before its delay');
  h.tick(11);
  h.pipeline.pump();
  await settle();
  assert.equal(h.records[1].status, 'stored');
  assert.deepEqual(h.files(), []);
  h.cleanup();
});

test('retries are bounded: the last failure is terminal and clears the queue', async () => {
  const h = harness({ download: async () => { throw new Error('boom'); }, put: async () => ({ ref: 'REF' }), delays: [10] });
  h.pipeline.submit(doc(), toRecord(doc(), opts));
  await settle();
  h.tick(11); h.pipeline.pump(); await settle();
  assert.deepEqual(h.records.map(r => r.status), ['failed', 'failed']);
  assert.equal(h.records[1].retryAt, undefined);
  assert.deepEqual(h.files(), []);
  assert.equal(h.pipeline.stats().failed, 1);
  h.cleanup();
});

test('hash mismatch and storage failure are recorded; mismatch is terminal', async () => {
  const bad = harness({ download: async () => Buffer.from('tampered'), put: async () => ({ ref: 'REF' }) });
  bad.pipeline.submit(doc(), toRecord(doc(), opts));
  await settle();
  assert.equal(bad.records[0].error, 'sha256_mismatch');
  assert.deepEqual(bad.files(), []);
  const down = harness({ download: async () => data, put: async () => { throw Object.assign(new Error('x'), { isStore: true, code: 'upload_failed' }); } });
  down.pipeline.submit(doc(), toRecord(doc(), opts));
  await settle();
  assert.equal(down.records[0].error, 'upload_failed');
  assert.equal(down.files().length, 1);
  bad.cleanup(); down.cleanup();
});

test('concurrency is bounded and a crash on restart resumes queued work', async () => {
  let running = 0, peak = 0;
  const h = harness({ concurrency: 2, put: async () => ({ ref: 'REF' }), download: async () => { running++; peak = Math.max(peak, running); await new Promise(r => setTimeout(r, 15)); running--; return data; } });
  for (const id of ['A', 'B', 'C', 'D']) h.pipeline.submit(doc({}, id), toRecord(doc({}, id), opts));
  await new Promise(r => setTimeout(r, 120));
  assert.equal(peak, 2);
  assert.equal(h.records.filter(r => r.status === 'stored').length, 4);

  const crashed = harness({ download: async () => { throw new Error('offline'); }, put: async () => ({ ref: 'REF' }) });
  crashed.pipeline.submit(doc(), toRecord(doc(), opts));
  await settle();
  const records = [];
  const revived = createMediaPipeline({ dir: crashed.dir, download: async () => data, store: { put: async () => ({ ref: 'REF' }) },
    delays: [10], now: () => Date.now() + 1e6, record: (r, result) => records.push(result.status) });
  revived.resume();
  await settle();
  assert.deepEqual(records, ['stored']);
  h.cleanup(); crashed.cleanup();
});

test('revoked messages are cancelled and expired messages are skipped, never stored', async () => {
  const h = harness({ download: async () => data, put: async () => ({ ref: 'REF' }), concurrency: 0 });
  const r = toRecord(doc(), opts);
  h.pipeline.submit(doc(), r);
  assert.equal(h.files().length, 1);
  h.pipeline.cancel(r.chatId, r.messageId, r.account);
  assert.deepEqual(h.files(), []);
  h.cleanup();
});

test('error codes carry no provider detail', () => {
  assert.equal(errorCode(Object.assign(new Error('secret url'), { status: 404 })), 'media_expired');
  assert.equal(errorCode(Object.assign(new Error('x'), { output: { statusCode: 503 } })), 'http_503');
  assert.equal(errorCode(new Error('https://mmg.whatsapp.net/secret')), 'download_failed');
});

test('a revoke while the download is in flight discards the file and stores nothing', async () => {
  let release;
  const h = harness({ download: () => new Promise(resolve => { release = () => resolve(data); }), put: async () => { throw new Error('must not store'); } });
  const r = toRecord(doc(), opts);
  h.pipeline.submit(doc(), r);
  await settle();
  h.pipeline.cancel(r.chatId, r.messageId, r.account);
  release();
  await settle();
  assert.deepEqual(h.records, []);
  assert.deepEqual(h.files(), []);
  h.pipeline.submit(doc(), r); // a redelivery of a revoked message is ignored
  await settle();
  assert.deepEqual(h.files(), []);
  h.cleanup();
});

test('a revoke while uploading removes the object that was just written', async () => {
  let finish; const removed = [];
  const h = harness({ download: async () => data, put: () => new Promise(resolve => { finish = () => resolve({ ref: 'REF' }); }), remove: async (r, ref) => { removed.push(ref); } });
  const r = toRecord(doc(), opts);
  h.pipeline.submit(doc(), r);
  await settle();
  h.pipeline.cancel(r.chatId, r.messageId, r.account);
  finish();
  await settle();
  assert.deepEqual(removed, ['REF']);
  assert.deepEqual(h.records, []);
  assert.deepEqual(h.files(), []);
  h.cleanup();
});

test('a hung download times out, is aborted, recorded and does not block other messages', async () => {
  let aborted = false;
  const h = harness({ downloadTimeoutMs: 30, concurrency: 1,
    download: (msg, signal) => { if (msg.key.id !== 'HUNG') return Promise.resolve(data); signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {}); }, put: async () => ({ ref: 'REF' }) });
  h.pipeline.submit(doc({}, 'HUNG'), toRecord(doc({}, 'HUNG'), opts));
  h.pipeline.submit(doc({}, 'OK'), toRecord(doc({}, 'OK'), opts));
  await new Promise(resolve => setTimeout(resolve, 120));
  const byId = Object.fromEntries(h.records.map(r => [r.id, r]));
  assert.equal(byId.HUNG.status, 'failed');
  assert.equal(byId.HUNG.error, 'download_timeout');
  assert.ok(byId.HUNG.retryAt);
  assert.equal(byId.OK.status, 'stored');
  assert.ok(aborted, 'the in-flight download is signalled to stop');
  h.cleanup();
});
