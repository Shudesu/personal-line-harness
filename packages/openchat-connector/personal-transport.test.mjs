import test from 'node:test';
import assert from 'node:assert/strict';
import { PersonalTransport } from './personal-transport.mjs';
const self='u'+'1'.repeat(32), peer='u'+'2'.repeat(32), group='c'+'3'.repeat(32);
function setup(){
 const receipts=new Map();let sent=0, read=0;
 const client={profile:{mid:self,displayName:'Owner'},e2ee:{async decryptE2EEMessage(m){return m}},talk:{
  async getAllContactIds(){return [peer]},async getContacts(){return [{mid:peer,displayName:'Friend'}]},
  async getAllChatMids(){return {memberChatMids:[group],invitedChatMids:['c'+'4'.repeat(32)]}},
  async getChats(){return {chats:[{chatMid:group,chatName:'Team'}]}},
  async getRecentMessagesV2(){read++;return []},
  async sendMessage(p){sent++;assert.equal(p.e2ee,true);return {id:'42'}}
 }};
 const store={async getReceipt(k){return receipts.get(k)},async putReceipt(k,v){receipts.set(k,v)}};
 return {client,store,transport:new PersonalTransport(client,store,{salt:'private-test-salt'}),get sent(){return sent},get read(){return read}};
}
const message=(id,extra={})=>({id,from:peer,to:self,text:'hello',createdTime:1000,deliveredTime:1000,contentType:'NONE',...extra});
test('discovery includes direct and joined group candidates without reading messages',async()=>{
 const x=setup();const r=await x.transport.list();assert.deepEqual(r.rooms.map(r=>r.kind),['personal','personal_group']);assert.equal(x.read,0);assert.equal(r.rooms.length,2);
 await assert.rejects(x.transport.messages('u'+'9'.repeat(32),''),/CHAT_NOT_ALLOWED/);
});
test('first sync preserves new messages since opt-in and never imports older history',async()=>{
 const x=setup();await x.transport.list();x.client.talk.getRecentMessagesV2=async()=>[message('2',{createdTime:2000}),message('1',{createdTime:1000})];
 const r=await x.transport.messages(peer,'',1500);assert.deepEqual(r.messages.map(m=>m.id),['2']);assert.equal(r.cursor,'2');
});
test('decrypts selected chats and fails closed on a message from another conversation',async()=>{
 const x=setup();await x.transport.list();let decrypt=0;
 x.client.e2ee.decryptE2EEMessage=async m=>{decrypt++;return {...m,text:'decoded'}};
 x.client.talk.getRecentMessagesV2=async()=>[message('9007199254740994',{chunks:['cipher']}),message('9007199254740993')];
 const r=await x.transport.messages(peer,'9007199254740993');assert.equal(r.cursor,'9007199254740994');assert.equal(r.messages[0].text,'decoded');assert.equal(decrypt,1);
 x.client.talk.getRecentMessagesV2=async()=>[message('9007199254740995',{from:'u'+'9'.repeat(32)})];
 await assert.rejects(x.transport.messages(peer,r.cursor),/MESSAGE_ROOM_MISMATCH/);assert.equal(decrypt,1);
});
test('paginates a backlog beyond the first 100 without advancing across missing pages',async()=>{
 const x=setup();await x.transport.list();x.client.talk.getRecentMessagesV2=async()=>Array.from({length:100},(_,i)=>message(String(201-i)));
 x.client.talk.getPreviousMessagesV2WithRequest=async p=>{assert.equal(p.request.endMessageId.messageId,'102');return [message('101'),message('100')]};
 const r=await x.transport.messages(peer,'100');assert.equal(r.messages.length,101);assert.equal(r.cursor,'201');
 x.client.talk.getPreviousMessagesV2WithRequest=async()=>{throw Error('network')};await assert.rejects(x.transport.messages(peer,'100'),/network/);
});
test('a completed send is idempotent and a changed payload cannot reuse its request ID',async()=>{
 const x=setup();await x.transport.list();const job={chatId:peer,text:'hello',requestId:'job:1'};
 assert.deepEqual(await x.transport.send(job),['42']);assert.deepEqual(await x.transport.send(job),['42']);assert.equal(x.sent,1);
 await assert.rejects(x.transport.send({...job,text:'different'}),/REQUEST_ID_CONFLICT/);
});
test('a lost response is never resent, including after a runtime restart',async()=>{
 const x=setup();await x.transport.list();let calls=0;x.client.talk.sendMessage=async()=>{calls++;throw Error('lost')};
 const job={chatId:group,text:'hello',requestId:'job:2'};await assert.rejects(x.transport.send(job),/SEND_OUTCOME_UNKNOWN/);
 const again=new PersonalTransport(x.client,x.store,{salt:'private-test-salt'});await again.list();await assert.rejects(again.send(job),/SEND_OUTCOME_UNKNOWN/);assert.equal(calls,1);
});
test('durable storage failure and unsupported attachments prevent any transmission',async()=>{
 const x=setup();await x.transport.list();const job={chatId:peer,text:'hello',requestId:'job:3'};
 await assert.rejects(x.transport.send(job,{data:'image'}),/PERSONAL_MEDIA_UNSUPPORTED/);
 x.store.putReceipt=async()=>{throw Error('storage unavailable')};await assert.rejects(x.transport.send(job),/storage unavailable/);assert.equal(x.sent,0);
});

test('concurrent requests with the same identity send only once',async()=>{
 const x=setup();await x.transport.list();const job={chatId:peer,text:'hello',requestId:'parallel:1'};
 const result=await Promise.all([x.transport.send(job),x.transport.send(job)]);
 assert.deepEqual(result,[['42'],['42']]);assert.equal(x.sent,1);
});
