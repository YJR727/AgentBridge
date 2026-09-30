import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {loadConfig} from '../lib/config.mjs';
import {Store} from '../lib/store.mjs';
import {BridgeServer} from '../lib/server.mjs';

test('desktop web reminders dedupe repeated patches, preserve IDs, skip handled and hook-owned requests',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-web-push-')),previous=process.env.AGENT_BRIDGE_DATA;process.env.AGENT_BRIDGE_DATA=dir;
  const {config}=loadConfig();config.port=0;config.pairedAt=Date.now();const store=new Store(dir);
  let snapshot={connected:true,selectedThread:{id:'chat',title:'聊天'},questions:[{questionId:'q1',status:'pending',questions:[{question:'选择 **水果**'}]}],approvals:[]};
  const desktop={waiters:new Set(),getState:()=>snapshot,clearSelection(){snapshot={connected:false,questions:[],approvals:[]};for(const fn of this.waiters)fn();}};
  const bridge=new BridgeServer({store,config,desktop,logger:{log(){},warn(){},error(){}}}),sent=[];
  store.listSubscriptions=()=>[{}];bridge.pushEvent=async e=>{sent.push(e);return {ok:1,failed:0,details:[]};};
  await bridge.start();t.after(async()=>{await bridge.stop();process.env.AGENT_BRIDGE_DATA=previous??'';fs.rmSync(dir,{recursive:true,force:true});});
  const tick=async()=>{for(const fn of desktop.waiters)fn();await new Promise(r=>setImmediate(r));};
  await tick();await tick();assert.equal(sent.length,1,'a live pending question must push once');
  assert.equal(sent[0].codex.threadId,'chat');assert.equal(sent[0].codex.questionId,'q1');assert.equal(sent[0].needsDecision,false,'notifications must open details, not carry approval credentials');
  snapshot.questions.push({questionId:'q2',status:'pending',questions:[{question:'另一题'}]});await tick();assert.equal(sent.length,2,'second question in same chat must push');
  snapshot.approvals=[{questionId:'a1',requestId:'request-1',turnId:'turn-1',title:'命令审批'}];store.listEvents=()=>[{state:'pending',source:'codex-hook',sessionId:'chat',turnId:'turn-1',requestId:'request-1'}];await tick();assert.equal(sent.length,2,'hook owns only the matching approval');
  store.listEvents=()=>[];await tick();assert.equal(sent.length,3);assert.equal(sent[2].codex.questionId,'a1');
  snapshot.connected=false;snapshot.questions.push({questionId:'q3',status:'pending',questions:[{question:'失联'}]});await tick();assert.equal(sent.length,3);
  await bridge.resetPairing();await tick();assert.equal(sent.length,3,'re-pairing must not revive old requests');
});

test('desktop notification opens the exact chat/question and never approves from a background token',async()=>{
  const handlers={},opened=[],messages=[];let task;
  const context={self:{addEventListener:(name,fn)=>handlers[name]=fn,clients:{matchAll:async()=>[],openWindow:async url=>opened.push(url)}},fetch:()=>{throw Error('Desktop reminders must not submit a background approval');},URLSearchParams};
  vm.runInNewContext(fs.readFileSync(new URL('../public/sw.js',import.meta.url),'utf8'),context);
  const data={kind:'codex-question',threadId:'chat-1',questionId:'["request_user_input_async","call-1",0]'};
  const event={notification:{data,close(){}},action:'',waitUntil:p=>task=p};handlers.notificationclick(event);await task;
  const url=new URL(opened[0],'http://localhost');assert.equal(url.searchParams.get('thread'),data.threadId);assert.equal(url.searchParams.get('question'),data.questionId);
  context.self.clients.matchAll=async()=>[{focus:async()=>{},postMessage:m=>messages.push(m)}];handlers.notificationclick(event);await task;
  assert.equal(messages[0].type,'open-codex');assert.equal(messages[0].questionId,data.questionId);
});
