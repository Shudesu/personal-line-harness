import {describe,it,expect,vi} from 'vitest';
import {authorize,type Env} from './index';
import {StateCipher,runtimeToken,equalToken} from './security';
const key=btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
describe('Managed OpenChat encrypted state',()=>{
 it('does not store authentication values as plaintext',async()=>{const vault=new StateCipher(key,'tenant-a/connection-a');const sealed=await vault.seal('session',{authToken:'PRIVATE_AUTH_TOKEN'});expect(JSON.stringify(sealed)).not.toContain('PRIVATE_AUTH_TOKEN');expect(await vault.open('session',sealed)).toEqual({authToken:'PRIVATE_AUTH_TOKEN'})});
 it('rejects state moved to a different tenant or purpose',async()=>{const a=new StateCipher(key,'tenant-a/connection-a'),b=new StateCipher(key,'tenant-b/connection-b');const sealed=await a.seal('session',{authToken:'x'});await expect(b.open('session',sealed)).rejects.toThrow();await expect(a.open('receipt/abc',sealed)).rejects.toThrow()});
 it('derives different container credentials for each connection',async()=>{const a=await runtimeToken(key,'a/one'),b=await runtimeToken(key,'a/two');expect(a).not.toBe(b);expect(await equalToken(a,a)).toBe(true);expect(await equalToken(a,b)).toBe(false)});
 it('bounds individual state records',async()=>{await expect(new StateCipher(key,'a/one').seal('session','x'.repeat(70000))).rejects.toThrow('too large')});
});

it('uses edge-compatible manual redirects and refuses credential-bearing redirects',async()=>{
 const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{expect(init?.redirect).toBe('manual');return new Response('',{status:302,headers:{Location:'https://other.invalid'}})});
 try {await expect(authorize({CONTROL_AUTHORIZE_URL:'https://control.example/authorize'} as Env,'redirect-test','x'.repeat(40),false,true)).rejects.toThrow('Control unavailable');expect(fetcher).toHaveBeenCalledTimes(1)}finally{fetcher.mockRestore()}
});
