import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {ManagedRuntime,createRuntimeServer} from './server.mjs';
const tick=()=>new Promise(r=>setTimeout(r,10));
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'oc-managed-'));const values=new Map();const store={async get(k){return structuredClone(values.get(k)??null)},async put(k,v){values.set(k,structuredClone(v));return true},async getReceipt(k){return this.get('receipt/'+k)},async putReceipt(k,v){return this.put('receipt/'+k,v)}};let finish;
 const factory=storage=>{const handlers={};const client={profile:{mid:'uself',displayName:'Owner'},on(name,fn){handlers[name]=fn},loginProcess:{async login(options){if(options.qr){handlers.qrcall('line://test-qr');await new Promise(resolve=>{finish=async()=>{await storage.set('authToken','PRIVATE_AUTH_TOKEN');handlers['update:authtoken']('PRIVATE_AUTH_TOKEN');resolve()}})}else if(options.authToken!=='PRIVATE_AUTH_TOKEN')throw Object.assign(Error('auth'),{code:'AUTH_REQUIRED'})}},talk:{async getAllContactIds(){return []},async getAllChatMids(){return {memberChatMids:[]}}},square:{async fetchMyEvents(){return {events:[]}}}};return client};
 const runtime=new ManagedRuntime({store,stateDir:dir,clientFactory:factory,fetcher:async url=>new Response(JSON.stringify({success:true,data:url.endsWith('/heartbeat')?{rooms:[]}:{job:null}}))});t.after(async()=>{await runtime.stop();fs.rmSync(dir,{recursive:true,force:true})});return {runtime,store,values,finish:()=>finish()}}
test('web QR flow exposes no reusable LINE authentication token',async t=>{const x=setup(t);await x.runtime.bootstrap({harnessUrl:'https://tenant.example',connectorToken:'oc_'+'a'.repeat(64)});assert.equal(x.runtime.status().phase,'auth_required');await x.runtime.startLogin();for(let n=0;n<100&&x.runtime.status().phase!=='awaiting_qr';n++)await tick();assert.match(x.runtime.status().qrImage,/^data:image\/png;base64,/);await x.finish();for(let n=0;n<100&&x.runtime.status().phase!=='connected';n++)await tick();assert.equal(x.runtime.status().phase,'connected');assert.equal(x.values.get('session').authToken,'PRIVATE_AUTH_TOKEN');assert.ok(!JSON.stringify(x.runtime.status()).includes('PRIVATE_AUTH_TOKEN'));assert.ok(!x.runtime.status().qrImage)});
test('restores authentication from durable storage instead of requiring a user device',async t=>{const x=setup(t);await x.store.put('session',{authToken:'PRIVATE_AUTH_TOKEN'});await x.runtime.bootstrap({harnessUrl:'https://tenant.example',connectorToken:'oc_'+'a'.repeat(64)});for(let n=0;n<100&&x.runtime.status().phase!=='connected';n++)await tick();assert.equal(x.runtime.status().phase,'connected')});
test('RPC cannot leave the allowed room list',async t=>{const x=setup(t);x.runtime.phase='connected';await assert.rejects(x.runtime.rpc('send',{chatID:'mforeign'},new Set(['mallowed'])),/CHAT_NOT_ALLOWED/);await assert.rejects(x.runtime.rpc('createAccount',{},new Set()),/UNKNOWN_METHOD/)});
test('runtime HTTP requires its per-connection credential',async t=>{const x=setup(t);const token='rt_'+'a'.repeat(64);const server=createRuntimeServer(x.runtime,token);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const url='http://127.0.0.1:'+server.address().port;assert.equal((await fetch(url+'/status')).status,401);const response=await fetch(url+'/status',{headers:{Authorization:'Bearer '+token}});assert.equal(response.status,200);assert.ok(!JSON.stringify(await response.json()).includes(token))});
test('failed durable bootstrap can be retried without replacing the runtime',async t=>{const x=setup(t);const read=x.store.get.bind(x.store);let failed=false;x.store.get=async k=>{if(!failed){failed=true;throw Error('STATE_UNAVAILABLE')}return read(k)};const config={harnessUrl:'https://tenant.example',connectorToken:'oc_'+'a'.repeat(64)};await assert.rejects(x.runtime.bootstrap(config),/STATE_UNAVAILABLE/);assert.equal(x.runtime.config,null);await x.runtime.bootstrap(config);assert.equal(x.runtime.status().phase,'auth_required')});

