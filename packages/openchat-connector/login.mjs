#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import QRCode from 'qrcode';
const require = createRequire(import.meta.url);
process.umask(0o077);
const index = process.argv.indexOf('--config');
if (index < 0 || !process.argv[index + 1])
  throw Error('Usage: node login.mjs --config openchat-connector.json');
const configPath = path.resolve(process.argv[index + 1]);
fs.chmodSync(configPath, 0o600);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (!/^oc_[a-f0-9]{64}$/.test(config.connectorToken || ''))
  throw Error('Create a connector key in L Harness first');
const base =
  config.stateDir ||
  path.join(
    os.homedir(),
    '.config',
    'line-harness-openchat',
    crypto.createHash('sha256').update(config.connectorToken).digest('hex').slice(0, 12),
  );
fs.mkdirSync(base, { recursive: true, mode: 0o700 });
const sessionPath = config.sessionPath || path.join(base, 'line-session.json');
let session = fs.existsSync(sessionPath) ? JSON.parse(fs.readFileSync(sessionPath, 'utf8')) : {};
const save = () => {
  fs.writeFileSync(sessionPath + '.tmp', JSON.stringify(session), { mode: 0o600 });
  fs.renameSync(sessionPath + '.tmp', sessionPath);
};
const storage = {
  async get(k) {
    return session[k];
  },
  async set(k, v) {
    session[k] = v;
    save();
  },
  async delete(k) {
    delete session[k];
    save();
  },
  async clear() {
    throw Error('Session clear requires explicit removal');
  },
  async migrate(other) {
    for (const [k, v] of Object.entries(session)) await other.set(k, v);
  },
};
const { BaseClient } = require('./vendor/linejs-runtime.cjs');
const client = new BaseClient({ device: 'IOSIPAD', storage, timeout: 30000 });
client.on('update:authtoken', (token) => {
  session.authToken = token;
  save();
});
for (const method of ['checkQrCodeVerified', 'checkPinCodeVerified']) {
  const original = client.loginProcess[method].bind(client.loginProcess);
  client.loginProcess[method] = (s) => original(s, 8, 30);
}
client.on('qrcall', (url) => {
  QRCode.toString(url, { type: 'terminal', small: true }).then((qr) => console.log(qr));
  console.log(
    '連携する本人のLINEでQRを読み取ってください。既存のiPad接続に影響する場合があります。',
  );
});
client.on('pincall', (pin) => console.log('スマホで入力する番号:', pin));
try {
  await client.loginProcess.login(
    session.authToken && !process.argv.includes('--reauth')
      ? { authToken: session.authToken }
      : { qr: true },
  );
  const squares = [];
  let continuationToken;
  do {
    const r = await client.square.getJoinedSquares({ limit: 100, continuationToken });
    squares.push(...r.squares);
    continuationToken = r.continuationToken;
  } while (continuationToken && squares.length < 1000);
  console.log('接続するオプチャを選んでください。LINEの認証情報はこの端末に保存されます。');
  squares.forEach((s, i) => console.log(`${i + 1}. ${s.name}`));
  const input = createInterface({ input: process.stdin, output: process.stdout });
  const selection = await input.question('番号をカンマ区切りで入力（例: 1,3）: ');
  input.close();
  const chosen = [...new Set(selection.split(',').map((x) => Number(x.trim()) - 1))];
  if (!selection.trim() || chosen.some((n) => !Number.isInteger(n) || n < 0 || n >= squares.length))
    throw Error('Invalid selection');
  const chatIDs = [];
  for (const n of chosen) {
    let token;
    do {
      const r = await client.square.getJoinableSquareChats({
        request: { squareMid: squares[n].mid, limit: 100, continuationToken: token },
      });
      for (const chat of r.squareChats || [])
        if (chat.state === 'ALIVE') chatIDs.push(chat.squareChatMid);
      token = r.continuationToken;
    } while (token);
  }
  if (!chatIDs.length) throw Error('No available rooms were returned');
  Object.assign(config, { transport: 'standalone', sessionPath, stateDir: base, chatIDs });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  console.log(
    `接続設定を保存しました。${chatIDs.length}部屋の候補をCloud/OSSへ登録できます。受信箱で連携する部屋を有効にしてください。`,
  );
} catch (e) {
  console.error('OpenChat login or room selection failed:', e?.data?.errorCode || e.name);
  process.exitCode = 1;
}
