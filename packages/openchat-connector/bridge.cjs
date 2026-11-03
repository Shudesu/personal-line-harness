// OpenChat transport for line-daemon. JSON-RPC over private stdin/stdout; no HTTP listener.
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  readline = require('node:readline');
const MAX_MEDIA = 20 * 1024 * 1024;
const CT = {
  NONE: 0,
  IMAGE: 1,
  VIDEO: 2,
  AUDIO: 3,
  STICKER: 7,
  CONTACT: 13,
  FILE: 14,
  LOCATION: 15,
};
const LABEL = {
  1: '[画像]',
  2: '[動画]',
  3: '[音声]',
  7: '[スタンプ]',
  14: '[ファイル]',
  15: '[位置情報]',
};
function atomicDisk(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(file + '.tmp', 'w', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
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
function read(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}
function error(code) {
  const e = new Error(code);
  e.code = code;
  return e;
}
function createBridge(config, provided, durable = null) {
  // Worker /tmp is only a scratch cache; durable receipts and cursors are in the DO.
  const atomic = (file, value) => config.ephemeralFiles
    ? fs.writeFileSync(file, JSON.stringify(value)) : atomicDisk(file, value);
  const session = read(config.sessionPath, {});
  if (!session.authToken) throw error('AUTH_REQUIRED');
  const registryFile = config.stateDir + '/registry.json',
    receiptsFile = config.stateDir + '/receipts.json';
  const identityFile = config.stateDir + '/identity.json';
  const identity = read(identityFile, null) || { salt: crypto.randomBytes(32).toString('hex') };
  atomic(identityFile, identity);
  const registry = read(registryFile, {}),
    receipts = read(receiptsFile, {});
  const roots = new Set(config.chatIDs || []);
  if (!roots.size) throw error('NO_ALLOWED_CHATS');
  for (const id of Object.keys(registry))
    if (!roots.has(id) && !roots.has(registry[id].parentID)) delete registry[id];
  const persist = () => atomic(config.sessionPath, session);
  const storage = {
    async get(k) {
      return session[k];
    },
    async set(k, v) {
      session[k] = v;
      persist();
    },
    async delete(k) {
      delete session[k];
      persist();
    },
    async clear() {
      throw error('NO_SESSION_CLEAR');
    },
    async migrate(other) {
      for (const [k, v] of Object.entries(session)) await other.set(k, v);
    },
  };
  const client =
    provided ||
    new (require(config.bundlePath).BaseClient)({ device: 'IOSIPAD', storage, timeout: 25000 });
  if (!provided) client.on?.('update:authtoken', (t) => {
    session.authToken = t;
    persist();
  });
  let connected = false;
  const members = new Map();
  let lastSend = 0;
  function allowed(id) {
    return roots.has(id) || !!(registry[id]?.parentID && roots.has(registry[id].parentID));
  }
  function requireChat(id) {
    if (!allowed(id)) throw error('CHAT_NOT_ALLOWED');
  }
  async function connect() {
    if (!connected) {
      await client.loginProcess.login({ authToken: session.authToken });
      connected = true;
    }
  }
  async function describe(id) {
    if (!roots.has(id)) return registry[id];
    const r = await client.square.getSquareChat({ squareChatMid: id });
    const c = r.squareChat;
    if (!c || c.state !== 'ALIVE') throw error('CHAT_UNAVAILABLE');
    registry[id] = {
      id,
      title: '[オプチャ] ' + c.name,
      selfMid: r.squareChatMember?.squareMemberMid,
      squareMid: c.squareMid,
      parentID: '',
    };
    if (!registry[id].selfMid) {
      const s = await client.square.getSquare({ squareMid: c.squareMid });
      registry[id].selfMid = s.myMembership?.squareMemberMid;
    }
    if (!registry[id].selfMid) throw error('NOT_A_MEMBER');
    atomic(registryFile, registry);
    return registry[id];
  }
  async function discover(parent, id) {
    if (!id || !/^t[a-z0-9]+$/i.test(id) || !roots.has(parent)) return null;
    if (registry[id]) return registry[id];
    const r = await client.square.getSquareThread({
      request: { threadMid: id, includeRootMessage: false },
    });
    if (r.squareThread?.chatMid !== parent) throw error('THREAD_PARENT_MISMATCH');
    const p = registry[parent] || (await describe(parent));
    registry[id] = { ...p, id, parentID: parent, title: p.title + ' / スレッド ' + id.slice(-6) };
    atomic(registryFile, registry);
    return registry[id];
  }
  function ownOutbound(id) {
    return Object.values(receipts).some(
      (r) => r.status === 'done' && r.messages?.some((m) => m.id === id),
    );
  }
  async function normalize(sm, chatID) {
    const m = sm?.message;
    if (!m?.id || !m.from || !m.createdTime) return null;
    if (sm.state === 'UNSENT' || m.contentMetadata?.UNSENT === 'true') return null;
    const chat = registry[chatID];
    if (!chat) throw error('CHAT_NOT_READY');
    let name = members.get(m.from)?.name;
    if (!name || Date.now() - members.get(m.from).at > 3600000) {
      try {
        const p = await client.square.getSquareMember({ squareMemberMid: m.from });
        name = p.squareMember?.displayName;
        members.set(m.from, { name, at: Date.now() });
      } catch {
        name = m.from;
      }
    }
    const type = typeof m.contentType === 'number' ? m.contentType : (CT[m.contentType] ?? 0);
    const filename =
      m.contentMetadata?.FILE_NAME ||
      { 1: 'image.jpg', 2: 'video.mp4', 3: 'audio.m4a' }[type] ||
      '';
    const media = [1, 2, 3, 14].includes(type)
      ? JSON.stringify({ provider: 'openchat', filename, type })
      : '';
    return {
      id: String(m.id),
      chatID,
      senderID: m.from,
      senderName: name || m.from,
      isSender: m.from === chat.selfMid,
      outbound: ownOutbound(String(m.id)) || !!(m.from === chat.selfMid && durable?.getOutbound && await durable.getOutbound(String(m.id))),
      timestamp: Number(m.createdTime),
      contentType: type,
      text: m.text || (LABEL[type] || '') + (filename && type === 14 ? ' ' + filename : ''),
      media,
    };
  }
  async function events(p) {
    requireChat(p.chatID);
    if (!registry[p.chatID]) await describe(p.chatID);
    const chat = registry[p.chatID];
    const r = await client.square.fetchSquareChatEvents({
      squareChatMid: chat.parentID || p.chatID,
      ...(chat.parentID ? { threadMid: p.chatID } : {}),
      limit: 100,
      ...(p.cursor ? { syncToken: p.cursor, direction: 'FORWARD' } : {}),
    });
    const messages = [],
      chats = [];
    for (const e of r.events || []) {
      for (const value of Object.values(e.payload || {})) {
        if (!value || typeof value !== 'object') continue;
        if (value.threadMid && !chat.parentID) {
          try {
            const d = await discover(p.chatID, value.threadMid);
            if (d) chats.push(d);
          } catch {
            /* inaccessible/expired threads are not registered */
          }
        }
        if ((e.type === 'SEND_MESSAGE' || e.type === 'RECEIVE_MESSAGE') && value.squareMessage) {
          const m = await normalize(value.squareMessage, p.chatID);
          if (m) messages.push(m);
        }
      }
    }
    if (!r.syncToken) throw error('MISSING_SYNC_CURSOR');
    return { messages, chats, cursor: r.syncToken, eventCount: (r.events || []).length };
  }
  async function once(key, signature, operation) {
    if (!/^[a-zA-Z0-9:._-]{1,160}$/.test(key || '')) throw error('REQUEST_ID_REQUIRED');
    const hash = crypto.createHash('sha256').update(JSON.stringify(signature)).digest('hex');
    const old = durable ? await durable.getReceipt(key) : receipts[key];
    if (old) {
      if (old.hash !== hash) throw error('REQUEST_ID_CONFLICT');
      if (old.status === 'done') {
        receipts[key] = old;
        if (durable?.putOutbound) for (const m of old.messages) await durable.putOutbound(m.id);
        return old.messages;
      }
      if (old.status === 'rejected') throw error('SEND_REJECTED');
      throw error('SEND_OUTCOME_UNKNOWN');
    }
    receipts[key] = { status: 'pending', hash, at: Date.now() };
    atomic(receiptsFile, receipts);
    if (durable) await durable.putReceipt(key, receipts[key]);
    await new Promise((r) => setTimeout(r, Math.max(0, 3100 - (Date.now() - lastSend))));
    lastSend = Date.now();
    try {
      const messages = await operation();
      receipts[key] = { status: 'done', hash, at: Date.now(), messages };
      atomic(receiptsFile, receipts);
      if (durable?.putOutbound) for (const m of messages) await durable.putOutbound(m.id);
      if (durable) await durable.putReceipt(key, receipts[key]);
      return messages;
    } catch (e) {
      if (e.name === 'RequestError') {
        receipts[key].status = 'rejected';
        atomic(receiptsFile, receipts);
        if (durable) await durable.putReceipt(key, receipts[key]);
        throw error('SEND_REJECTED');
      }
      throw error('SEND_OUTCOME_UNKNOWN');
    }
  }
  async function text(p) {
    requireChat(p.chatID);
    if (!registry[p.chatID]) await describe(p.chatID);
    const value = (p.text || '').trim();
    if (!value || Buffer.byteLength(value) > 5000) throw error('INVALID_TEXT');
    const chat = registry[p.chatID];
    return once(
      p.requestID,
      { chatID: p.chatID, text: value, replyTo: p.replyTo || '' },
      async () => {
        const r = chat.parentID
          ? await client.square.sendSquareThreadMessage({
              request: {
                reqSeq: await client.getReqseq('sq'),
                chatMid: chat.parentID,
                threadMid: p.chatID,
                threadMessage: {
                  squareMessageRevision: 4,
                  message: {
                    to: p.chatID,
                    toType: 'SQUARE_THREAD',
                    text: value,
                    contentType: 'NONE',
                    contentMetadata: {},
                  },
                },
              },
            })
          : await client.square.sendMessage({
              squareChatMid: p.chatID,
              text: value,
              ...(p.replyTo ? { relatedMessageId: p.replyTo } : {}),
            });
        const sm = r.createdSquareMessage || r.createdThreadMessage || r.squareMessage;
        const m = await normalize(sm, p.chatID);
        if (!m) throw error('MISSING_SENT_MESSAGE');
        m.outbound = true;
        return [m];
      },
    );
  }
  async function media(p) {
    requireChat(p.chatID);
    if (!registry[p.chatID]) await describe(p.chatID);
    if (!['image', 'file'].includes(p.kind)) throw error('INVALID_MEDIA_TYPE');
    const bytes = Buffer.from(p.data || '', 'base64');
    if (!bytes.length || bytes.length > MAX_MEDIA) throw error('INVALID_MEDIA_SIZE');
    const filename =
      path
        .basename(p.filename || 'attachment')
        .replace(/[\r\n"\\]/g, '_')
        .slice(0, 180) || 'attachment';
    const mime = p.mimeType || 'application/octet-stream';
    if (/[\r\n]/.test(mime)) throw error('INVALID_MIME');
    if (p.text && Buffer.byteLength(p.text) > 5000) throw error('INVALID_TEXT');
    const result = [
      ...(await once(
        p.requestID + ':media',
        {
          chatID: p.chatID,
          kind: p.kind,
          filename,
          mime,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        },
        async () => {
          const r = await client.obs.uploadObjTalk(
            p.chatID,
            p.kind,
            new Blob([bytes], { type: mime }),
            undefined,
            filename,
          );
          if (!r.objId) throw error('MISSING_SENT_MESSAGE');
          const chat = registry[p.chatID],
            type = p.kind === 'image' ? 1 : 14;
          return [
            {
              id: r.objId,
              chatID: p.chatID,
              senderID: chat.selfMid,
              senderName: '自分',
              isSender: true,
              outbound: true,
              timestamp: Date.now(),
              contentType: type,
              text: LABEL[type] + (type === 14 ? ' ' + filename : ''),
              media: JSON.stringify({ provider: 'openchat', filename, type }),
            },
          ];
        },
      )),
    ];
    if (p.text?.trim())
      result.push(
        ...(await text({
          chatID: p.chatID,
          text: p.text,
          requestID: p.requestID + ':caption',
          replyTo: result[0].id,
        })),
      );
    return result;
  }
  async function dispatch(method, p = {}) {
    await connect();
    if (method === 'list') {
      for (const id of roots) await describe(id);
      for (const hint of p?.threads || []) await discover(hint.parentID, hint.id);
      for (const [id, chat] of Object.entries(registry)) {
        if (chat.parentID)
          chat.title =
            (registry[chat.parentID]?.title || '[オプチャ]') + ' / スレッド ' + id.slice(-6);
      }
      atomic(registryFile, registry);
      return {
        chats: Object.values(registry),
        accountFingerprint: client.profile?.mid
          ? crypto
              .createHash('sha256')
              .update(identity.salt + client.profile.mid)
              .digest('hex')
          : '',
        accountName: client.profile?.displayName || '',
      };
    }
    if (method === 'events') return events(p);
    if (method === 'send') return { messages: await text(p) };
    if (method === 'sendMedia') return { messages: await media(p) };
    if (method === 'getMedia') {
      requireChat(p.chatID);
      if (!/^\d+$/.test(p.id || '')) throw error('INVALID_MESSAGE_ID');
      const b = await client.obs.downloadObjectForService({ obsPath: 'g2/m', oid: p.id });
      if (b.size > MAX_MEDIA) throw error('MEDIA_TOO_LARGE');
      return {
        data: Buffer.from(await b.arrayBuffer()).toString('base64'),
        mimeType: b.type || 'application/octet-stream',
      };
    }
    throw error('UNKNOWN_METHOD');
  }
  return { dispatch };
}
if (require.main === module) {
  process.umask(0o077);
  let bridge;
  try {
    bridge = createBridge(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));
  } catch {
    process.stderr.write('OpenChat bridge configuration unavailable\n');
    process.exit(1);
  }
  let queue = Promise.resolve();
  const input = readline.createInterface({ input: process.stdin });
  input.on('line', (line) => {
    queue = queue.then(async () => {
      let request;
      try {
        request = JSON.parse(line);
        const result = await bridge.dispatch(request.method, request.params);
        process.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
      } catch (e) {
        const c = e.code || e.data?.errorCode || 'BRIDGE_ERROR';
        process.stdout.write(
          JSON.stringify({
            id: request?.id,
            error: { code: /^[A-Z_]+$/.test(c) ? c : 'BRIDGE_ERROR' },
          }) + '\n',
        );
      }
    });
  });
}
module.exports = { createBridge, MAX_MEDIA };
