#!/usr/bin/env node
// Read-only WhatsApp capture for ReBattery's dedicated business number.
// Links as a WhatsApp companion device via Baileys and appends every non-broadcast
// message (live and the initial history push) to <state>/capture.jsonl.
// There is no HTTP server and no command channel; this process never calls any
// send, read-receipt, presence, or chat-modification API.
//
//   node capture.mjs --state /root/.rebattery/whatsapp-capture --pair   # show QR, link, exit
//   node capture.mjs --state /root/.rebattery/whatsapp-capture          # capture (service)
//
// Pairing requires WhatsApp's live protocol version and a recognized browser
// identity. Baileys' published version can lag and still produce rejected QRs.
import { appendFileSync, chmodSync, closeSync, mkdirSync, openSync, renameSync, writeFileSync, existsSync, statfsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import makeWASocket, { DisconnectReason, fetchLatestWaWebVersion, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import { toRecord, updateRecord, aliasRecord, membershipRecord, captureSocketOptions } from './record.mjs';

const EXIT_UNPAIRED = 3;
const args = process.argv.slice(2);
const PAIR = args.includes('--pair');
const stateArg = args[args.indexOf('--state') + 1];
if (!args.includes('--state') || !stateArg) {
  console.error('usage: capture.mjs --state <dir> [--pair]');
  process.exit(2);
}
const STATE = path.resolve(stateArg);
const AUTH = path.join(STATE, 'auth');
const CAPTURE = path.join(STATE, 'capture.jsonl');
const STATUS = path.join(STATE, 'status.json');
const QR_PNG = path.join(STATE, 'pair-qr.png');

mkdirSync(AUTH, { recursive: true, mode: 0o700 });
chmodSync(STATE, 0o700);
closeSync(openSync(CAPTURE, 'a', 0o600));
chmodSync(CAPTURE, 0o600);

const captureRunId = randomUUID();
let sequence = 0;
const status = { mode: PAIR ? 'pair' : 'capture', state: 'starting', account: null, captured: 0, lastMessageAt: null, lastDisconnect: null, updatedAt: null, captureRunId, heartbeatAt: null, appendError: null, statusError: null, gapSince: new Date().toISOString(), lastGap: null, reconnects: 0 };
function setStatus(patch) {
  Object.assign(status, patch, { updatedAt: new Date().toISOString() });
  const tmp = `${STATUS}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(status, null, 2), { mode: 0o600 });
    renameSync(tmp, STATUS);
    status.statusError = null;
  } catch (err) {
    status.statusError = { code: err.code ?? 'STATUS_WRITE_FAILED', at: new Date().toISOString() };
    console.error('capture status write failed:', status.statusError.code);
  }
}
function options(origin, event) {
  return { account: status.account, origin, event, captureRunId, sequence: ++sequence };
}
setStatus({ heartbeatAt: new Date().toISOString() });
setInterval(() => {
  try {
    const disk = statfsSync(STATE);
    setStatus({ heartbeatAt: new Date().toISOString(), diskAvailableBytes: disk.bavail * disk.bsize, diskError: null });
  } catch (err) {
    setStatus({ heartbeatAt: new Date().toISOString(), diskError: err.code ?? 'DISK_CHECK_FAILED' });
  }
}, 30000).unref();

const logger = pino({ level: process.env.WA_LOG_LEVEL || 'error' }, pino.destination(2));
let sock = null;
let retry = 0;

function forbid(name) {
  return () => { throw new Error(`whatsapp capture is read-only: ${name} is disabled`); };
}

function append(records) {
  const kept = records.filter(Boolean);
  if (!kept.length) return;
  try {
    appendFileSync(CAPTURE, kept.map(r => JSON.stringify(r)).join('\n') + '\n', { flush: true });
  } catch (err) {
    setStatus({ state: 'failed', appendError: { code: err.code ?? 'APPEND_FAILED', at: new Date().toISOString() } });
    console.error('capture append failed:', err.code ?? 'APPEND_FAILED');
    process.exit(1);
  }
  setStatus({ captured: status.captured + kept.length, lastMessageAt: new Date().toISOString() });
}
function capture(messages, origin) {
  const records = [];
  for (const msg of messages || []) {
    const r = toRecord(msg, options(origin, origin === 'history' ? 'messaging-history.set' : 'messages.upsert'));
    if (!r) continue;
    records.push(r);
    for (const [a, b] of [[r.chatId, r.chatAltId], [r.participant, r.participantAlt]]) {
      if (a && b) records.push(aliasRecord({ lid: a.endsWith('@lid') ? a : b, pn: a.endsWith('@lid') ? b : a }, options(origin, 'message.key')));
    }
  }
  append(records);
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH);
  if (!PAIR && !state.creds.me?.id) {
    setStatus({ state: 'unpaired' });
    console.error('Not paired. Run with --pair first.');
    process.exit(EXIT_UNPAIRED);
  }
  status.account ??= state.creds.me?.id ?? null;
  const { version, isLatest, error } = await fetchLatestWaWebVersion({});
  if (!isLatest) throw error ?? new Error('Could not fetch the live WhatsApp protocol version.');
  sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: state,
    logger,
    browser: ['ReBattery CRM', 'Chrome', '120.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    // The internal receive socket captures relayMessage before public methods
    // can be replaced. Disable its cache and both retry branches at construction.
    ...captureSocketOptions,
  });
  for (const name of ['sendMessage', 'relayMessage', 'readMessages', 'sendReceipt', 'sendReceipts', 'sendPresenceUpdate', 'presenceSubscribe', 'chatModify', 'sendMessageAck']) {
    if (typeof sock[name] === 'function') sock[name] = forbid(name);
  }

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type === 'notify' || type === 'append') capture(messages, 'live');
  });
  // The initial history push only reaches the first connection after linking, so pairing captures too.
  sock.ev.on('messaging-history.set', ({ messages }) => capture(messages, 'history'));
  sock.ev.on('messages.update', updates => append(updates.map(u => updateRecord(u, options('live', 'messages.update')))));
  sock.ev.on('messages.delete', event => {
    // A chat-wide clear has no per-message source provenance. Never invent targets.
    if (event.keys) append(event.keys.map(key => updateRecord({ key, update: { message: null, messageStubType: 1 } }, options('live', 'messages.delete'))));
  });
  sock.ev.on('lid-mapping.update', mapping => append([aliasRecord(mapping, options('live', 'lid-mapping.update'))]));
  sock.ev.on('group-participants.update', event => append([membershipRecord(event, options('live', 'group-participants.update'))]));
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr && PAIR) {
      retry = 0; // QR rounds expire by design; keep offering fresh codes promptly
      await QRCode.toFile(QR_PNG, qr, { width: 480 }).then(() => chmodSync(QR_PNG, 0o600)).catch(() => {});
      console.log(`\nScan with WhatsApp Business > Settings > Linked devices > Link a device (also saved to ${QR_PNG}):\n`);
      qrcodeTerminal.generate(qr, { small: true });
      setStatus({ state: 'awaiting_scan' });
    }
    if (connection === 'open') {
      retry = 0;
      const now = new Date().toISOString();
      setStatus({ state: 'connected', account: sock.user?.id ?? status.account, lid: sock.user?.lid ?? null, nextReconnectAt: null,
        lastGap: status.gapSince ? { since: status.gapSince, until: now, catchUpVerified: false } : status.lastGap, gapSince: null });
      append([aliasRecord({ lid: sock.user?.lid, pn: sock.user?.id }, options('live', 'account.paired'))]);
      console.log('WhatsApp capture connected.');
      if (PAIR) {
        console.log('Linked. Collecting the initial history push for 90s, then exiting; then start the service.');
        setTimeout(() => { setStatus({ state: 'paired' }); process.exit(0); }, 90000);
      }
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode ?? null;
      setStatus({ state: 'disconnected', lastDisconnect: { code, at: new Date().toISOString() },
        gapSince: status.gapSince ?? new Date().toISOString(), reconnects: status.reconnects + 1 });
      if (code === DisconnectReason.loggedOut) {
        setStatus({ state: 'logged_out' });
        console.error('Logged out by WhatsApp: re-pair required.');
        process.exit(EXIT_UNPAIRED);
      }
      const delay = code === DisconnectReason.restartRequired ? 1000 : Math.min(60000, 2000 * 2 ** retry++);
      setStatus({ nextReconnectAt: new Date(Date.now() + delay).toISOString() });
      setTimeout(() => start().catch(fail), delay);
    }
  });
}

function fail(err) {
  console.error('capture failed:', err?.code ?? 'CAPTURE_FAILED');
  setStatus({ state: 'failed', failureCode: err?.code ?? 'CAPTURE_FAILED' });
  process.exit(1);
}

if (PAIR && existsSync(path.join(AUTH, 'creds.json'))) {
  const { state } = await useMultiFileAuthState(AUTH);
  if (state.creds.me?.id) {
    console.error(`Already paired (${STATE}). Remove ${AUTH} to re-pair.`);
    process.exit(2);
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { setStatus({ state: 'stopped' }); sock?.end?.(undefined); process.exit(0); });
}
start().catch(fail);
