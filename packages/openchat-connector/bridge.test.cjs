const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  os = require('os'),
  path = require('path');
const { createBridge } = require('./bridge.cjs');
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchat-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = { sessionPath: dir + '/session.json', stateDir: dir, chatIDs: ['mroom'] };
  fs.writeFileSync(config.sessionPath, JSON.stringify({ authToken: 'test' }));
  let sends = 0,
    uploads = 0;
  let incoming = [];
  const fake = {
    on() {},
    loginProcess: { async login() {} },
    getReqseq: async () => 1,
    square: {
      getSquareChat: async () => ({
        squareChat: { squareChatMid: 'mroom', squareMid: 'ssquare', name: 'Test', state: 'ALIVE' },
        squareChatMember: { squareMemberMid: 'pself' },
      }),
      getSquareMember: async () => ({ squareMember: { displayName: 'Me' } }),
      fetchSquareChatEvents: async () => ({ events: incoming, syncToken: 'next' }),
      sendMessage: async (p) => {
        sends++;
        return {
          createdSquareMessage: {
            message: {
              id: '123',
              from: 'pself',
              to: p.squareChatMid,
              createdTime: 1000,
              text: p.text,
              contentType: 'NONE',
            },
          },
        };
      },
    },
    obs: {
      uploadObjTalk: async () => {
        uploads++;
        return { objId: '456', objHash: 'hash' };
      },
    },
  };
  return {
    config,
    fake,
    bridge: createBridge(config, fake),
    get sends() {
      return sends;
    },
    get uploads() {
      return uploads;
    },
    set incoming(x) {
      incoming = x;
    },
  };
}
test('replayed request is delivered once; changed payload is rejected', async (t) => {
  const x = setup(t);
  await x.bridge.dispatch('list');
  const p = { chatID: 'mroom', text: 'hello', requestID: 'queue:1' };
  await x.bridge.dispatch('send', p);
  await x.bridge.dispatch('send', p);
  assert.equal(x.sends, 1);
  await assert.rejects(x.bridge.dispatch('send', { ...p, text: 'changed' }), /REQUEST_ID_CONFLICT/);
  assert.equal(x.sends, 1);
});
test('uncertain send survives process restart without automatic resending', async (t) => {
  const x = setup(t);
  await x.bridge.dispatch('list');
  let attempts = 0;
  x.fake.square.sendMessage = async () => {
    attempts++;
    throw Error('network lost');
  };
  const p = { chatID: 'mroom', text: 'hello', requestID: 'queue:2' };
  await assert.rejects(x.bridge.dispatch('send', p), /SEND_OUTCOME_UNKNOWN/);
  const restarted = createBridge(x.config, x.fake);
  await assert.rejects(restarted.dispatch('send', p), /SEND_OUTCOME_UNKNOWN/);
  assert.equal(attempts, 1);
});
test('own phone messages relay, bridge-origin messages do not', async (t) => {
  const x = setup(t);
  await x.bridge.dispatch('list');
  await x.bridge.dispatch('send', { chatID: 'mroom', text: 'sent', requestID: 'queue:3' });
  x.incoming = ['123', '999'].map((id) => ({
    type: 'SEND_MESSAGE',
    payload: {
      sendMessage: {
        squareMessage: {
          message: { id, from: 'pself', createdTime: 1000, text: 'a', contentType: 'NONE' },
        },
      },
    },
  }));
  const r = await x.bridge.dispatch('events', { chatID: 'mroom' });
  assert.deepEqual(
    r.messages.map((m) => [m.id, m.isSender, m.outbound]),
    [
      ['123', true, true],
      ['999', true, false],
    ],
  );
});
test('unregistered chats and cross-parent threads cannot be sent to', async (t) => {
  const x = setup(t);
  await assert.rejects(
    x.bridge.dispatch('send', { chatID: 'mother', text: 'x', requestID: 'queue:4' }),
    /CHAT_NOT_ALLOWED/,
  );
  await x.bridge.dispatch('list');
  x.fake.square.getSquareThread = async () => ({ squareThread: { chatMid: 'mother' } });
  x.incoming = [{ payload: { notifiedUpdateThread: { threadMid: 'tother' } } }];
  await x.bridge.dispatch('events', { chatID: 'mroom' });
  await assert.rejects(
    x.bridge.dispatch('send', { chatID: 'tother', text: 'x', requestID: 'queue:4' }),
    /CHAT_NOT_ALLOWED/,
  );
  assert.equal(x.sends, 0);
});
test('media retry does not upload again when caption outcome is unknown', async (t) => {
  const x = setup(t);
  await x.bridge.dispatch('list');
  x.fake.square.sendMessage = async () => {
    throw Error('network');
  };
  const p = {
    chatID: 'mroom',
    kind: 'file',
    data: Buffer.from('a').toString('base64'),
    filename: 'test.txt',
    mimeType: 'text/plain',
    text: 'caption',
    requestID: 'queue:5',
  };
  await assert.rejects(x.bridge.dispatch('sendMedia', p), /SEND_OUTCOME_UNKNOWN/);
  await assert.rejects(x.bridge.dispatch('sendMedia', p), /SEND_OUTCOME_UNKNOWN/);
  assert.equal(x.uploads, 1);
});

