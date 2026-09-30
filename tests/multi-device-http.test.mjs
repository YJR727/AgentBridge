import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadConfig} from '../lib/config.mjs';
import {Store} from '../lib/store.mjs';
import {BridgeServer} from '../lib/server.mjs';
import {DesktopSessions} from '../lib/desktop-sessions.mjs';

const phone='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',ipad='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
async function setup(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-multi-')),old=process.env.AGENT_BRIDGE_DATA;process.env.AGENT_BRIDGE_DATA=dir;
 const {config}=loadConfig();config.port=0;config.pairedAt=Date.now();const store=new Store(dir),s=new DesktopSessions({dataDirectory:dir});s.start=()=>{};
 s.createBridge=()=>({waiters:new Set(),questions:[],approvals:[],status:'complete',lastReply:{turnId:'old',phase:'final',text:'old'},queue:Promise.resolve(),
  async selectThread(id){this.selectedThread={id,title:'Title '+id};},getState(){return {connected:!!this.selectedThread,selectedThread:this.selectedThread,questions:this.questions,approvals:this.approvals,status:this.status,lastReply:this.lastReply};},
  sendMessage(body,guard){return this.queue.then(()=>{guard();return {state:'accepted'};});},
  decideApproval(body,guard){const p=this.queue.then(()=>{guard();this.approvals=[];return {state:'accepted'};});this.queue=p.catch(()=>{});return p;},stop(){this.selectedThread=null;}});
 const bridge=new BridgeServer({store,config,desktop:s,logger:{log(){},warn(){},error(){}}});const addr=await bridge.start();
 const request=(route,body,device=phone,auth=true)=>fetch(`http://127.0.0.1:${addr.port}`+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Agent-Bridge-Device':device,...(auth?{Authorization:'Bearer '+config.appToken}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 t.after(async()=>{await bridge.stop();s.stop();if(old===undefined)delete process.env.AGENT_BRIDGE_DATA;else process.env.AGENT_BRIDGE_DATA=old;fs.rmSync(dir,{recursive:true,force:true});});
 return {request,s,store,bridge,config};
}
test('device HTTP bindings are independent and global C approval does not switch them',async t=>{
 const {request:r,s}=await setup(t);assert.equal((await r('/api/codex/state',undefined,phone,false)).status,401);assert.equal((await r('/api/codex/state',undefined,'invalid')).status,400);
 await r('/api/codex/select',{threadId:'A'},phone);await r('/api/codex/select',{threadId:'B'},ipad);
 assert.equal((await (await r('/api/codex/state')).json()).selectedThread.id,'A');assert.equal((await (await r('/api/codex/state',undefined,ipad)).json()).selectedThread.id,'B');
 assert.equal((await r('/api/codex/message',{threadId:'B',text:'wrong',messageId:'m'})).status,409);
 const c=await s.ensure('C');c.approvals=[{questionId:'approval:r',requestId:'r',turnId:'C-turn',status:'pending',title:'C approval'}];
 const state=await (await r('/api/codex/state')).json();assert.equal(state.pending[0].threadId,'C');assert.equal(state.pending[0].threadTitle,'Title C');
 const body={threadId:'C',turnId:'C-turn',questionId:'approval:r',choice:'approve',submissionId:'first'};
 assert.equal((await r('/api/codex/approval',body)).status,200);assert.equal((await r('/api/codex/approval',{...body,choice:'deny',submissionId:'other'},ipad)).status,409);
 assert.equal(s.getState(phone).selectedThread.id,'A');assert.equal(s.getState(ipad).selectedThread.id,'B');
});
test('global poll dedupes only exact hook identity; completions follow device selection',async t=>{
 const {request:r,s,store,bridge}=await setup(t);await r('/api/codex/select',{threadId:'A'},phone);await r('/api/codex/select',{threadId:'B'},ipad);
 const c=await s.ensure('C');c.approvals=[{questionId:'approval:one',requestId:'one',turnId:'C-turn',title:'first'},{questionId:'approval:two',requestId:'two',turnId:'C-turn',title:'second'}];
 await store.addEvent({id:'ev_hook',state:'pending',kind:'decision',needsDecision:true,source:'codex-hook',sessionId:'C',turnId:'C-turn',requestId:'one',expiresAt:Date.now()+60000});
 const feed=await (await r('/api/native/poll')).json();assert.equal(feed.pending.length,1);assert.equal(feed.pending[0].questionId,'approval:two');
 assert.equal((await r('/api/codex/approval',{threadId:'C',turnId:'C-turn',questionId:'approval:one',submissionId:'wrong-route',choice:'approve'})).status,409,'hook-owned request cannot be submitted again through native route');
 await store.patchEvent('ev_hook',{state:'resolved',decision:{choice:'deny'}});
 assert.equal((await (await r('/api/native/poll')).json()).pending.length,1,'resolved hook retains its source until desktop request disappears');
 assert.equal((await r('/api/codex/approval',{threadId:'C',turnId:'C-turn',questionId:'approval:one',submissionId:'after-hook',choice:'approve'})).status,409);
 await bridge.pushDesktopReply();s.entries.get('A').bridge.lastReply={turnId:'new',phase:'final',text:'A done'};await bridge.pushDesktopReply();
 const a=await (await r('/api/native/poll')).json(),b=await (await r('/api/native/poll',undefined,ipad)).json();
 assert.equal(a.events.find(e=>e.kind==='success').notify,true);assert.equal(b.events.find(e=>e.kind==='success').notify,false);
 const health=await (await r('/api/health',undefined,phone,false)).json();assert.equal(health.independentChats,true);
});
test('hook arriving during native freshness is checked by submission guard',async t=>{
 const {request:r,s,store}=await setup(t);const c=await s.ensure('C');
 c.approvals=[{questionId:'approval:late',requestId:'late',turnId:'C-turn',title:'late'}];let sent=0;
 c.decideApproval=async(body,guard)=>{await store.addEvent({id:'ev_late',state:'pending',kind:'decision',source:'codex-hook',sessionId:'C',turnId:'C-turn',requestId:'late'});guard();sent++;return{state:'accepted'};};
 assert.equal((await r('/api/codex/approval',{threadId:'C',turnId:'C-turn',questionId:'approval:late',submissionId:'late-choice',choice:'approve'})).status,409);assert.equal(sent,0);
});
test('native reserved origin prevents a late hook from opening a second decision path',async t=>{
 const {s,bridge,store}=await setup(t);s.catalog.ledger.original={state:'pending-confirmation',requestKey:JSON.stringify(['C','C-turn','late'])};
 const result=await bridge.handleEvent({source:'codex-hook',sessionId:'C',turnId:'C-turn',requestId:'late',kind:'decision',needsDecision:true});
 assert.equal(result.choice,null);assert.equal(store.listEvents().length,0,'never expose an opposite choice while original native delivery is uncertain');
});
