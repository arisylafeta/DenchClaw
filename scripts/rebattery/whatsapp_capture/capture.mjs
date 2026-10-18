#!/usr/bin/env node
// Read-only WhatsApp capture for ReBattery's dedicated business number.
// Links as a WhatsApp companion device via Baileys and appends every non-broadcast
// message (live and the initial history push) to <state>/capture.jsonl.
// There is no HTTP server and no command channel; this process never calls any
// send, read-receipt, presence, or chat-modification API.
//
//   node capture.mjs --state /root/.rebattery/whatsapp-capture --pair   # show QR, link, exit
//   node capture.mjs --state /root/.rebattery/whatsapp-capture          # capture (service)
import { appendFileSync, chmodSync, closeSync, mkdirSync, openSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import makeWASocket, { Browsers, DisconnectReason, fetchLatestWaWebVersion, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import { toRecord } from './record.mjs';

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

const status = { mode: PAIR ? 'pair' : 'capture', state: 'starting', account: null, captured: 0, lastMessageAt: null, lastDisconnect: null, updatedAt: null };
function setStatus(patch) {
  Object.assign(status, patch, { updatedAt: new Date().toISOString() });
  const tmp = `${STATUS}.tmp`;
  writeFileSync(tmp, JSON.stringify(status, null, 2), { mode: 0o600 });
  renameSync(tmp, STATUS);
}

const logger = pino({ level: 'error' }, pino.destination(2));
let sock = null;
let retry = 0;

function forbid(name) {
  return () => { throw new Error(`whatsapp capture is read-only: ${name} is disabled`); };
}

function capture(messages, origin) {
  const account = status.account;
  let lines = '';
  for (const msg of messages || []) {
    const record = toRecord(msg, { account, origin });
    if (record) lines += `${JSON.stringify(record)}\n`;
  }
  if (!lines) return;
  appendFileSync(CAPTURE, lines, { flush: true });
  const count = lines.split('\n').length - 1;
  setStatus({ captured: status.captured + count, lastMessageAt: new Date().toISOString() });
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH);
  if (!PAIR && !state.creds.me?.id) {
    setStatus({ state: 'unpaired' });
    console.error('Not paired. Run with --pair first.');
    process.exit(EXIT_UNPAIRED);
  }
  status.account ??= state.creds.me?.id ?? null;
  const { version } = await fetchLatestWaWebVersion({}).catch(() => ({ version: undefined }));
  sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: state,
    logger,
    browser: Browsers.macOS('ReBattery CRM'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    // Never resend stored messages on a peer retry request: we keep no outbound store.
    getMessage: async () => undefined,
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
      setStatus({ state: 'connected', account: sock.user?.id ?? null, lid: sock.user?.lid ?? null });
      console.log(`Connected as ${sock.user?.id ?? 'unknown'}.`);
      if (PAIR) {
        console.log('Linked. Collecting the initial history push for 90s, then exiting; then start the service.');
        setTimeout(() => { setStatus({ state: 'paired' }); process.exit(0); }, 90000);
      }
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode ?? null;
      setStatus({ state: 'disconnected', lastDisconnect: { code, at: new Date().toISOString() } });
      if (code === DisconnectReason.loggedOut) {
        setStatus({ state: 'logged_out' });
        console.error('Logged out by WhatsApp: re-pair required.');
        process.exit(EXIT_UNPAIRED);
      }
      const delay = code === DisconnectReason.restartRequired ? 1000 : Math.min(60000, 2000 * 2 ** retry++);
      setTimeout(() => start().catch(fail), delay);
    }
  });
}

function fail(err) {
  console.error('capture failed:', err?.message || err);
  setStatus({ state: 'failed' });
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
