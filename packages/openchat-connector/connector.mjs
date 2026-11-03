#!/usr/bin/env node
import bridgeModule from "./bridge.cjs";
// One owned OpenChat account per connection. No automatic conversation generation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHash } from 'node:crypto';

const MAX_BYTES = 20 * 1024 * 1024;
function save(file, data, ephemeral = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (ephemeral) { fs.writeFileSync(file, JSON.stringify(data)); return; }
  const fd = fs.openSync(file + '.tmp', 'w', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(data));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(file + '.tmp', file);
  const dir = fs.openSync(path.dirname(file), 'r');
  try {
    fs.fsyncSync(dir);
  } finally {
    fs.closeSync(dir);
  }
}
function read(file, otherwise) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return otherwise;
    throw e;
  }
}
export class ConnectorHTTPError extends Error {
  constructor(status) {
    super('Connector HTTP ' + status);
    this.status = status;
  }
}
export class DaemonTransport {
  constructor(config, fetcher = fetch) {
    this.fetcher = fetcher;
    this.rooms = new Set();
    this.base = config.daemonUrl || 'http://127.0.0.1:23380';
    const u = new URL(this.base);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))
      throw Error('The LINE daemon must be on loopback');
    this.token =
      config.daemonToken ||
      read(
        config.daemonSessionPath ||
          path.join(os.homedir(), 'Library/Application Support/line-daemon/session.json'),
        {},
      ).apiToken;
    if (!this.token) throw Error('LINE daemon token is missing');
  }
  async request(endpoint, options = {}) {
    const r = await this.fetcher(this.base + endpoint, {
      ...options,
      headers: { Authorization: 'Bearer ' + this.token, ...options.headers },
      signal: AbortSignal.timeout(120000),
    });
    if (!r.ok) throw new ConnectorHTTPError(r.status);
    return r;
  }
  async list() {
    const info = await (await this.request('/v1/info')).json();
    if (info.openchat?.status !== 'connected' || !info.openchat?.accountFingerprint)
      throw Error('OpenChat is not ready in the LINE daemon');
    if (!Array.isArray(info.openchat.allowedChatIDs))
      throw Error('OpenChat authorization is unavailable');
    const allowed = new Set(info.openchat.allowedChatIDs);
    const result = await (await this.request('/v1/openchat/chats')).json();
    const rooms = (result.items || [])
      .filter((c) => c.isOpenChat && /^[mt][a-f0-9]{32}$/.test(c.id) && allowed.has(c.id))
      .map((c) => ({ id: c.id, title: c.title, parentID: c.parentID || '' }));
    this.rooms = new Set(rooms.map((c) => c.id));
    return {
      rooms,
      accountFingerprint: info.openchat.accountFingerprint,
      accountName: info.openchat.accountName,
    };
  }
  requireRoom(id) {
    if (!/^[mt][a-f0-9]{32}$/.test(id || '') || !this.rooms.has(id))
      throw Object.assign(Error('Room not authorized by the local LINE daemon'), {
        code: 'CHAT_NOT_ALLOWED',
      });
  }
  async messages(room, cursor) {
    this.requireRoom(room);
    const page = await (
      await this.request(
        `/v1/chats/${encodeURIComponent(room)}/messages?direction=after&cursor=${encodeURIComponent(cursor)}`,
      )
    ).json();
    const items = page.items || [];
    return {
      messages: items.map((m) => ({
        id: m.id,
        senderID: m.senderID,
        senderName: m.senderName || m.senderID,
        isSender: !!m.isSender,
        text: m.text || '',
        timestamp: Date.parse(m.timestamp),
        contentType: m.type,
        mediaURL: m.hasMedia ? m.mediaURL : null,
        filename: m.filename || 'attachment',
      })),
      cursor: page.newestCursor || cursor,
      hasMore: !!page.hasMore,
    };
  }
  async media(message) {
    const match = /^\/v1\/chats\/([mt][a-f0-9]{32})\/messages\/(\d+)\/media$/.exec(
      message.mediaURL || '',
    );
    if (!match) throw Error('Invalid media reference');
    this.requireRoom(match[1]);
    const r = await this.request(message.mediaURL);
    const blob = await r.blob();
    if (blob.size > MAX_BYTES) throw Error('Attachment exceeds 20 MiB');
    return {
      data: await blob.arrayBuffer(),
      mime: blob.type || 'application/octet-stream',
      filename: message.filename,
      kind: message.contentType === 'IMAGE' ? 'image' : 'file',
    };
  }
  async send(job, media) {
    this.requireRoom(job.chatId);
    const route = `/v1/chats/${encodeURIComponent(job.chatId)}/` + (media ? 'media' : 'messages');
    const body = media
      ? {
          data: Buffer.from(media.data).toString('base64'),
          kind: job.media.kind,
          filename: job.media.filename,
          mimeType: job.media.mime_type,
          text: job.text,
          requestID: job.requestId,
        }
      : { text: job.text, requestID: job.requestId };
    const r = await (
      await this.request(route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).json();
    return r.messageIDs || [r.messageID];
  }
}
export class StandaloneTransport {
  constructor(config, providedBridge = null) {
    const { createBridge } = bridgeModule;
    this.bridge = providedBridge || createBridge({
      ...config,
      bundlePath:
        config.bundlePath ||
        path.join(path.dirname(fileURLToPath(import.meta.url)), 'vendor/linejs-runtime.cjs'),
    });
    this.fresh = new Set();
  }
  async list() {
    const r = await this.bridge.dispatch('list');
    return { rooms: r.chats, accountFingerprint: r.accountFingerprint, accountName: r.accountName };
  }
  async messages(room, cursor) {
    const r = await this.bridge.dispatch('events', { chatID: room, cursor });
    return {
      messages: r.messages.map((m) => ({
        ...m,
        contentType:
          {
            0: 'TEXT',
            1: 'IMAGE',
            2: 'VIDEO',
            3: 'AUDIO',
            7: 'STICKER',
            14: 'FILE',
            15: 'LOCATION',
          }[m.contentType] || 'TEXT',
        mediaURL: m.media ? m.id : null,
        filename: m.media ? JSON.parse(m.media).filename : null,
      })),
      cursor: r.cursor,
      hasMore: r.eventCount >= 100,
    };
  }
  async media(message) {
    const r = await this.bridge.dispatch('getMedia', { chatID: message.chatID, id: message.id });
    return {
      data: Uint8Array.from(Buffer.from(r.data, 'base64')).buffer,
      mime: r.mimeType,
      filename: message.filename || 'attachment',
      kind: message.contentType === 'IMAGE' ? 'image' : 'file',
    };
  }
  async send(job, media) {
    const r = await this.bridge.dispatch(media ? 'sendMedia' : 'send', {
      chatID: job.chatId,
      text: job.text,
      requestID: job.requestId,
      ...(media
        ? {
            data: Buffer.from(media.data).toString('base64'),
            kind: job.media.kind,
            filename: job.media.filename,
            mimeType: job.media.mime_type,
          }
        : {}),
    });
    return r.messages.map((m) => m.id);
  }
}
export class Connector {
  constructor(config, transport, fetcher = fetch, persistence = null) {
    this.config = config;
    this.persistence = persistence;
    this.restored = false;
    this.pendingSnapshot = undefined;
    this.transport = transport;
    this.fetcher = fetcher;
    const u = new URL(config.harnessUrl);
    if (u.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))
      throw Error('Harness must use HTTPS');
    this.base = config.harnessUrl.replace(/\/$/, '');
    if (!/^oc_[a-f0-9]{64}$/.test(config.connectorToken || ''))
      throw Error('Connector token is missing');
    this.stateFile =
      config.cursorPath ||
      path.join(
        config.stateDir ||
          path.join(
            os.homedir(),
            '.config',
            'line-harness-openchat',
            createHash('sha256')
              .update(this.base + '\0' + config.connectorToken)
              .digest('hex')
              .slice(0, 24),
          ),
        'cloud-sync.json',
      );
    this.state = read(this.stateFile, { rooms: {}, pendingResult: null });
    this.lastHeartbeat = 0;
    this.cursorSnapshots = new Map();
    this.stateSnapshot = JSON.stringify(this.state);
    this.roomSignature = null;
    this.allowed = [];
  }
  async restore() {
    if (this.restored) return;
    if (this.persistence) {
      const pending = await this.persistence.get('pending');
      this.state.pendingResult = pending;
      this.pendingSnapshot = JSON.stringify(pending);
    }
    this.restored = true;
  }
  async persist() {
    const snapshot = JSON.stringify(this.state);
    if (snapshot !== this.stateSnapshot) {
      save(this.stateFile, this.state, this.config.ephemeralFiles);
      this.stateSnapshot = snapshot;
    }
    if (this.persistence) {
      const value = JSON.stringify(this.state.pendingResult);
      if (value !== this.pendingSnapshot) {
        await this.persistence.put('pending', this.state.pendingResult);
        this.pendingSnapshot = value;
      }
    }
  }
  async request(route, body, options = {}) {
    const r = await this.fetcher(this.base + '/openchat-connector' + route, {
      method: body === undefined ? 'GET' : 'POST',
      ...options,
      headers: {
        Authorization: 'Bearer ' + this.config.connectorToken,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: this.config.ephemeralFiles ? undefined : AbortSignal.timeout(90000),
    });
    if (!r.ok) throw new ConnectorHTTPError(r.status);
    return r;
  }
  async json(route, body) {
    const value = await (await this.request(route, body)).json();
    if (!value.success) throw Error('Connector rejected request');
    return value.data;
  }
  async heartbeat() {
    const source = await this.transport.list();
    let rooms = [];
    const signature = JSON.stringify([...source.rooms].sort((a,b) => a.id.localeCompare(b.id)));
    const candidates = signature === this.roomSignature ? [] : source.rooms;
    for (let i = 0; i < Math.max(1, candidates.length); i += 20) {
      const r = await this.json('/heartbeat', {
        accountFingerprint: source.accountFingerprint,
        accountName: source.accountName,
        rooms: candidates.slice(i, i + 20),
      });
      rooms = r.rooms;
    }
    this.roomSignature = signature;
    const locallyAllowed = new Set(source.rooms.map((r) => r.id));
    this.allowed = rooms.filter((r) => r.enabled && locallyAllowed.has(r.external_id));
    this.lastHeartbeat = Date.now();
  }
  async sync() {
    for (const room of this.allowed) {
      let state = this.state.rooms[room.id];
      if (!state && this.persistence) {
        state = await this.persistence.get(`cursor/${room.id}`);
        // A restored unchanged cursor is already durable; do not rewrite it each alarm.
        if (state) this.cursorSnapshots.set(room.id, JSON.stringify(state));
      }
      if (!state || state.enabledAt !== room.enabled_at) {
        const started = Date.parse(room.enabled_at) || Date.now();
        state = {
          enabledAt: room.enabled_at,
          startedAt: started,
          cursor: this.config.transport === 'standalone' ? '' : `${started}:`,
          initializing: this.config.transport === 'standalone',
        };
        this.state.rooms[room.id] = state;
        await this.persist();
      }
      this.state.rooms[room.id] = state;
      for (let page = 0; page < 10; page++) {
        const batch = await this.transport.messages(room.external_id, state.cursor, state.startedAt);
        const normalized = [];
        {
          for (const m of batch.messages) {
            if (m.timestamp < state.startedAt) continue;
            let mediaId;
            try {
              if (m.mediaURL) {
                const media = await this.transport.media({ ...m, chatID: room.external_id });
                const response = await this.request(
                  '/rooms/' + room.id + '/attachments',
                  undefined,
                  {
                    method: 'POST',
                    headers: {
                      'Content-Type': media.mime,
                      'X-Openchat-Filename': encodeURIComponent(media.filename || 'attachment'),
                      'X-Openchat-Kind': media.kind,
                    },
                    body: media.data,
                  },
                );
                const result = await response.json();
                if (!result.success) throw Error('Attachment upload rejected');
                mediaId = result.data.id;
              }
            } catch (e) {
              if (
                (e instanceof ConnectorHTTPError && e.status === 413) ||
                String(e.message).includes('20 MiB')
              )
                m.text = (m.text || '') + ' [添付は20 MiB上限のため同期対象外]';
              else throw e;
            }
            normalized.push({
              id: m.id,
              senderID: m.senderID,
              senderName: m.senderName,
              isSender: m.isSender,
              text: m.text,
              timestamp: m.timestamp,
              contentType: m.contentType,
              ...(mediaId ? { mediaId } : {}),
            });
          }
          for (let i = 0; i < normalized.length; i += 10)
            await this.json('/rooms/' + room.id + '/events', {
              messages: normalized.slice(i, i + 10),
            });
        }
        state.cursor = batch.cursor;
        if (!batch.hasMore) state.initializing = false;
        await this.persist();
        if (this.persistence) {
          const snapshot = JSON.stringify(state);
          if (this.cursorSnapshots.get(room.id) !== snapshot) {
            await this.persistence.put(`cursor/${room.id}`, state);
            // Mark committed only after remote persistence succeeds, so a failed
            // checkpoint is retried even when the next polling cursor is unchanged.
            this.cursorSnapshots.set(room.id, snapshot);
          }
        }
        if (!batch.hasMore) break;
      }
    }
  }
  async report() {
    if (!this.state.pendingResult) return;
    const p = this.state.pendingResult;
    await this.json('/jobs/' + p.id + '/result', p.result);
    this.state.pendingResult = null;
    await this.persist();
  }
  async sendNext() {
    await this.restore();
    await this.report();
    const { job } = await this.json('/jobs/claim', {});
    if (!job) return;
    // Persist the lease before touching LINE. Restart conservatively reports uncertainty.
    this.state.pendingResult = {
      id: job.id,
      result: {
        leaseToken: job.leaseToken,
        state: 'unknown',
        messageIds: [],
        error: 'Connector restarted during send; verify remote history',
      },
    };
    await this.persist();
    let result;
    let attempted = false;
    try {
      if (!this.allowed.some((r) => r.id === job.roomId && r.external_id === job.chatId))
        throw Error('Job room is not enabled');
      let media;
      if (job.media) {
        const r = await this.request('/media/' + job.media.id);
        const blob = await r.blob();
        if (blob.size > MAX_BYTES) throw Error('Attachment exceeds 20 MiB');
        media = { data: await blob.arrayBuffer() };
      }
      attempted = true;
      const ids = await this.transport.send(job, media);
      if (!ids?.length || ids.some((id) => !/^\d+$/.test(id)))
        throw Error('Missing delivery receipt');
      result = { leaseToken: job.leaseToken, state: 'sent', messageIds: ids };
    } catch (e) {
      result = {
        leaseToken: job.leaseToken,
        state:
          !attempted ||
          (e instanceof ConnectorHTTPError && [400, 403, 413].includes(e.status)) ||
          e.code === 'SEND_REJECTED'
            ? 'failed'
            : 'unknown',
        messageIds: [],
        error: 'Send did not complete with a confirmed receipt; verify remote history',
      };
    }
    this.state.pendingResult = { id: job.id, result };
    await this.persist();
    await this.report();
  }
  async tick() {
    await this.restore();
    if (Date.now() - this.lastHeartbeat > 30000) await this.heartbeat();
    await this.sync();
    if (this.allowed.length && !this.allowed.some((r) => this.state.rooms[r.id]?.initializing)) await this.sendNext();
  }
}
async function main() {
  process.umask(0o077);
  const arg = process.argv.indexOf('--config');
  if (arg < 0 || !process.argv[arg + 1])
    throw Error('Usage: node connector.mjs --config openchat-connector.json');
  const configPath = path.resolve(process.argv[arg + 1]);
  fs.chmodSync(configPath, 0o600);
  const config = { ...JSON.parse(fs.readFileSync(configPath, 'utf8')), configPath };
  const transport =
    config.transport === 'standalone'
      ? new StandaloneTransport(config)
      : new DaemonTransport(config);
  const connector = new Connector(config, transport);
  const lock = connector.stateFile + '.lock';
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  function acquire() {
    const fd = fs.openSync(lock, 'wx', 0o600);
    fs.writeFileSync(fd, String(process.pid));
    fs.closeSync(fd);
  }
  try {
    acquire();
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const before = fs.statSync(lock);
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw Error('Invalid connector lock');
    let dead = false;
    try {
      process.kill(pid, 0);
    } catch (check) {
      dead = check.code === 'ESRCH';
    }
    if (!dead || fs.statSync(lock).ino !== before.ino) throw Error('Connector is already running');
    fs.unlinkSync(lock);
    acquire();
  }
  let stopped = false;
  process.on('SIGINT', () => {
    stopped = true;
  });
  process.on('SIGTERM', () => {
    stopped = true;
  });
  let delay = 5000;
  try {
    while (!stopped) {
      try {
        await connector.tick();
        delay = 5000;
      } catch (e) {
        delay = Math.min(delay * 2, 60000);
        console.error(
          JSON.stringify({
            component: 'openchat-connector',
            error:
              e instanceof ConnectorHTTPError
                ? 'HTTP_' + e.status
                : e.code || 'CONNECTION_UNAVAILABLE',
          }),
        );
      }
      if (!stopped) await new Promise((r) => setTimeout(r, delay));
    }
  } finally {
    fs.unlinkSync(lock);
  }
}
if (import.meta.url && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error('OpenChat connector configuration unavailable');
    process.exitCode = 1;
  });
