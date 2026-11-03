import crypto from 'node:crypto';
const fail = code => Object.assign(new Error(code), { code });
export const personalID = id => /^[ucr][a-f0-9]{32}$/.test(id || '');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const messageID = value => {
  const id = String(value ?? '');
  if (!/^\d{1,30}$/.test(id)) throw fail('INVALID_MESSAGE_ID');
  return id;
};
const later = (a, b) => BigInt(a) > BigInt(b);

// A transport shares the authenticated iPad client and encrypted receipt store.
// Discovery reads names only; message bodies are fetched only for selected rooms.
export class PersonalTransport {
  constructor(client, store, identity) {
    this.client = client;
    this.store = store;
    this.identity = identity;
    this.rooms = new Map();
    this.names = new Map();
    this.discoveredAt = 0;
    this.lastSend = 0;
    this.sendQueue = Promise.resolve();
  }
  async list() {
    if (!this.discoveredAt || Date.now() - this.discoveredAt > 60000) {
      const contacts = await this.client.talk.getAllContactIds({ syncReason: 'INTERNAL' });
      const groups = await this.client.talk.getAllChatMids({
        request: { withMemberChats: true, withInvitedChats: false }, syncReason: 'INTERNAL',
      });
      if (!Array.isArray(contacts) || !groups || !Array.isArray(groups.memberChatMids))
        throw fail('PERSONAL_DISCOVERY_UNAVAILABLE');
      const next = new Map();
      const ids = [...new Set(contacts)].filter(id => /^u[a-f0-9]{32}$/.test(id));
      for (let i = 0; i < ids.length; i += 50) {
        const people = await this.client.talk.getContacts({ mids: ids.slice(i, i + 50) });
        for (const p of people) {
          if (!ids.includes(p.mid)) continue;
          this.names.set(p.mid, p.displayName || p.mid);
          next.set(p.mid, { id: p.mid, title: p.displayName || p.mid, kind: 'personal' });
        }
      }
      const joined = groups.memberChatMids.filter(id => /^[cr][a-f0-9]{32}$/.test(id));
      for (let i = 0; i < joined.length; i += 50) {
        const result = await this.client.talk.getChats({ chatMids: joined.slice(i, i + 50), withMembers: false, withInvitees: false });
        for (const g of result.chats || []) {
          if (joined.includes(g.chatMid)) next.set(g.chatMid, { id: g.chatMid, title: g.chatName || 'グループ', kind: 'personal_group' });
        }
      }
      this.rooms = next;
      this.discoveredAt = Date.now();
    }
    return {
      rooms: [...this.rooms.values()],
      accountFingerprint: hash(this.identity.salt + this.client.profile.mid),
      accountName: this.client.profile.displayName || '',
    };
  }
  requireRoom(id) {
    if (!personalID(id) || !this.rooms.has(id)) throw fail('CHAT_NOT_ALLOWED');
  }
  async normalize(original, room) {
    // Match the authenticated account/selected conversation before decrypting.
    const self = this.client.profile.mid;
    const expected = original.to === self ? original.from : original.to;
    if (expected !== room) throw fail('MESSAGE_ROOM_MISMATCH');
    const m = await this.client.e2ee.decryptE2EEMessage(structuredClone(original));
    if (m.chunks && !m.text && (m.contentType === 'NONE' || m.contentType === 0))
      throw fail('E2EE_DECRYPT_FAILED');
    const timestamp = Number(m.createdTime);
    if (!Number.isFinite(timestamp) || timestamp <= 0) throw fail('INVALID_MESSAGE_TIME');
    return {
      id: messageID(m.id), chatID: room, senderID: m.from,
      senderName: m.from === self ? '自分' : this.names.get(m.from) || '参加者',
      isSender: m.from === self, timestamp,
      contentType: 'TEXT',
      text: m.text || ({ IMAGE: '[画像：個人トークの添付取得は未対応]', FILE: '[ファイル：個人トークの添付取得は未対応]', STICKER: '[スタンプ]', VIDEO: '[動画]', AUDIO: '[音声]' }[m.contentType] || '[テキスト以外のメッセージ]'),
      mediaURL: null,
    };
  }
  async messages(room, cursor, startedAt = Date.now()) {
    this.requireRoom(room);
    const previous = cursor ? messageID(cursor) : null;
    let batch = await this.client.talk.getRecentMessagesV2({ messageBoxId: room, messagesCount: 100 });
    if (!Array.isArray(batch)) throw fail('PERSONAL_SYNC_UNAVAILABLE');
    // First fetch establishes a fence; never import history before opt-in.
    if (!previous) {
      if (batch.length >= 100 && batch.every(m => Number(m.createdTime) >= startedAt)) throw fail('PERSONAL_INITIAL_SYNC_BACKLOG');
      const top = batch.reduce((id, m) => later(messageID(m.id), id) ? messageID(m.id) : id, '0');
      const messages = [];
      for (const m of batch) if (Number(m.createdTime) >= startedAt) messages.push(await this.normalize(m, room));
      messages.sort((a,b) => a.timestamp-b.timestamp);
      return { messages, cursor: top, hasMore: false };
    }
    const collected = new Map();
    let reached = false;
    let before;
    for (let page = 0; page < 20; page++) {
      if (!batch.length) { reached = true; break; }
      batch.sort((a, b) => later(messageID(a.id), messageID(b.id)) ? -1 : 1);
      for (const m of batch) {
        const id = messageID(m.id);
        if (later(id, previous)) collected.set(id, m);
        else reached = true;
      }
      if (reached || batch.length < 100) { reached = true; break; }
      const oldest = batch[batch.length - 1];
      if (before === messageID(oldest.id)) throw fail('PERSONAL_SYNC_CURSOR_STALLED');
      before = messageID(oldest.id);
      batch = await this.client.talk.getPreviousMessagesV2WithRequest({
        request: { messageBoxId: room, endMessageId: { deliveredTime: oldest.deliveredTime || oldest.createdTime, messageId: before }, messagesCount: 100, withReadCount: false, receivedOnly: false },
        syncReason: 'INTERNAL',
      });
      if (!Array.isArray(batch)) throw fail('PERSONAL_SYNC_UNAVAILABLE');
    }
    if (!reached) throw fail('PERSONAL_SYNC_BACKLOG'); // keep old cursor, never silently skip messages
    const messages = [];
    for (const m of [...collected.values()].sort((a, b) => later(messageID(a.id), messageID(b.id)) ? 1 : -1))
      messages.push(await this.normalize(m, room));
    return { messages, cursor: messages.at(-1)?.id || previous, hasMore: false };
  }
  send(job, media) {
    const next = this.sendQueue.catch(() => {}).then(() => this.sendOne(job, media));
    this.sendQueue = next.catch(() => {});
    return next;
  }
  async sendOne(job, media) {
    this.requireRoom(job.chatId);
    if (media) throw fail('PERSONAL_MEDIA_UNSUPPORTED');
    if (!job.text?.trim() || Buffer.byteLength(job.text) > 5000) throw fail('INVALID_TEXT');
    if (!/^[a-zA-Z0-9:._-]{1,160}$/.test(job.requestId || '')) throw fail('REQUEST_ID_REQUIRED');
    const key = 'personal:' + job.requestId;
    const signature = hash(JSON.stringify({ room: job.chatId, text: job.text }));
    const old = await this.store.getReceipt(key);
    if (old) {
      if (old.hash !== signature) throw fail('REQUEST_ID_CONFLICT');
      if (old.status === 'done') return old.ids;
      throw fail('SEND_OUTCOME_UNKNOWN');
    }
    await this.store.putReceipt(key, { status: 'pending', hash: signature });
    await new Promise(resolve => setTimeout(resolve, Math.max(0, 3100 - (Date.now() - this.lastSend))));
    this.lastSend = Date.now();
    try {
      // Never downgrade to plaintext if key negotiation fails.
      const sent = await this.client.talk.sendMessage({ to: job.chatId, text: job.text, e2ee: true });
      const ids = [messageID(sent.id)];
      await this.store.putReceipt(key, { status: 'done', hash: signature, ids });
      return ids;
    } catch { throw fail('SEND_OUTCOME_UNKNOWN'); }
  }
}
