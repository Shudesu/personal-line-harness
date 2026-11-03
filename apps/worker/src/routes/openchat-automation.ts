import { Hono } from 'hono';
import type { Env } from '../index.js';
import { requireRole } from '../middleware/role-guard.js';

type Policy={id:string;connector_id:string;room_id:string;name:string;kind:'schedule'|'ai_reply';config:string;daily_limit:number;status:string;revision:number;enabled_at:string|null;consent_version:string|null};
const now=()=>new Date().toISOString();
const digest=async(text:string)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(x=>x.toString(16).padStart(2,'0')).join('');
const owner=requireRole('owner','admin');
const configured=(env:Env['Bindings'])=>env.OPENCHAT_AUTOMATION_ENABLED==='true';
const aiConfigured=(env:Env['Bindings'])=>configured(env)&&!!(env.OPENCHAT_AI_URL&&env.OPENCHAT_MANAGED_SECRET&&env.OPENCHAT_TENANT_ID);
export const openchatAutomation=new Hono<Env>();
openchatAutomation.onError((_e,c)=>c.json({success:false,error:'自動運用を確認できません。状態を再確認してください。'},503));
const fail=(c:any,error:string,status=400)=>c.json({success:false,error},status);
const ok=(c:any,data:unknown)=>c.json({success:true,data},200,{'Cache-Control':'no-store'});
function validated(body:any){
 if(!body||typeof body.name!=='string'||!body.name.trim()||body.name.length>100||!['schedule','ai_reply'].includes(body.kind))throw Error('invalid_policy');
 const limit=body.dailyLimit;if(!Number.isInteger(limit)||limit<1||limit>(body.kind==='ai_reply'?10:100))throw Error('invalid_limit');
 const c=body.config;if(!c||typeof c!=='object')throw Error('invalid_config');
 if(body.kind==='schedule'){
  if(typeof c.text!=='string'||!c.text.trim()||new TextEncoder().encode(c.text).length>5000||!Number.isInteger(c.intervalMinutes)||c.intervalMinutes<5||c.intervalMinutes>43200||!Number.isFinite(Date.parse(c.startAt)))throw Error('invalid_schedule');
  return {name:body.name.trim(),kind:body.kind,dailyLimit:limit,config:{text:c.text,intervalMinutes:c.intervalMinutes,startAt:new Date(c.startAt).toISOString()}};
 }
 if(typeof c.guide!=='string'||!c.guide.trim()||c.guide.length>4000||typeof c.trigger!=='string'||!c.trigger.trim()||c.trigger.length>40||!Number.isInteger(c.maxAgeMinutes)||c.maxAgeMinutes<1||c.maxAgeMinutes>60)throw Error('invalid_ai_rule');
 return {name:body.name.trim(),kind:body.kind,dailyLimit:limit,config:{guide:c.guide,trigger:c.trigger.trim(),maxAgeMinutes:c.maxAgeMinutes}};
}
async function target(env:Env['Bindings'],id:string){
 return env.DB.prepare("SELECT r.id,r.connector_id,r.kind,r.enabled,c.enabled AS connector_enabled,c.mode FROM openchat_rooms r JOIN openchat_connectors c ON c.id=r.connector_id WHERE r.id=?").bind(id).first<{id:string;connector_id:string;kind:string;enabled:number;connector_enabled:number;mode:string}>();
}
openchatAutomation.get('/api/openchat/automation',owner,async c=>{
 const room=c.req.query('room')||'';
 const rows=await c.env.DB.prepare('SELECT * FROM openchat_automation_policies WHERE room_id=? ORDER BY created_at DESC').bind(room).all<Policy>();
 const runs=await c.env.DB.prepare('SELECT r.*,o.state AS delivery_state FROM openchat_automation_runs r JOIN openchat_automation_policies p ON p.id=r.policy_id LEFT JOIN openchat_outbox o ON o.id=r.outbox_id WHERE p.room_id=? ORDER BY r.created_at DESC LIMIT 30').bind(room).all();
 return ok(c,{available:configured(c.env),aiAvailable:aiConfigured(c.env),policies:rows.results.map(p=>({...p,config:JSON.parse(p.config)})),runs:runs.results});
});
openchatAutomation.post('/api/openchat/automation',owner,async c=>{
 if(!configured(c.env))return fail(c,'自動運用はこの環境では準備中です',409);
 const b=await c.req.json();let v;try{v=validated(b)}catch{return fail(c,'名前・文面・間隔・上限を確認してください')}
 const room=await target(c.env,b.roomId);
 if(!room||!['room','thread'].includes(room.kind)||!room.enabled||!room.connector_enabled)return fail(c,'連携中のオプチャを選んでください',409);
 const count=await c.env.DB.prepare('SELECT count(*) n FROM openchat_automation_policies WHERE connector_id=? AND status<>?').bind(room.connector_id,'paused').first<{n:number}>();
 if((count?.n||0)>=10)return fail(c,'1接続の運用ルールは10件までです',409);
 const id=crypto.randomUUID(),at=now();
 await c.env.DB.prepare("INSERT INTO openchat_automation_policies(id,connector_id,room_id,name,kind,config,daily_limit,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
  .bind(id,room.connector_id,room.id,v.name,v.kind,JSON.stringify(v.config),v.dailyLimit,at,at).run();
 return ok(c,{id,status:'draft',revision:1});
});
openchatAutomation.post('/api/openchat/automation/:id/start',owner,async c=>{
 const b=await c.req.json();const p=await c.env.DB.prepare('SELECT * FROM openchat_automation_policies WHERE id=?').bind(c.req.param('id')).first<Policy>();
 if(!configured(c.env)||!p)return fail(c,'運用ルールを確認できません',409);
 if(b.approved!==true||b.revision!==p.revision)return fail(c,'現在の運用ルールを確認してから開始してください',409);
 if(p.kind==='ai_reply'&&(!aiConfigured(c.env)||b.consent!=='openchat_automatic_ai_reply'))return fail(c,'AI返信の利用設定と会話データの送信同意が必要です',409);
 const room=await target(c.env,p.room_id);if(!room?.enabled||!room.connector_enabled)return fail(c,'接続と会話を有効にしてください',409);
 const at=now();
 if(p.status==='active')return ok(c,{id:p.id,status:'active',revision:p.revision});
 const started=await c.env.DB.prepare("UPDATE openchat_automation_policies SET status='active',enabled_at=?,approved_by=?,updated_at=?,consent_version=? WHERE id=? AND revision=? AND status IN ('draft','paused') AND (SELECT count(*) FROM openchat_automation_policies WHERE connector_id=? AND status='active')<10 AND (kind<>'ai_reply' OR NOT EXISTS(SELECT 1 FROM openchat_automation_policies other WHERE other.room_id=? AND other.kind='ai_reply' AND other.status='active' AND other.id<>?))")
  .bind(at,c.get('staff').id,at,p.kind==='ai_reply'?'openchat_automatic_ai_reply_v1':'openchat_schedule_v1',p.id,p.revision,p.connector_id,p.room_id,p.id).run();
  if(!started.meta.changes)return fail(c,'同時運用は1接続10件、AI返信は1部屋1件です。既存ルールを確認してください',409);
 return ok(c,{id:p.id,status:'active',revision:p.revision});
});
openchatAutomation.post('/api/openchat/automation/:id/pause',owner,async c=>{
 const id=c.req.param('id'),at=now();
 await c.env.DB.batch([
  c.env.DB.prepare("UPDATE openchat_automation_policies SET status='paused',revision=revision+1,updated_at=? WHERE id=? AND status<>'paused'").bind(at,id),
  c.env.DB.prepare("UPDATE openchat_outbox SET state='failed',error='automation_stopped',updated_at=? WHERE automation_id=? AND state='queued'").bind(at,id),
 ]);
 return ok(c,{status:'paused',inFlightMayComplete:true});
});

async function reserve(env:Env['Bindings'],p:Policy,key:string){
 const id=crypto.randomUUID(),at=now(),day=at.slice(0,10);
 const row=await env.DB.prepare(`INSERT INTO openchat_automation_runs(id,policy_id,policy_revision,source_key,day,status,created_at)
  SELECT ?,?,?,?,?, 'reserved',? WHERE EXISTS(SELECT 1 FROM openchat_automation_policies p JOIN openchat_rooms r ON r.id=p.room_id JOIN openchat_connectors c ON c.id=p.connector_id WHERE p.id=? AND p.status='active' AND p.revision=? AND r.enabled=1 AND c.enabled=1)
  AND (SELECT count(*) FROM openchat_automation_runs WHERE policy_id=? AND day=?)<?
  AND (?<>'ai_reply' OR NOT EXISTS(SELECT 1 FROM openchat_automation_runs WHERE policy_id=? AND created_at>?))
  AND (?<>'schedule' OR NOT EXISTS(SELECT 1 FROM openchat_automation_runs prior JOIN openchat_outbox o ON o.id=prior.outbox_id WHERE prior.policy_id=? AND prior.source_key=? AND o.state IN ('sent','leased','unknown')))
  ON CONFLICT(policy_id,policy_revision,source_key) DO NOTHING RETURNING id`)
  .bind(id,p.id,p.revision,key,day,at,p.id,p.revision,p.id,day,p.daily_limit,p.kind,p.id,new Date(Date.now()-60000).toISOString(),p.kind,p.id,key).first();
 return row?id:null;
}
async function finish(env:Env['Bindings'],run:string,status:string,error:string|null=null){await env.DB.prepare('UPDATE openchat_automation_runs SET status=?,error_code=? WHERE id=?').bind(status,error,run).run()}
async function queue(env:Env['Bindings'],p:Policy,run:string,text:string){
 if(!text.trim()||new TextEncoder().encode(text).length>5000){await finish(env,run,'handoff','output_unavailable');return}
 const id=await digest('automation:'+run),at=now(),hash=await digest(JSON.stringify({room:p.room_id,text,media:null}));
 const row=await env.DB.prepare(`INSERT INTO openchat_outbox(id,connector_id,room_id,request_id,body_hash,body,created_at,created_by,updated_at,automation_id,automation_revision)
  SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM openchat_automation_policies p JOIN openchat_rooms r ON r.id=p.room_id JOIN openchat_connectors c ON c.id=p.connector_id WHERE p.id=? AND p.status='active' AND p.revision=? AND r.enabled=1 AND c.enabled=1)
  AND EXISTS(SELECT 1 FROM openchat_automation_runs WHERE id=? AND status='reserved')
  ON CONFLICT(connector_id,request_id) DO NOTHING RETURNING id`)
  .bind(id,p.connector_id,p.room_id,'auto:'+run,hash,text,at,'automation',at,p.id,p.revision,p.id,p.revision,run).first();
 await env.DB.prepare('UPDATE openchat_automation_runs SET status=?,outbox_id=? WHERE id=?').bind(row?'queued':'cancelled',row?id:null,run).run();
}

/** One reserved generation/announcement per polling turn, after owner approval. */
export async function runOpenchatAutomations(env:Env['Bindings'],connector:string){
 if(!configured(env))return;
 await env.DB.prepare("UPDATE openchat_automation_runs SET status='handoff',error_code='preparation_interrupted' WHERE status='reserved' AND created_at<? AND policy_id IN (SELECT id FROM openchat_automation_policies WHERE connector_id=?)").bind(new Date(Date.now()-90000).toISOString(),connector).run();
 const policies=await env.DB.prepare("SELECT p.* FROM openchat_automation_policies p JOIN openchat_rooms r ON r.id=p.room_id JOIN openchat_connectors c ON c.id=p.connector_id WHERE p.connector_id=? AND p.status='active' AND r.enabled=1 AND c.enabled=1 ORDER BY p.created_at LIMIT 10").bind(connector).all<Policy>();
 for(const p of policies.results){
  if(p.consent_version!==(p.kind==='ai_reply'?'openchat_automatic_ai_reply_v1':'openchat_schedule_v1'))continue;
  const config=JSON.parse(p.config),time=Date.now();let key:string;let prompt:{role:'user'|'assistant';text:string}[]=[];
  if(p.kind==='schedule'){
   const first=Math.max(Date.parse(config.startAt),Date.parse(p.enabled_at||''));if(time<first||!Number.isFinite(first))continue;
   key='schedule:'+Math.floor((time-Date.parse(config.startAt))/(config.intervalMinutes*60000));
  }else{
   if(!aiConfigured(env))continue;
   const recent=await env.DB.prepare('SELECT id FROM openchat_automation_runs WHERE policy_id=? AND created_at>? LIMIT 1').bind(p.id,new Date(time-60000).toISOString()).first();if(recent)continue;
   const m=await env.DB.prepare(`SELECT m.id,m.body,m.timestamp_ms FROM openchat_messages m WHERE m.room_id=? AND m.is_self=0 AND m.content_type='TEXT' AND m.body NOT LIKE '【AI自動返信】%' AND m.timestamp_ms>=? AND instr(m.body,?)>0 AND NOT EXISTS(SELECT 1 FROM openchat_automation_runs a WHERE a.policy_id=? AND a.source_key='message:'||m.id) ORDER BY m.timestamp_ms DESC,m.id DESC LIMIT 1`)
    .bind(p.room_id,Math.max(Date.parse(p.enabled_at||''),time-config.maxAgeMinutes*60000),config.trigger,p.id).first<{id:string;body:string;timestamp_ms:number}>();
   if(!m)continue;key='message:'+m.id;
   // Only text from this explicit trigger is sent to the provider; no names/IDs.
   prompt=[{role:'user',text:m.body}];
  }
  const run=await reserve(env,p,key);if(!run)continue;
  try{
   if(p.kind==='schedule'){await queue(env,p,run,config.text);return}
   const url=new URL(env.OPENCHAT_AI_URL!);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw Error('invalid_broker');
   const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+env.OPENCHAT_MANAGED_SECRET,'X-Tenant-ID':env.OPENCHAT_TENANT_ID!},body:JSON.stringify({requestKey:run,consent:'openchat_automatic_ai_reply',guide:config.guide,messages:prompt}),redirect:'manual',signal:AbortSignal.timeout(25000)});
   if(!r.ok){await finish(env,run,'handoff',r.status===429?'ai_daily_limit':'ai_unavailable');return}
   const result=await r.json<{decision:string;text:string}>();
   if(result.decision!=='reply'||typeof result.text!=='string'){await finish(env,run,'handoff','human_review');return}
   await queue(env,p,run,'【AI自動返信】\n'+result.text);
  }catch{await finish(env,run,'handoff','automation_failed')}
  return;
 }
}
