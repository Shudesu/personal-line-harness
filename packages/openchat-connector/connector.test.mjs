import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Connector, DaemonTransport } from './connector.mjs';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-openchat-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = {
    harnessUrl: 'https://harness.example',
    connectorToken: 'oc_' + 'a'.repeat(64),
    transport: 'daemon',
    stateDir: dir,
  };
  const calls = [];
  let job = {
      id: 'job1',
      roomId: 'room1',
      chatId: 'm' + 'a'.repeat(32),
      text: 'hello',
      media: null,
      leaseToken: 'lease1',
      requestId: 'cloud:job1',
    },
    ackFail = false;
  const reports = [];
  const message = {
    id: '123',
    senderID: 'p' + 'a'.repeat(32),
    senderName: 'Member',
    isSender: false,
    text: 'incoming',
    timestamp: Date.now(),
    contentType: 'TEXT',
  };
  const transport = {
    async list() {
      calls.push('list');
      return {
        rooms: [{ id: 'm' + 'a'.repeat(32), title: 'Room' }],
        accountFingerprint: 'a'.repeat(64),
        accountName: 'Owner',
      };
    },
    async messages() {
      calls.push('messages');
      return { messages: [{ ...message }], cursor: 'next', hasMore: false };
    },
    async send() {
      calls.push('send');
      return ['456'];
    },
    async media() {
      throw Error('temporary download failure');
    },
  };
  const fetcher = async (url, options) => {
    const route = new URL(url).pathname;
    let data = {};
    if (route.endsWith('/heartbeat'))
      data = {
        rooms: [
          {
            id: 'room1',
            external_id: 'm' + 'a'.repeat(32),
            enabled: 1,
            enabled_at: new Date(Date.now() - 10000).toISOString(),
          },
        ],
      };
    else if (route.endsWith('/jobs/claim')) {
      data = { job };
      job = null;
    } else if (route.endsWith('/result')) {
      if (ackFail) {
        ackFail = false;
        throw Error('ACK lost');
      }
      reports.push(JSON.parse(options.body));
    }
    return new Response(JSON.stringify({ success: true, data }), {
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return {
    config,
    transport,
    fetcher,
    calls,
    reports,
    message,
    set job(value) {
      job = value;
    },
    set ackFail(value) {
      ackFail = value;
    },
  };
}
test('starts the receive cursor before sending the first job', async (t) => {
  const f = fixture(t);
  const c = new Connector(f.config, f.transport, f.fetcher);
  await c.tick();
  assert.ok(f.calls.indexOf('messages') < f.calls.indexOf('send'));
  assert.equal(f.reports[0].state, 'sent');
});
test('an ACK failure persists the sent receipt and never resends after restart', async (t) => {
  const f = fixture(t);
  const c = new Connector(f.config, f.transport, f.fetcher);
  await c.heartbeat();
  f.ackFail = true;
  await assert.rejects(c.sendNext());
  const restarted = new Connector(f.config, f.transport, f.fetcher);
  await restarted.sendNext();
  assert.equal(f.calls.filter((x) => x === 'send').length, 1);
  assert.equal(f.reports[0].state, 'sent');
});
test('a crash during send is reported unknown without retrying the message', async (t) => {
  const f = fixture(t);
  f.job = null;
  fs.writeFileSync(
    path.join(f.config.stateDir, 'cloud-sync.json'),
    JSON.stringify({
      rooms: {},
      pendingResult: {
        id: 'job1',
        result: { leaseToken: 'lease1', state: 'unknown', messageIds: [] },
      },
    }),
  );
  const c = new Connector(f.config, f.transport, f.fetcher);
  await c.sendNext();
  assert.equal(f.calls.filter((x) => x === 'send').length, 0);
  assert.equal(f.reports[0].state, 'unknown');
});
test('transient attachment failures do not advance the receive cursor', async (t) => {
  const f = fixture(t);
  f.job = null;
  f.message.mediaURL = '/v1/chats/m/media';
  const c = new Connector(f.config, f.transport, f.fetcher);
  await c.heartbeat();
  await assert.rejects(c.sync(), /temporary/);
  assert.notEqual(c.state.rooms.room1.cursor, 'next');
});
test('a job for a room outside the enabled list is not sent', async (t) => {
  const f = fixture(t);
  f.job = {
    id: 'bad',
    roomId: 'foreign',
    chatId: 'm' + 'b'.repeat(32),
    text: 'x',
    leaseToken: 'lease2',
    requestId: 'bad',
  };
  const c = new Connector(f.config, f.transport, f.fetcher);
  await c.heartbeat();
  await c.sendNext();
  assert.equal(f.calls.filter((x) => x === 'send').length, 0);
  assert.equal(f.reports[0].state, 'failed');
});

test('daemon transport never enumerates or sends to ordinary private LINE chats', async () => {
  const mid = 'm' + 'a'.repeat(32),
    privateMid = 'u' + 'b'.repeat(32);
  const requests = [];
  const transport = new DaemonTransport(
    { daemonUrl: 'http://127.0.0.1:23380', daemonToken: 'test' },
    async (url) => {
      requests.push(new URL(url).pathname);
      return new Response(
        JSON.stringify(
          url.endsWith('/v1/info')
            ? {
                openchat: {
                  status: 'connected',
                  accountFingerprint: 'a'.repeat(64),
                  allowedChatIDs: [mid],
                },
              }
            : {
                items: [
                  { id: mid, title: 'Allowed', isOpenChat: true },
                  { id: privateMid, title: 'Private', isOpenChat: true },
                ],
              },
        ),
      );
    },
  );
  const result = await transport.list();
  assert.deepEqual(
    result.rooms.map((r) => r.id),
    [mid],
  );
  assert.deepEqual(requests, ['/v1/info', '/v1/openchat/chats']);
  await assert.rejects(transport.messages(privateMid, '0:'), /not authorized/);
  await assert.rejects(
    transport.send({ chatId: privateMid, text: 'x', requestId: 'x' }),
    /not authorized/,
  );
  assert.equal(requests.length, 2);
});

test('a server cannot expand the locally selected room list', async (t) => {
  const f = fixture(t);
  const fetcher = async (url, options) => {
    if (url.endsWith('/heartbeat'))
      return new Response(
        JSON.stringify({
          success: true,
          data: { rooms: [{ id: 'foreign', external_id: 'm' + 'b'.repeat(32), enabled: 1 }] },
        }),
      );
    return f.fetcher(url, options);
  };
  const c = new Connector(f.config, f.transport, fetcher);
  await c.heartbeat();
  assert.deepEqual(c.allowed, []);
});

test('idle polls do not rewrite unchanged cursors and failed checkpoints are retried',async t=>{
 const f=fixture(t);f.job=null;f.transport.messages=async()=>({messages:[],cursor:'stable',hasMore:false});
 let writes=0,fail=true;const state={async get(){return null},async put(key){if(key.startsWith('cursor/')){writes++;if(fail){fail=false;throw Error('checkpoint unavailable')}}}};
 const c=new Connector(f.config,f.transport,f.fetcher,state);
 await assert.rejects(c.tick(),/checkpoint unavailable/);
 await c.tick();await c.tick();await c.tick();assert.equal(writes,2);
});
test('unchanged room discovery sends only a heartbeat, while changes resend candidates',async t=>{
 const f=fixture(t);const payloads=[];const fetcher=async(url,options)=>{if(url.endsWith('/heartbeat'))payloads.push(JSON.parse(options.body).rooms);return f.fetcher(url,options)};
 const c=new Connector(f.config,f.transport,fetcher);
 await c.heartbeat();await c.heartbeat();
 assert.equal(payloads[0].length,1);assert.equal(payloads[1].length,0);
 f.transport.list=async()=>({rooms:[{id:'m'+'a'.repeat(32),title:'Renamed'}],accountFingerprint:'a'.repeat(64),accountName:'Owner'});
 await c.heartbeat();assert.equal(payloads[2][0].title,'Renamed');
});
test('no selected rooms means no send-queue polling',async t=>{
 const f=fixture(t);f.job=null;f.transport.list=async()=>({rooms:[],accountFingerprint:'a'.repeat(64),accountName:'Owner'});
 let claims=0;const fetcher=async(url,options)=>{if(url.endsWith('/jobs/claim'))claims++;return f.fetcher(url,options)};
 const c=new Connector(f.config,f.transport,fetcher);await c.tick();assert.equal(claims,0);
});


test('an evicted worker does not rewrite the restored unchanged cursor',async t=>{
 const f=fixture(t);f.job=null;
 const enabledAt=new Date(Date.now()-10000).toISOString();
 const saved={enabledAt,startedAt:Date.parse(enabledAt),cursor:'stable',initializing:false};
 let writes=0;
 const persistence={async get(k){return k==='cursor/room1'?structuredClone(saved):null},async put(k){if(k.startsWith('cursor/'))writes++}};
 f.transport.messages=async()=>({messages:[],cursor:'stable',hasMore:false});
 const c=new Connector(f.config,f.transport,f.fetcher,persistence);
 c.allowed=[{id:'room1',external_id:'m'+'a'.repeat(32),enabled_at:enabledAt}];
 await c.sync();assert.equal(writes,0);
});