test('approved creation is idempotent and binds retries to the exact room definition',async t=>{
 const x=setup(t);x.runtime.phase='connected';let creates=0;
 x.runtime.client={square:{async createSquare(options){creates++;assert.equal(options.searchable,false);return {square:{mid:'s'+'a'.repeat(32)},squareChat:{squareChatMid:'m'+'b'.repeat(32)}}}}};
 const input={operationId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',name:'Owned test room',displayName:'運営AI',description:'Test',approved:true};
 const result=await Promise.all([x.runtime.createRoom(input),x.runtime.createRoom(input)]);assert.equal(creates,1);assert.equal(result[0].chatMid,result[1].chatMid);
 await assert.rejects(x.runtime.createRoom({...input,name:'Different'}),/REQUEST_ID_CONFLICT/);
});
test('uncertain creation is never automatically repeated',async t=>{
 const x=setup(t);x.runtime.phase='connected';let creates=0;x.runtime.client={square:{async createSquare(){creates++;throw Error('lost response')}}};
 const input={operationId:'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff',name:'Owned test room',displayName:'運営AI',description:'Test',approved:true};
 await assert.rejects(x.runtime.createRoom(input),/CREATE_OUTCOME_UNKNOWN/);await assert.rejects(x.runtime.createRoom(input),/CREATE_OUTCOME_UNKNOWN/);assert.equal(creates,1);
});

test('discovers already joined rooms from membership events, excluding message payloads',async t=>{
 const x=setup(t);await x.store.put('session',{authToken:'PRIVATE_AUTH_TOKEN'});await x.runtime.bootstrap({harnessUrl:'https://tenant.example',connectorToken:'oc_'+'a'.repeat(64)});await x.runtime.authTask;await x.runtime.stopEngine();
 const a='m'+'a'.repeat(32),b='m'+'b'.repeat(32);let calls=0;
 x.runtime.client.square.fetchMyEvents=async options=>{calls++;return options.continuationToken?{events:[{payload:{notifiedCreateSquareChatMember:{chat:{squareChatMid:b,state:'ALIVE'}}}}]}:{events:[{payload:{notifiedCreateSquareChatMember:{chat:{squareChatMid:a,state:'ALIVE'}}}},{payload:{notificationMessage:{squareChatMid:'m'+'c'.repeat(32),text:'ignored'}}}],continuationToken:'next'}};
 x.runtime.discoveredAt=0;assert.deepEqual(await x.runtime.discover(),[a,b]);assert.equal(calls,2);
});
test('incomplete discovery fails without clearing the last successful room list',async t=>{
 const x=setup(t);x.runtime.discovered=['m'+'a'.repeat(32)];x.runtime.client={square:{async fetchMyEvents(){return {events:[],continuationToken:'repeated'}}}};
 await assert.rejects(x.runtime.discover(),/OPENCHAT_DISCOVERY_INCOMPLETE/);assert.equal(x.runtime.discovered.length,1);
});

test('worker thread registry is checkpointed and restored across runtime eviction',async t=>{
 const x=setup(t);x.runtime.scheduled=true;await x.store.put('session',{authToken:'PRIVATE_AUTH_TOKEN'});
 const config={harnessUrl:'https://tenant.example',connectorToken:'oc_'+'a'.repeat(64)};
 await x.runtime.bootstrap(config);await x.runtime.authTask;
 const registry={'tchild':{id:'tchild',parentID:'mparent',title:'Thread'}};
 x.runtime.bridge={async dispatch(){fs.writeFileSync(x.runtime.dir+'/registry.json',JSON.stringify(registry));return {events:[]}}};
 await x.runtime.dispatch('events',{});assert.deepEqual(x.values.get('registry'),registry);await x.runtime.stop();
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'oc-worker-restore-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const restored=new ManagedRuntime({scheduled:true,store:x.store,stateDir:dir,clientFactory:x.runtime.clientFactory,fetcher:x.runtime.fetcher});
 await restored.bootstrap(config);await restored.authTask;
 assert.deepEqual(JSON.parse(fs.readFileSync(dir+'/registry.json','utf8')),registry);await restored.stop();
});

test('thread metadata hints cannot escape the authorized parent rooms',async t=>{
 const x=setup(t);x.runtime.phase='connected';
 await assert.rejects(x.runtime.rpc('list',{threads:[{id:'t'+'a'.repeat(32),parentID:'m'+'b'.repeat(32)}]},new Set(['m'+'c'.repeat(32)])),/CHAT_NOT_ALLOWED/);
});

test('creation lookup obtains a validated invitation without creating or retrying a room',async t=>{
 const x=setup(t),operationId='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';x.runtime.phase='connected';let creates=0,reads=0;
 x.runtime.client={square:{async createSquare(){creates++;throw Error('must not create')},async getInvitationTicketUrl(input){reads++;assert.equal(input.request.mid,'s'+'a'.repeat(32));return {invitationURL:'https://line.me/ti/g2/fixture'}}}};
 await x.store.putReceipt('create-room:'+operationId,{status:'done',hash:'fixture',result:{squareMid:'s'+'a'.repeat(32),chatMid:'m'+'b'.repeat(32),name:'Fixture'}});
 assert.equal((await x.runtime.creationStatus({operationId})).invitationUrl,'https://line.me/ti/g2/fixture');
 assert.equal((await x.runtime.creationStatus({operationId})).invitationStatus,'available');assert.equal(creates,0);assert.equal(reads,2);
 x.runtime.client.square.getInvitationTicketUrl=async()=>({invitationURL:'https://evil.example/join'});
 assert.equal((await x.runtime.creationStatus({operationId})).invitationStatus,'unavailable');
 await x.store.putReceipt('create-room:'+operationId,{status:'pending',hash:'fixture'});
 assert.deepEqual(await x.runtime.creationStatus({operationId}),{status:'unknown'});assert.equal(creates,0);
});