test('thread candidates never expose parent message content', async (t) => {
  const x = setup(t);
  await x.bridge.dispatch('list');
  x.fake.square.getSquareThread = async () => ({
    squareThread: { chatMid: 'mroom' },
    rootMessage: { message: { text: 'PRIVATE ROOT TEXT' } },
  });
  x.incoming = [{ payload: { notifiedUpdateThread: { threadMid: 'tabcdef' } } }];
  await x.bridge.dispatch('events', { chatID: 'mroom' });
  const result = await x.bridge.dispatch('list');
  assert.equal(result.chats.length, 2);
  assert.ok(!JSON.stringify(result).includes('PRIVATE ROOT TEXT'));
});

test('non-message notifications do not replay older message snapshots', async (t) => {
  const x = setup(t);
  await x.bridge.dispatch('list');
  const payload = {
    sendMessage: {
      squareMessage: {
        message: { id: '321', from: 'pself', createdTime: 1000, text: 'old', contentType: 'NONE' },
      },
    },
  };
  x.incoming = [{ type: 'NOTIFIED_UPDATE_MESSAGE_STATUS', payload }];
  const r = await x.bridge.dispatch('events', { chatID: 'mroom' });
  assert.equal(r.messages.length, 0);
});

test('managed receipt survives replacement of the entire ephemeral filesystem', async t=>{
 const x=setup(t),saved=new Map();const durable={getReceipt:async id=>saved.get(id),putReceipt:async(id,value)=>saved.set(id,structuredClone(value))};
 const first=createBridge(x.config,x.fake,durable),p={chatID:'mroom',text:'durable',requestID:'cloud:1'};
 await first.dispatch('send',p);
 fs.rmSync(x.config.stateDir+'/receipts.json');
 const restarted=createBridge(x.config,x.fake,durable);
 await restarted.dispatch('send',p);assert.equal(x.sends,1);
});
test('durable checkpoint failure prevents the external send',async t=>{
 const x=setup(t),bridge=createBridge(x.config,x.fake,{getReceipt:async()=>null,putReceipt:async()=>{throw Error('STATE_UNAVAILABLE')}});
 await assert.rejects(bridge.dispatch('send',{chatID:'mroom',text:'x',requestID:'cloud:2'}),/STATE_UNAVAILABLE/);assert.equal(x.sends,0);
});

test('known thread metadata can be restored without reading its root message',async t=>{
 const x=setup(t);let checks=0;x.fake.square.getSquareThread=async p=>{checks++;assert.equal(p.request.includeRootMessage,false);return {squareThread:{chatMid:'mroom'}}};
 const r=await x.bridge.dispatch('list',{threads:[{id:'tabcdef',parentID:'mroom'}]});assert.ok(r.chats.some(c=>c.id==='tabcdef'));assert.equal(checks,1);assert.equal(x.sends,0);
 x.fake.square.getSquareThread=async()=>({squareThread:{chatMid:'mother'}});
 await assert.rejects(x.bridge.dispatch('list',{threads:[{id:'tforeign',parentID:'mroom'}]}),/THREAD_PARENT_MISMATCH/);
});
