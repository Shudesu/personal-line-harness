import { afterEach, expect, test } from 'vitest';
import { createRequire } from 'node:module';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
import { readFileSync } from 'node:fs';
import app from '../apps/worker/src/index.js';
const key = 'synthetic-' + 'owner-'.repeat(6);
const dbs: InstanceType<typeof DatabaseSync>[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
function fixture() {
  const sql = new DatabaseSync(':memory:'); dbs.push(sql);
  for (const name of ['0001_conversations.sql', '0002_managed.sql', '0003_automation.sql']) sql.exec(readFileSync('apps/worker/migrations/' + name, 'utf8'));
  const db = { prepare(query: string) { let args: any[] = []; const stmt = { bind(...values: any[]) { args = values; return stmt; }, async first() { return sql.prepare(query).get(...args) ?? null; }, async all() { return { results: sql.prepare(query).all(...args) }; }, async run() { const r = sql.prepare(query).run(...args); return { meta: { changes: Number(r.changes) } }; } }; return stmt; }, async batch(statements: any[]) { sql.exec('BEGIN'); try { const out = []; for (const s of statements) out.push(await s.run()); sql.exec('COMMIT'); return out; } catch (e) { sql.exec('ROLLBACK'); throw e; } } };
  const env: any = { ADMIN_API_KEY: key, DB: db, OPENCHAT_AUTOMATION_ENABLED: 'false' };
  const call = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => app.request('https://personal.example' + path, { method, headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
  const seed = () => {
    sql.prepare('INSERT INTO openchat_connectors(id,name,token_hash,created_at,created_by,heartbeat_at) VALUES(?,?,?,?,?,?)').run('conn1', 'Fixture', 'synthetic', new Date().toISOString(), 'owner', new Date().toISOString());
    sql.prepare("INSERT INTO openchat_rooms(id,connector_id,external_id,name,kind,enabled) VALUES('chat1','conn1','u00000000000000000000000000000000','Fixture','personal',1)").run();
  };
  return { sql, env, call, seed };
}
test('every personal API requires a bearer, with fail-closed missing-secret configuration', async () => {
  const x = fixture();
  for (const path of ['/api/openchat/hosting', '/api/openchat/rooms', '/api/openchat/connectors', '/api/openchat/managed/connectors/x/status']) {
    expect((await x.call(path, 'GET', undefined, { Authorization: '' })).status).toBe(401);
  }
  x.env.ADMIN_API_KEY = ''; expect((await x.call('/api/openchat/hosting')).status).toBe(401);
});
test('rejects cross-origin requests even with a valid bearer', async () => { const x = fixture(); const r = await x.call('/api/openchat/rooms', 'GET', undefined, { Origin: 'https://other.example' }); expect(r.status).toBe(403); expect(r.headers.get('Access-Control-Allow-Origin')).toBeNull(); });
test('connector callbacks reject an owner key as a connector credential', async () => { const x = fixture(); expect((await x.call('/openchat-connector/heartbeat', 'POST', {})).status).toBe(401); });
test('fresh independent schema is usable and no managed service is falsely advertised', async () => { const x = fixture(); expect(await (await x.call('/api/openchat/rooms')).json()).toEqual({ success: true, data: [] }); const r: any = await (await x.call('/api/openchat/hosting')).json(); expect(r.data.managedAvailable).toBe(false); });
test('real SQL outbox deduplicates identical sends and refuses changed contents', async () => {
  const x = fixture(); x.seed(); const send = (text: string) => x.call('/api/openchat/rooms/chat1/messages', 'POST', { text, requestId: 'stable-1' });
  const first: any = await (await send('Approved')).json(); expect(first.data.state).toBe('queued');
  expect(await (await send('Approved')).json()).toEqual(first); expect((await send('Changed')).status).toBe(409);
  expect(x.sql.prepare('SELECT count(*) n FROM openchat_outbox').get()?.n).toBe(1);
});
test('personal attachments are rejected and an offline connection cannot queue sends', async () => {
  const x = fixture(); x.seed(); expect((await x.call('/api/openchat/rooms/chat1/messages', 'POST', { text: 'x', mediaId: 'media', requestId: 'r1' })).status).toBe(409);
  x.sql.prepare('UPDATE openchat_connectors SET heartbeat_at=NULL').run(); expect((await x.call('/api/openchat/rooms/chat1/messages', 'POST', { text: 'x', requestId: 'r2' })).status).toBe(503);
  expect(x.sql.prepare('SELECT count(*) n FROM openchat_outbox').get()?.n).toBe(0);
});
test('disabling a conversation cancels queued work and retains history', async () => {
  const x = fixture(); x.seed(); await x.call('/api/openchat/rooms/chat1/messages', 'POST', { text: 'Approved', requestId: 'r1' });
  x.sql.prepare("INSERT INTO openchat_messages(id,room_id,external_id,sender_external_id,sender_name,content_type,body,timestamp_ms) VALUES('m1','chat1','e1','u1','Fixture','text','retained',1)").run();
  expect((await x.call('/api/openchat/rooms/chat1', 'PATCH', { enabled: false })).status).toBe(200);
  expect(x.sql.prepare('SELECT state FROM openchat_outbox').get()?.state).toBe('failed'); expect(x.sql.prepare('SELECT body FROM openchat_messages').get()?.body).toBe('retained');
});

test('asset responses keep security headers and fetch the index without a canonical redirect', async () => {
  const x = fixture(); let assetPath = '';
  x.env.ASSETS = { async fetch(request: Request) { assetPath = new URL(request.url).pathname; return new Response('setup', { headers: { 'Cache-Control': 'public', 'Content-Type': 'text/html' } }); } };
  const r = await x.call('/console/personal'); expect(r.status).toBe(200); expect(assetPath).toBe('/');
  expect(r.headers.get('Cache-Control')).toBe('no-store'); expect(r.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'"); expect(r.headers.get('Referrer-Policy')).toBe('no-referrer');
});
