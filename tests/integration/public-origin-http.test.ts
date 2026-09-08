import assert from 'node:assert/strict';
import test from 'node:test';
import {createApiServer} from '../../apps/api/src/server.js';
import type {ClientPool} from '../../packages/persistence/src/index.js';

test('configured HTTPS origin reaches auth and workspace behind an HTTP proxy without trusting forwarding headers',async()=>{
 const pool={query:async()=>{throw Error('This unauthenticated probe must not query the database');},connect:async()=>{throw Error('No database mutation expected');}} as unknown as ClientPool;
 const publicOrigin='https://application.example.test';
 const server=createApiServer({pool,publicOrigin});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();assert(address&&typeof address!=='string');
 const base=`http://127.0.0.1:${address.port}`;
 try{
  for(const [route,acceptedStatus] of [['/api/v1/auth/login',400],['/api/templates',401]] as const){
   const accepted=await fetch(base+route,{method:'POST',headers:{origin:publicOrigin,'content-type':'application/json'},body:'{}'});
   assert.equal(accepted.status,acceptedStatus,route);
   for(const headers of [
    {origin:'https://attacker.example.test','x-forwarded-proto':'https','x-forwarded-host':'application.example.test'},
    {origin:publicOrigin,'sec-fetch-site':'cross-site'},
    {origin:base},
   ]){
    const denied=await fetch(base+route,{method:'POST',headers:{...headers,'content-type':'application/json'},body:'{}'});
    assert.equal(denied.status,403,route);
   }
  }
 }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
