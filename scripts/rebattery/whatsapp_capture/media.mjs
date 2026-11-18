// Capture-time media download: bounded concurrency, persisted retry queue, never blocks or crashes capture.
// Dependencies are injected so the failure path is testable offline (capture.mjs wires Baileys and the store).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { MEDIA_MAX_BYTES, mediaPlan } from './record.mjs';

// Delays before retries 1..5; the sixth failure is terminal. Media expires on WhatsApp's CDN, so keep it short.
export const RETRY_DELAYS_MS = [5 * 60e3, 30 * 60e3, 2 * 3600e3, 6 * 3600e3, 24 * 3600e3];
const TERMINAL = new Set(['sha256_mismatch', 'too_large']);

export function errorCode(err) {
  const status = err?.output?.statusCode ?? err?.status ?? err?.data;
  if (err?.code && /^[A-Z_a-z0-9]{3,40}$/.test(String(err.code)) && err.isStore) return err.code;
  if (status === 404 || status === 410) return 'media_expired';
  if (typeof status === 'number') return `http_${status}`;
  return 'download_failed';
}

export function createMediaPipeline({ dir, download, store, record, serialize = JSON.stringify, deserialize = JSON.parse,
  concurrency = 2, now = Date.now, delays = RETRY_DELAYS_MS, log = () => {} }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const queue = new Map(); // id -> entry
  const active = new Set();
  const counts = { stored: 0, failed: 0, skipped: 0 };
  const fileOf = id => path.join(dir, `${id}.json`);
  const idOf = r => createHash('sha256').update(JSON.stringify([r.account, r.chatId, r.messageId])).digest('hex');

  function persist(entry) {
    const tmp = `${fileOf(entry.id)}.tmp`;
    writeFileSync(tmp, JSON.stringify({ id: entry.id, r: entry.r, attempts: entry.attempts, nextAt: entry.nextAt, msg: serialize(entry.msg) }), { mode: 0o600 });
    renameSync(tmp, fileOf(entry.id));
  }
  function drop(entry) {
    queue.delete(entry.id);
    try { unlinkSync(fileOf(entry.id)); } catch { /* already gone */ }
  }
  function emit(entry, result) {
    try {
      record(entry.r, result);
    } catch (err) {
      log('media record failed', err?.code ?? 'RECORD_FAILED');
    }
  }

  async function attempt(entry) {
    const { r } = entry;
    if (r.flags?.expiresAt && Date.parse(r.flags.expiresAt) <= now()) {
      drop(entry); counts.skipped++; emit(entry, { status: 'skipped', error: 'expired' }); return;
    }
    let error;
    try {
      const data = await download(entry.msg);
      if (!data?.length) throw Object.assign(new Error('empty'), { isStore: true, code: 'empty_download' });
      if (data.length > MEDIA_MAX_BYTES) throw Object.assign(new Error('big'), { isStore: true, code: 'too_large' });
      if (createHash('sha256').update(data).digest('hex') !== r.attachment.sha256) {
        throw Object.assign(new Error('hash'), { isStore: true, code: 'sha256_mismatch' });
      }
      const stored = await store.put(r, data);
      drop(entry); counts.stored++;
      emit(entry, { status: 'stored', ref: stored.ref, size: data.length, attempts: entry.attempts + 1 });
      return;
    } catch (err) {
      error = errorCode(err);
    }
    entry.attempts++;
    if (TERMINAL.has(error) || entry.attempts > delays.length) {
      drop(entry); counts.failed++;
      emit(entry, { status: 'failed', error, attempts: entry.attempts });
      return;
    }
    entry.nextAt = now() + delays[entry.attempts - 1];
    persist(entry);
    emit(entry, { status: 'failed', error, attempts: entry.attempts, retryAt: new Date(entry.nextAt).toISOString() });
  }

  function pump() {
    for (const entry of queue.values()) {
      if (active.size >= concurrency) break;
      if (active.has(entry.id) || entry.nextAt > now()) continue;
      active.add(entry.id);
      attempt(entry)
        .catch(err => log('media attempt crashed', err?.code ?? 'MEDIA_ATTEMPT_FAILED'))
        .finally(() => { active.delete(entry.id); setImmediate(pump); });
    }
  }

  return {
    // Call for every captured message record. Never throws.
    submit(msg, r) {
      try {
        const plan = mediaPlan(r, now());
        if (!plan) return;
        const entry = { id: idOf(r), r, msg, attempts: 0, nextAt: now() };
        if (plan.skip) { counts.skipped++; emit(entry, { status: 'skipped', error: plan.skip }); return; }
        if (queue.has(entry.id)) return;
        queue.set(entry.id, entry);
        persist(entry);
        pump();
      } catch (err) {
        log('media submit failed', err?.code ?? 'MEDIA_SUBMIT_FAILED');
      }
    },
    // A revoke arrived: never store content the sender deleted.
    cancel(chatId, messageId, account) {
      const entry = queue.get(idOf({ account, chatId, messageId }));
      if (entry && !active.has(entry.id)) drop(entry);
    },
    // Reload attempts left from a previous run (crash or restart).
    resume() {
      if (!existsSync(dir)) return;
      for (const name of readdirSync(dir).filter(n => n.endsWith('.json'))) {
        try {
          const saved = JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
          if (queue.has(saved.id)) continue;
          queue.set(saved.id, { id: saved.id, r: saved.r, attempts: saved.attempts, nextAt: saved.nextAt, msg: deserialize(saved.msg) });
        } catch { /* corrupt entry: leave it for inspection, never block capture */ }
      }
      pump();
    },
    pump,
    stats: () => ({ ...counts, queued: queue.size }),
  };
}

// Writes through rebattery_whatsapp/media_store.py (encrypted private S3). Rejects with a code-only error.
export function pythonStore({ script, python = 'python3', timeoutMs = 10 * 60e3 }) {
  return {
    put(r, data) {
      return new Promise((resolve, reject) => {
        const child = execFile(python, [script, 'put', '--account', String(r.account), '--chat', r.chatId, '--message-id', r.messageId,
          '--sha256', r.attachment.sha256], { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout) => {
          let out = null;
          try { out = JSON.parse(String(stdout).trim().split('\n').pop()); } catch { /* handled below */ }
          if (!err && out?.ref) return resolve(out);
          reject(Object.assign(new Error('store failed'), { isStore: true, code: out?.error ?? 'store_failed' }));
        });
        child.stdin.on('error', () => {});
        child.stdin.end(data);
      });
    },
  };
}
