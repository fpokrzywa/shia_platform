import test from 'node:test';
import assert from 'node:assert/strict';
import {startApplication} from './server.js';
import type {ClientPool} from '../../../packages/persistence/src/index.js';

test('simultaneous automatic starts get distinct bound ports and report reachable URLs',async()=>{
  const entries:unknown[]=[];
  const logger={info:(_message:string,fields?:unknown)=>{entries.push(fields);},warn:()=>{},error:()=>{}};
  const pool=()=>({query:async()=>({rows:[]}),end:async()=>{},connect:async()=>{throw new Error('Not used');}}) as ClientPool;
  const config={databaseUrl:'postgresql://localhost/unused',host:'127.0.0.1',port:0,storageDir:'data'};
  const first=await startApplication(config,{pool:pool(),logger});
  try{
    const second=await startApplication(config,{pool:pool(),logger});
    try{
      assert.match(first.url,/^http:\/\/127\.0\.0\.1:[1-9]\d*$/);
      assert.notEqual(first.url,second.url);
      for(const app of [first,second])assert.equal((await fetch(app.url+'/health/live')).status,200);
      assert(entries.some(entry=>(entry as {url:string}).url===first.url));
    }finally{await second.close();}
  }finally{await first.close();}
});
