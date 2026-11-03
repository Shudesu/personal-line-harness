import { Hono, type Context } from 'hono';
import type { Env } from '../index.js';
import { runOpenchatAutomations } from './openchat-automation.js';
import { cleanupManaged } from './openchat-managed.js';
import { requireRole } from '../middleware/role-guard.js';

export const openchat = new Hono<Env>();
openchat.onError((err, c) =>
  fail(
    c,
    err instanceof SyntaxError
      ? 'Invalid JSON'
      : 'OpenChat request failed; verify migration and connection',
    err instanceof SyntaxError ? 400 : 503,
  ),
);
const MAX_MEDIA = 20 * 1024 * 1024;
const now = () => new Date().toISOString();
const fail = (
  c: Context<Env>,
  message: string,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 503 = 400,
) => c.json({ success: false, error: message }, status);
const ok = (c: Context<Env>, data: unknown) => c.json({ success: true, data });
export async function sha(value: string | ArrayBuffer): Promise<string> {
  const b = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
}
type Connector = { id: string; name: string; enabled: number; account_fingerprint: string | null };
type Room = {
  id: string;
  connector_id: string;
  external_id: string;
  name: string;
  enabled: number;
  kind: string;
  connector_heartbeat?: string | null;
  connector_enabled: number;
};
type Media = {
  id: string;
  connector_id: string;
  room_id: string;
  object_key: string;
  filename: string;
  mime_type: string;
  kind: string;
  bytes: number;
  sha256: string;
};
type Job = {
  id: string;
  connector_id: string;
  room_id: string;
  request_id: string;
  body_hash: string;
  body: string;
  media_id: string | null;
  state: string;
  lease_token: string | null;
  remote_ids: string | null;
};
const validMid = (v: unknown) => typeof v === 'string' && /^[mtucr][a-f0-9]{32}$/.test(v);
const validMessageID = (v: unknown) => typeof v === 'string' && /^\d{1,30}$/.test(v);
async function agent(c: Context<Env>): Promise<Connector | null> {
  const token = c.req.header('Authorization')?.replace(/^Bearer /, '') || '';
  if (!/^oc_[a-f0-9]{64}$/.test(token)) return null;
  return c.env.DB.prepare(
    'SELECT id,name,enabled,account_fingerprint FROM openchat_connectors WHERE token_hash=? AND enabled=1',
  )
    .bind(await sha(token))
    .first<Connector>();
}
async function room(c: Context<Env>, id: string, connector?: string): Promise<Room | null> {
  return c.env.DB.prepare(
    'SELECT r.*,c.heartbeat_at AS connector_heartbeat,c.enabled AS connector_enabled FROM openchat_rooms r JOIN openchat_connectors c ON c.id=r.connector_id WHERE r.id=?' +
      (connector ? ' AND r.connector_id=?' : ''),
  )
    .bind(...(connector ? [id, connector] : [id]))
    .first<Room>();
}
async function upload(c: Context<Env>, r: Room): Promise<Response> {
  if (!r.enabled || !r.connector_enabled) return fail(c, 'Room or connection is disabled', 403);
  if (r.kind === 'personal' || r.kind === 'personal_group') return fail(c, '個人トークは現在テキストのみ対応しています', 409);
  const kind = c.req.header('X-Openchat-Kind') || 'file';
  if (!['image', 'file'].includes(kind)) return fail(c, 'Invalid attachment kind');
  let filename: string;
  try {
    filename = decodeURIComponent(c.req.header('X-Openchat-Filename') || 'attachment');
  } catch {
    return fail(c, 'Invalid filename');
  }
  filename = filename.replace(/[\r\n"\\/]/g, '_').slice(0, 180) || 'attachment';
  const length = Number(c.req.header('Content-Length') || 0);
  if (length > MAX_MEDIA) return fail(c, 'Attachment exceeds 20 MiB', 413);
  const data = await c.req.arrayBuffer();
  if (!data.byteLength || data.byteLength > MAX_MEDIA)
    return fail(c, 'Invalid attachment size', 413);
  const bytes = new Uint8Array(data);
  let mime = c.req.header('Content-Type')?.split(';')[0] || 'application/octet-stream';
  if (kind === 'image') {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
      mime = 'image/png';
    else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) mime = 'image/jpeg';
    else if (new TextDecoder().decode(bytes.slice(0, 3)) === 'GIF') mime = 'image/gif';
    else if (
      new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' &&
      new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP'
    )
      mime = 'image/webp';
    else return fail(c, 'Only PNG, JPEG, GIF and WebP images are supported');
  }
  const digest = await sha(data);
  const id = await sha(r.id + '\0' + filename + '\0' + kind + '\0' + digest);
  const key = 'openchat-private/' + r.connector_id + '/' + id;
  const existing = await c.env.DB.prepare('SELECT id FROM openchat_media WHERE id=? AND room_id=?')
    .bind(id, r.id)
    .first();
  if (existing) return ok(c, { id });
  await c.env.IMAGES.put(key, data, { httpMetadata: { contentType: mime } });
  await c.env.DB.prepare(
    'INSERT OR IGNORE INTO openchat_media (id,connector_id,room_id,object_key,filename,mime_type,kind,bytes,sha256,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
  )
    .bind(id, r.connector_id, r.id, key, filename, mime, kind, data.byteLength, digest, now())
    .run();
  return ok(c, { id });
}
async function download(c: Context<Env>, connector?: string): Promise<Response> {
  const m = await c.env.DB.prepare(
    'SELECT m.* FROM openchat_media m JOIN openchat_rooms r ON r.id=m.room_id JOIN openchat_connectors co ON co.id=m.connector_id WHERE m.id=?' +
      (connector ? ' AND m.connector_id=? AND co.enabled=1' : ''),
  )
    .bind(...(connector ? [c.req.param('id'), connector] : [c.req.param('id')]))
    .first<Media>();
  if (!m) return fail(c, 'Attachment not found', 404);
  const object = await c.env.IMAGES.get(m.object_key);
  if (!object) return fail(c, 'Attachment not found', 404);
  return new Response(object.body, {
    headers: {
      'Content-Type': m.kind === 'image' ? m.mime_type : 'application/octet-stream',
      'Content-Disposition': `${m.kind === 'image' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(m.filename)}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
    },
  });
}

// Staff-facing API: existing cookie/Bearer auth and CSRF middleware apply.
openchat.get('/api/openchat/connectors', async (c) =>
  ok(
    c,
    (
      await c.env.DB.prepare(
        'SELECT id,name,enabled,mode,cleanup_pending,account_name,heartbeat_at,created_at FROM openchat_connectors ORDER BY created_at DESC',
      ).all()
    ).results,
  ),
);
openchat.post('/api/openchat/connectors', requireRole('owner', 'admin'), async (c) => {
  const b = await c.req.json<{ name: string }>();
  if (!b.name?.trim() || b.name.length > 100) return fail(c, 'Connection name is required');
  const token =
    'oc_' +
    [...crypto.getRandomValues(new Uint8Array(32))]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('');
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    'INSERT INTO openchat_connectors (id,name,token_hash,created_at,created_by) VALUES (?,?,?,?,?)',
  )
    .bind(id, b.name.trim(), await sha(token), now(), c.get('staff').id)
    .run();
  return ok(c, { id, token });
});
openchat.delete('/api/openchat/connectors/:id', requireRole('owner', 'admin'), async (c) => {
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE openchat_connectors SET enabled=0 WHERE id=?').bind(c.req.param('id')),
    c.env.DB.prepare(
      "UPDATE openchat_outbox SET state='failed',error='Connection revoked',updated_at=? WHERE connector_id=? AND state='queued'",
    ).bind(now(), c.req.param('id')),
    c.env.DB.prepare(
      "UPDATE openchat_outbox SET state='unknown',error='Connection revoked during send; verify remote history',updated_at=? WHERE connector_id=? AND state='leased'",
    ).bind(now(), c.req.param('id')),
  ]);
  const cleaned = await cleanupManaged(c.env, c.req.param('id') || '');
  return ok(c, { revoked: true, cleanupPending: !cleaned });
});
openchat.get('/api/openchat/rooms', async (c) =>
  ok(
    c,
    (
      await c.env.DB.prepare(
        'SELECT r.*,co.name AS connector_name,co.account_name,co.heartbeat_at,co.enabled AS connector_enabled,(SELECT body FROM openchat_messages m WHERE m.room_id=r.id ORDER BY timestamp_ms DESC,id DESC LIMIT 1) AS preview FROM openchat_rooms r JOIN openchat_connectors co ON co.id=r.connector_id ORDER BY COALESCE(r.last_message_at,0) DESC,r.name',
      ).all()
    ).results,
  ),
);
openchat.patch('/api/openchat/rooms/:id', requireRole('owner', 'admin'), async (c) => {
  const r = await room(c, c.req.param('id') || '');
  if (!r) return fail(c, 'Room not found', 404);
  if (!r.connector_enabled) return fail(c, 'Connection is disabled', 403);
  const b = await c.req.json<{ enabled: boolean }>();
  if (typeof b.enabled !== 'boolean') return fail(c, 'enabled must be boolean');
  await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE openchat_rooms SET enabled_at=CASE WHEN ?=1 AND enabled=0 THEN ? ELSE enabled_at END,enabled=? WHERE id=?',
    ).bind(b.enabled ? 1 : 0, now(), b.enabled ? 1 : 0, r.id),
    ...(b.enabled
      ? []
      : [
          c.env.DB.prepare(
            "UPDATE openchat_outbox SET state='failed',error='Room disabled',updated_at=? WHERE room_id=? AND state='queued'",
          ).bind(now(), r.id),
        ]),
  ]);
  return ok(c, { enabled: b.enabled });
});
openchat.get('/api/openchat/rooms/:id/messages', async (c) => {
  const r = await room(c, c.req.param('id') || '');
  if (!r) return fail(c, 'Room not found', 404);
  const limit = Math.max(1, Math.min(100, Number(c.req.query('limit')) || 50));
  const raw = c.req.query('before') || '';
  const [rawTime, beforeId = ''] = raw.split(':');
  const before = raw ? Number(rawTime) : Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(before) || before <= 0) return fail(c, 'Invalid history cursor');
  const messages = (
    await c.env.DB.prepare(
      'SELECT m.*,a.filename,a.kind AS media_kind,a.mime_type FROM openchat_messages m LEFT JOIN openchat_media a ON a.id=m.media_id WHERE m.room_id=? AND (m.timestamp_ms<? OR (m.timestamp_ms=? AND m.id<?)) ORDER BY m.timestamp_ms DESC,m.id DESC LIMIT ?',
    )
      .bind(r.id, before, before, beforeId, limit)
      .all()
  ).results.reverse();
  const outbox = (
    await c.env.DB.prepare(
      'SELECT id,body,media_id,state,error,remote_ids,created_at,updated_at FROM openchat_outbox WHERE room_id=? ORDER BY created_at DESC LIMIT 30',
    )
      .bind(r.id)
      .all()
  ).results;
  return ok(c, {
    messages,
    outbox,
    nextCursor: messages.length === limit ? `${messages[0].timestamp_ms}:${messages[0].id}` : null,
  });
});
openchat.get('/api/openchat/rooms/:id/members', async (c) => {
  const r = await room(c, c.req.param('id') || '');
  if (!r) return fail(c, 'Room not found', 404);
  const members = (
    await c.env.DB.prepare(
      'SELECT DISTINCT m.external_id,m.display_name FROM openchat_members m JOIN openchat_messages msg ON msg.sender_external_id=m.external_id JOIN openchat_rooms r ON r.id=msg.room_id AND r.connector_id=m.connector_id WHERE r.id=?',
    )
      .bind(r.id)
      .all()
  ).results;
  return ok(
    c,
    members.map((m) => ({ ...m, officialFriendId: null, identityStatus: 'unlinked' })),
  );
});
openchat.post('/api/openchat/rooms/:id/attachments', async (c) => {
  const r = await room(c, c.req.param('id') || '');
  return r ? upload(c, r) : fail(c, 'Room not found', 404);
});
openchat.get('/api/openchat/media/:id', (c) => download(c));
openchat.post('/api/openchat/rooms/:id/messages', async (c) => {
  const r = await room(c, c.req.param('id') || '');
  if (!r) return fail(c, 'Room not found', 404);
  const b = await c.req.json<{ text?: string; mediaId?: string; requestId?: string }>();
  const text = (b.text || '').trim();
  const requestId = c.req.header('Idempotency-Key') || b.requestId || '';
  if (!/^[A-Za-z0-9:._-]{1,160}$/.test(requestId)) return fail(c, 'A stable requestId is required');
  if (new TextEncoder().encode(text).length > 5000 || (!text && !b.mediaId))
    return fail(c, 'A message or attachment is required (text max 5000 bytes)');
  const media = b.mediaId
    ? await c.env.DB.prepare(
        'SELECT * FROM openchat_media WHERE id=? AND room_id=? AND connector_id=?',
      )
        .bind(b.mediaId, r.id, r.connector_id)
        .first<Media>()
    : null;
  if (b.mediaId && (r.kind === 'personal' || r.kind === 'personal_group')) return fail(c, '個人トークは現在テキストのみ対応しています', 409);
  if (b.mediaId && !media) return fail(c, 'Attachment belongs to another room', 403);
  const hash = await sha(JSON.stringify({ room: r.id, text, media: media?.id || null }));
  const previous = await c.env.DB.prepare(
    'SELECT * FROM openchat_outbox WHERE connector_id=? AND request_id=?',
  )
    .bind(r.connector_id, requestId)
    .first<Job>();
  if (previous)
    return previous.body_hash === hash
      ? ok(c, { id: previous.id, state: previous.state })
      : fail(c, 'requestId was reused with different content', 409);
  if (!r.enabled || !r.connector_enabled) return fail(c, 'Room or connection is disabled', 403);
  if (!r.connector_heartbeat || Date.now() - Date.parse(r.connector_heartbeat) > 90000)
    return fail(c, 'Connection is offline; reconnect before sending', 503);
  const count = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM openchat_outbox WHERE connector_id=? AND state IN ('queued','leased')",
  )
    .bind(r.connector_id)
    .first<{ n: number }>();
  if ((count?.n || 0) >= 200) return fail(c, 'Send queue is full', 409);
  const id = crypto.randomUUID(),
    time = now();
  await c.env.DB.prepare(
    'INSERT OR IGNORE INTO openchat_outbox (id,connector_id,room_id,request_id,body_hash,body,media_id,created_at,created_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
  )
    .bind(
      id,
      r.connector_id,
      r.id,
      requestId,
      hash,
      text,
      media?.id || null,
      time,
      c.get('staff').id,
      time,
    )
    .run();
  const saved = await c.env.DB.prepare(
    'SELECT id,state,body_hash FROM openchat_outbox WHERE connector_id=? AND request_id=?',
  )
    .bind(r.connector_id, requestId)
    .first<{ id: string; state: string; body_hash: string }>();
  return saved?.body_hash === hash
    ? ok(c, { id: saved.id, state: saved.state })
    : fail(c, 'requestId conflict', 409);
});

// Connector routes authenticate their own narrowly scoped token; no staff API key is shared.
openchat.post('/openchat-connector/heartbeat', async (c) => {
  const co = await agent(c);
  if (!co) return fail(c, 'Unauthorized connector', 401);
  const b = await c.req.json<{
    accountFingerprint: string;
    accountName?: string;
    rooms: { id: string; title: string; parentID?: string }[];
  }>();
  if (
    !/^[a-f0-9]{64}$/.test(b.accountFingerprint || '') ||
    !Array.isArray(b.rooms) ||
    b.rooms.length > 30 ||
    b.rooms.some(
      (r) =>
        !r ||
        !validMid(r.id) ||
        typeof r.title !== 'string' ||
        r.title.length > 300 ||
        (r.parentID && !validMid(r.parentID)),
    )
  )
    return fail(c, 'Invalid connection metadata');
  if (co.account_fingerprint && co.account_fingerprint !== b.accountFingerprint)
    return fail(c, 'Connection identity changed; create a new connection', 409);
  const changed = await c.env.DB.prepare(
    'UPDATE openchat_connectors SET account_fingerprint=?,account_name=?,heartbeat_at=? WHERE id=? AND enabled=1 AND (account_fingerprint IS NULL OR account_fingerprint=?)',
  )
    .bind(
      b.accountFingerprint,
      (b.accountName || '').slice(0, 100),
      now(),
      co.id,
      b.accountFingerprint,
    )
    .run();
  if (!changed.meta.changes) return fail(c, 'Account changed', 409);
  const stmts = [];
  for (const r of b.rooms) {
    const id = await sha(co.id + '\0' + r.id);
    stmts.push(
      c.env.DB.prepare(
        'INSERT INTO openchat_rooms (id,connector_id,external_id,name,kind,parent_external_id) VALUES (?,?,?,?,?,?) ON CONFLICT(connector_id,external_id) DO UPDATE SET name=excluded.name,parent_external_id=excluded.parent_external_id,kind=excluded.kind WHERE openchat_rooms.name IS NOT excluded.name OR openchat_rooms.parent_external_id IS NOT excluded.parent_external_id OR openchat_rooms.kind IS NOT excluded.kind',
      ).bind(
        id,
        co.id,
        r.id,
        r.title,
        r.id.startsWith('u') ? 'personal' : /^[cr]/.test(r.id) ? 'personal_group' : r.id.startsWith('t') ? 'thread' : 'room',
        r.parentID || null,
      ),
    );
  }
  if (stmts.length) await c.env.DB.batch(stmts);
  return ok(c, {
    rooms: (
      await c.env.DB.prepare(
        'SELECT id,external_id,name,enabled,enabled_at FROM openchat_rooms WHERE connector_id=?',
      )
        .bind(co.id)
        .all()
    ).results,
  });
});
openchat.post('/openchat-connector/rooms/:id/attachments', async (c) => {
  const co = await agent(c);
  if (!co) return fail(c, 'Unauthorized connector', 401);
  const r = await room(c, c.req.param('id') || '', co.id);
  return r ? upload(c, r) : fail(c, 'Room not found', 404);
});
openchat.get('/openchat-connector/media/:id', async (c) => {
  const co = await agent(c);
  return co ? download(c, co.id) : fail(c, 'Unauthorized connector', 401);
});
openchat.post('/openchat-connector/rooms/:id/events', async (c) => {
  const co = await agent(c);
  if (!co) return fail(c, 'Unauthorized connector', 401);
  const r = await room(c, c.req.param('id') || '', co.id);
  if (!r) return fail(c, 'Room not found', 404);
  if (!r.enabled || !r.connector_enabled) return fail(c, 'Room or connection is disabled', 403);
  const b = await c.req.json<{
    messages: {
      id: string;
      senderID: string;
      senderName: string;
      isSender: boolean;
      text: string;
      timestamp: number;
      contentType: string;
      mediaId?: string;
    }[];
  }>();
  if (!Array.isArray(b.messages) || b.messages.length > 10) return fail(c, 'Invalid batch');
  const stmts = [];
  for (const m of b.messages) {
    if (
      !m ||
      !validMessageID(m.id) ||
      !(r.kind === 'personal' || r.kind === 'personal_group' ? /^u[a-f0-9]{32}$/ : /^p[a-f0-9]{32}$/).test(m.senderID || '') ||
      typeof m.text !== 'string' ||
      m.text.length > 20000 ||
      typeof m.senderName !== 'string' ||
      m.senderName.length > 200 ||
      !Number.isSafeInteger(m.timestamp) ||
      m.timestamp <= 0 ||
      typeof m.isSender !== 'boolean'
    )
      return fail(c, 'Invalid message');
    if (
      m.mediaId &&
      !(await c.env.DB.prepare(
        'SELECT id FROM openchat_media WHERE id=? AND room_id=? AND connector_id=?',
      )
        .bind(m.mediaId, r.id, co.id)
        .first())
    )
      return fail(c, 'Attachment belongs to another room', 403);
    const id = await sha(r.id + '\0' + m.id);
    stmts.push(
      c.env.DB.prepare(
        'INSERT INTO openchat_members (connector_id,external_id,display_name,updated_at) VALUES (?,?,?,?) ON CONFLICT(connector_id,external_id) DO UPDATE SET display_name=excluded.display_name,updated_at=excluded.updated_at',
      ).bind(co.id, m.senderID, m.senderName, now()),
    );
    stmts.push(
      c.env.DB.prepare(
        'INSERT OR IGNORE INTO openchat_messages (id,room_id,external_id,sender_external_id,sender_name,is_self,content_type,body,timestamp_ms,media_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
      ).bind(
        id,
        r.id,
        m.id,
        m.senderID,
        m.senderName,
        m.isSender ? 1 : 0,
        String(m.contentType || 'TEXT').slice(0, 20),
        m.text,
        m.timestamp,
        m.mediaId || null,
      ),
    );
    stmts.push(
      c.env.DB.prepare(
        'UPDATE openchat_rooms SET last_message_at=MAX(COALESCE(last_message_at,0),?) WHERE id=?',
      ).bind(m.timestamp, r.id),
    );
  }
  if (stmts.length) await c.env.DB.batch(stmts);
  return ok(c, { accepted: b.messages.length });
});
openchat.post('/openchat-connector/jobs/claim', async (c) => {
  const co = await agent(c);
  if (!co) return fail(c, 'Unauthorized connector', 401);
  await runOpenchatAutomations(c.env,co.id);
  const time = now();
  await c.env.DB.prepare(
    "UPDATE openchat_outbox SET state='failed',error='Send request expired; review before sending again',updated_at=? WHERE connector_id=? AND state='queued' AND created_at<?",
  )
    .bind(time, co.id, new Date(Date.now() - 900000).toISOString())
    .run();
  await c.env.DB.prepare(
    "UPDATE openchat_outbox SET state='unknown',error='Connection interrupted; check remote history before resending',updated_at=? WHERE connector_id=? AND state='leased' AND lease_until<?",
  )
    .bind(time, co.id, time)
    .run();
  const job = await c.env.DB.prepare(
    "SELECT q.* FROM openchat_outbox q JOIN openchat_rooms r ON r.id=q.room_id WHERE q.connector_id=? AND q.state='queued' AND r.enabled=1 ORDER BY q.created_at,q.id LIMIT 1",
  )
    .bind(co.id)
    .first<Job>();
  if (!job) return ok(c, { job: null });
  const token = crypto.randomUUID();
  const changed = await c.env.DB.prepare(
    "UPDATE openchat_outbox SET state='leased',lease_token=?,lease_until=?,updated_at=? WHERE id=? AND connector_id=? AND state='queued' AND EXISTS (SELECT 1 FROM openchat_rooms r JOIN openchat_connectors co ON co.id=r.connector_id WHERE r.id=openchat_outbox.room_id AND r.enabled=1 AND co.enabled=1)",
  )
    .bind(token, new Date(Date.now() + 300000).toISOString(), time, job.id, co.id)
    .run();
  if (!changed.meta.changes) return ok(c, { job: null });
  const r = await room(c, job.room_id, co.id);
  const media = job.media_id
    ? await c.env.DB.prepare(
        'SELECT id,filename,mime_type,kind FROM openchat_media WHERE id=? AND connector_id=?',
      )
        .bind(job.media_id, co.id)
        .first()
    : null;
  return ok(c, {
    job: {
      id: job.id,
      roomId: job.room_id,
      chatId: r!.external_id,
      text: job.body,
      media,
      leaseToken: token,
      requestId: 'cloud:' + co.id + ':' + job.id,
    },
  });
});
openchat.post('/openchat-connector/jobs/:id/result', async (c) => {
  const co = await agent(c);
  if (!co) return fail(c, 'Unauthorized connector', 401);
  const b = await c.req.json<{
    leaseToken: string;
    state: string;
    messageIds?: string[];
    error?: string;
  }>();
  if (
    !['sent', 'failed', 'unknown'].includes(b.state) ||
    !Array.isArray(b.messageIds || []) ||
    (b.messageIds || []).length > 3 ||
    (b.messageIds || []).some((id) => !validMessageID(id)) ||
    (b.state === 'sent' && !b.messageIds?.length)
  )
    return fail(c, 'Invalid send result');
  const job = await c.env.DB.prepare(
    'SELECT * FROM openchat_outbox WHERE id=? AND connector_id=? AND lease_token=?',
  )
    .bind(c.req.param('id'), co.id, b.leaseToken)
    .first<Job>();
  if (!job) return fail(c, 'Lease not found', 404);
  const ids = JSON.stringify(b.messageIds || []);
  if (['sent', 'failed'].includes(job.state))
    return b.state === job.state && job.remote_ids === ids
      ? ok(c, { saved: true })
      : fail(c, 'Send result is already final', 409);
  if (!['leased', 'unknown'].includes(job.state))
    return fail(c, 'Send result is already final', 409);
  const changed = await c.env.DB.prepare(
    "UPDATE openchat_outbox SET state=?,remote_ids=?,error=?,updated_at=? WHERE id=? AND connector_id=? AND lease_token=? AND state IN ('leased','unknown')",
  )
    .bind(b.state, ids, (b.error || '').slice(0, 300) || null, now(), job.id, co.id, b.leaseToken)
    .run();
  if (!changed.meta.changes) return fail(c, 'Send result already finalized', 409);
  return ok(c, { saved: true });
});
