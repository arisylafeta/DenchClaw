// Capture-time media download: bounded concurrency, persisted retry queue, never blocks or crashes capture.
// Dependencies are injected so the failure path is testable offline (capture.mjs wires Baileys and the store).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { MEDIA_MAX_BYTES, mediaPlan } from './record.mjs';

// Delays before retries 1..5; the sixth failure is terminal. Media expires on WhatsApp's CDN, so keep it short.
export const RETRY_DELAYS_MS = [5 * 60e3, 30 * 60e3, 2 * 3600e3, 6 * 3600e3, 24 * 3600e3];
const TERMINAL = new Set(['sha256_mismatch', 'too_large', 'empty_download']);
export const DOWNLOAD_TIMEOUT_MS = 120e3;
const REVOKED_MEMORY = 5000;

export function errorCode(err) {
  const status = err?.output?.statusCode ?? err?.status ?? err?.data;
  if (err?.code && /^[A-Z_a-z0-9]{3,40}$/.test(String(err.code)) && err.isStore) return err.code;
  if (status === 404 || status === 410) return 'media_expired';
  if (typeof status === 'number') return `http_${status}`;
  return 'download_failed';
}

// Read a download stream into memory, aborting as soon as it passes the size cap.
export async function collectLimited(stream, limit = MEDIA_MAX_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > limit) {
      stream.destroy?.();
      throw Object.assign(new Error('big'), { isStore: true, code: 'too_large' });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function withTimeout(promise, ms, code) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { isStore: true, code })), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createMediaPipeline({ dir, download, store, record, serialize = JSON.stringify, deserialize = JSON.parse,
  concurrency = 2, now = Date.now, delays = RETRY_DELAYS_MS, downloadTimeoutMs = DOWNLOAD_TIMEOUT_MS, log = () => {} }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const queue = new Map(); // id -> entry
  const active = new Set();
  const revoked = new Set(); // ids whose message was deleted by the sender: never download or keep them
  let wake = null;
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
      const data = await withTimeout(Promise.resolve(download(entry.msg)), downloadTimeoutMs, 'download_timeout');
      if (!data?.length) throw Object.assign(new Error('empty'), { isStore: true, code: 'empty_download' });
      if (data.length > MEDIA_MAX_BYTES) throw Object.assign(new Error('big'), { isStore: true, code: 'too_large' });
      if (createHash('sha256').update(data).digest('hex') !== r.attachment.sha256) {
        throw Object.assign(new Error('hash'), { isStore: true, code: 'sha256_mismatch' });
      }
      if (revoked.has(entry.id)) { drop(entry); return; }
      const stored = await store.put(r, data);
      if (revoked.has(entry.id)) { // deleted while uploading: remove what was just written
        drop(entry);
        await store.remove?.(r, stored.ref).catch(() => {});
        return;
      }
      drop(entry); counts.stored++;
      emit(entry, { status: 'stored', ref: stored.ref, size: data.length, attempts: entry.attempts + 1 });
      return;
    } catch (err) {
      error = errorCode(err);
    }
    if (revoked.has(entry.id)) { drop(entry); return; }
    entry.attempts++;
    const budget = r.origin === 'history' ? 1 : delays.length; // history floods would spam the phone with retry requests
    if (TERMINAL.has(error) || entry.attempts > budget) {
      drop(entry); counts.failed++;
      emit(entry, { status: 'failed', error, attempts: entry.attempts });
      return;
    }
    entry.nextAt = now() + delays[entry.attempts - 1];
    persist(entry);
    schedule();
    emit(entry, { status: 'failed', error, attempts: entry.attempts, retryAt: new Date(entry.nextAt).toISOString() });
  }

  // Wake the pump when the earliest queued retry is due, even if nothing else arrives.
  function schedule() {
    clearTimeout(wake);
    wake = null;
    const due = [...queue.values()].filter(e => !active.has(e.id)).map(e => e.nextAt);
    if (!due.length) return;
    wake = setTimeout(pump, Math.max(1000, Math.min(...due) - now()));
    wake.unref?.();
  }

  function pump() {
    schedule();
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
        if (!plan || revoked.has(idOf(r))) return;
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
      const id = idOf({ account, chatId, messageId });
      revoked.add(id);
      if (revoked.size > REVOKED_MEMORY) revoked.delete(revoked.values().next().value);
      const entry = queue.get(id);
      if (entry && !active.has(id)) drop(entry);
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
// The timeout exceeds media_store's worst case (six rclone calls at its per-call limit).
export function pythonStore({ script, python = 'python3', timeoutMs = 25 * 60e3 }) {
  function run(args, data) {
    return new Promise((resolve, reject) => {
      const child = execFile(python, [script, ...args], { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout) => {
        let out = null;
        try { out = JSON.parse(String(stdout).trim().split('\n').pop()); } catch { /* handled below */ }
        if (!err && !out?.error) return resolve(out ?? {});
        reject(Object.assign(new Error('store failed'), { isStore: true, code: err?.killed ? 'store_timeout' : (out?.error ?? 'store_failed') }));
      });
      child.stdin.on('error', () => {});
      child.stdin.end(data);
    });
  }
  return {
    put: (r, data) => run(['put', '--account', String(r.account), '--chat', r.chatId, '--message-id', r.messageId, '--sha256', r.attachment.sha256], data)
      .then(out => (out.ref ? out : Promise.reject(Object.assign(new Error('store failed'), { isStore: true, code: 'store_failed' })))),
    remove: (_r, ref) => run(['delete', ref]),
  };
}
