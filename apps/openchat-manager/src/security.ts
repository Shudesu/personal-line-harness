const text = new TextEncoder();
function decode(value: string): Uint8Array<ArrayBuffer> { const s=value.replace(/-/g,'+').replace(/_/g,'/');return Uint8Array.from(atob(s+'='.repeat((4-s.length%4)%4)),c=>c.charCodeAt(0)); }
function encode(value: Uint8Array): string {let s='';for(let i=0;i<value.length;i+=16384)s+=String.fromCharCode(...value.subarray(i,i+16384));return btoa(s);}
export async function sha(value:string){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',text.encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('')}
export async function runtimeToken(master:string,scope:string){const raw=decode(master);if(raw.length!==32)throw Error('Runtime key must be 32 bytes');const key=await crypto.subtle.importKey('raw',raw,{name:'HMAC',hash:'SHA-256'},false,['sign']);return 'rt_'+[...new Uint8Array(await crypto.subtle.sign('HMAC',key,text.encode('openchat-runtime-v1\0'+scope)))].map(x=>x.toString(16).padStart(2,'0')).join('')}
export async function equalToken(a:string,b:string){const [left,right]=await Promise.all([sha(a),sha(b)]);let diff=0;for(let i=0;i<left.length;i++)diff|=left.charCodeAt(i)^right.charCodeAt(i);return diff===0}
export type EncryptedValue={v:1;iv:string;ciphertext:string};
export class StateCipher {
 private key:Promise<CryptoKey>;
 constructor(master:string,private scope:string){this.key=(async()=>{const raw=decode(master);if(raw.length!==32)throw Error('State key must be 32 bytes');const source=await crypto.subtle.importKey('raw',raw,'HKDF',false,['deriveKey']);return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:text.encode('l-harness-openchat-state-v1'),info:text.encode(scope)},source,{name:'AES-GCM',length:256},false,['encrypt','decrypt'])})()}
 async seal(name:string,value:unknown):Promise<EncryptedValue>{const plain=text.encode(JSON.stringify(value));if(plain.byteLength>64*1024)throw Error('State value too large');const iv=crypto.getRandomValues(new Uint8Array(12));const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:text.encode(this.scope+'\0'+name)},await this.key,plain);return {v:1,iv:encode(iv),ciphertext:encode(new Uint8Array(ciphertext))}}
 async open<T>(name:string,value:EncryptedValue):Promise<T>{if(value.v!==1)throw Error('Unsupported state format');const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(value.iv),additionalData:text.encode(this.scope+'\0'+name)},await this.key,decode(value.ciphertext));return JSON.parse(new TextDecoder().decode(plain)) as T}
}
