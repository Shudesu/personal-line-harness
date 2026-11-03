import {describe,it,expect,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {ManagedOpenChat,type Env} from './index';
import {runtimeToken} from './security';
const master=btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const scope='tenant-a/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
function fixture(){
 const records=new Map<string,unknown>();let alarm:number|null=null;let instance:ManagedOpenChat;
 const storage={async get(k:string){return records.get(k)},async put(k:string|Record<string,unknown>,v?:unknown){if(typeof k==='string')records.set(k,v);else for(const [key,value]of Object.entries(k))records.set(key,value)},async deleteAll(){records.clear()},async deleteAlarm(){alarm=null},async setAlarm(at:number){alarm=at}};
 const container={running:false,starts:0,destroys:0,phase:"connected",start(){this.running=true;this.starts++},async destroy(){this.running=false;this.destroys++},async setInactivityTimeout(){},getTcpPort(){return {fetch:async(input:RequestInfo)=>{
  if(String(input).endsWith('/bootstrap')){const token=await runtimeToken(master,scope);const checkpoint=await instance.fetch(new Request('https://session/state?key=session',{method:'PUT',headers:{'X-Session-Scope':scope,Authorization:'Bearer '+token},body:JSON.stringify({value:{authToken:'PRIVATE'}})}));expect(checkpoint.ok).toBe(true);}
  return Response.json(String(input).endsWith('/health')?{ready:true}:{phase:container.phase});
 }}}};
 const env={STATE_KEY_B64:master,RUNTIME_KEY_B64:master,PUBLIC_BASE_URL:'https://manager.example',SELF_HOSTED_TENANTS:JSON.stringify({'tenant-a':{secretHash:createHash('sha256').update('x'.repeat(40)).digest('hex'),origin:'https://tenant.example'}})} as Env;
 instance=new ManagedOpenChat({storage,container,waitUntil(){}} as unknown as DurableObjectState,env);
 const request=(path:string,body?:unknown)=>instance.fetch(new Request('https://session'+path,{method:'POST',headers:{'X-Session-Scope':scope,'X-Tenant-Origin':'https://tenant.example','X-Tenant-Secret':'x'.repeat(40)},...(body?{body:JSON.stringify(body)}:{})}));
 return {request,records,container,runAlarm:()=>instance.alarm(),get alarm(){return alarm}};
}
describe('managed lifecycle',()=>{
 it('allows reentrant durable checkpoints during startup and starts only one container',async()=>{const x=fixture();expect((await x.request('/create',{connectorToken:'oc_'+'a'.repeat(64)})).status).toBe(200);expect((await x.request('/status')).status).toBe(200);expect(x.container.starts).toBe(1);expect(x.alarm).not.toBeNull();expect(JSON.stringify([...x.records])).not.toContain('PRIVATE');});
 it('erases credentials and prevents resurrection after disconnect',async()=>{const x=fixture();await x.request('/create',{connectorToken:'oc_'+'a'.repeat(64)});expect((await x.request('/close')).status).toBe(200);expect(x.container.destroys).toBe(1);expect(x.alarm).toBeNull();expect([...x.records.keys()].sort()).toEqual(['closed','scope']);expect((await x.request('/create',{connectorToken:'oc_'+'a'.repeat(64)})).status).toBe(410);});
});

it('simulates 24 hours of alarms and restores after a container exit without a browser',async()=>{
 const x=fixture();await x.request('/create',{connectorToken:'oc_'+'a'.repeat(64)});
 const time=vi.spyOn(Date,'now');const start=Date.now();
 try {for(let minute=1;minute<=1440;minute++){time.mockReturnValue(start+minute*60000);if(minute===720)x.container.running=false;await x.runAlarm();expect(x.alarm).not.toBeNull()}
 expect(x.container.starts).toBe(2);expect(JSON.stringify([...x.records])).not.toContain('PRIVATE');}
 finally{time.mockRestore()}
});
it('stops keepalive when LINE requires user reauthentication',async()=>{
 const x=fixture();await x.request('/create',{connectorToken:'oc_'+'a'.repeat(64)});x.container.phase='auth_required';await x.runAlarm();expect(x.alarm).toBeNull();
});
