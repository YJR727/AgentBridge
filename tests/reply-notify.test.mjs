import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {loadConfig} from '../lib/config.mjs';
import {Store} from '../lib/store.mjs';
import {BridgeServer} from '../lib/server.mjs';

async function setup(t,{web=true}={}) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-reply-')),previous=process.env.AGENT_BRIDGE_DATA;
  process.env.AGENT_BRIDGE_DATA=directory;
  const {config}=loadConfig();config.port=0;config.pairedAt=Date.now();config.notify.success='silent';
  const store=new Store(directory),sent=[];
  let state={connected:true,selectedThread:{id:'chat',title:'测试聊天'},status:'complete',lastReply:{turnId:'old',phase:'final',text:'历史回复'},questions:[],approvals:[]};
  const desktop={waiters:new Set(),getState:()=>state,clearSelection(){state={connected:false};}};
  const bridge=new BridgeServer({store,config,desktop,logger:{log(){},warn(){},error(){}}});
  if(web){store.listSubscriptions=()=>[{}];bridge.pushEvent=async event=>{sent.push(event);return{ok:1,failed:0,details:[]};};}
  const address=await bridge.start();
  t.after(async()=>{await bridge.stop();if(previous===undefined)delete process.env.AGENT_BRIDGE_DATA;else process.env.AGENT_BRIDGE_DATA=previous;fs.rmSync(directory,{recursive:true,force:true});});
  const tick=async()=>{await Promise.all([...desktop.waiters].map(fn=>fn()));await new Promise(resolve=>setTimeout(resolve,30));};
  const poll=async()=>(await fetch(`http://127.0.0.1:${address.port}/api/native/poll`,{headers:{Authorization:`Bearer ${config.appToken}`}})).json();
  return {config,store,sent,tick,poll,set:patch=>Object.assign(state,patch)};
}

test('completed replies push once, store the complete body, and reach the existing Android feed despite silent hook notices',async t=>{
  const h=await setup(t);await h.tick();assert.equal(h.sent.length,0,'initial history must not notify');
  h.set({status:'processing',activeTurnId:'new'});await h.tick();assert.equal(h.sent.length,0,'progress must not notify');
  const text='老板，**完成了**。\n\n```js\nconst result = 1;\n```\n'+'详细回复。'.repeat(200);
  h.set({status:'complete',activeTurnId:null,lastReply:{turnId:'new',phase:'final',text}});
  await Promise.all([h.tick(),h.tick(),h.tick()]);
  assert.equal(h.sent.length,1,'one completed turn must produce exactly one push');
  const event=h.store.listEvents()[0];assert.equal(event.body,text);assert.equal(event.needsDecision,false);assert.equal(event.replyToken,null);
  assert.ok(!event.summary.includes('**'),'notification preview must be plain text');
  const feed=await h.poll();assert.equal(feed.events[0].notify,true,'old APK must show the new completion event');
  assert.equal(feed.events[0].id,event.id);
});

test('completion works without any web subscription and advances for each new turn',async t=>{
  const h=await setup(t,{web:false});await h.tick();
  for(const turnId of ['a','b']){h.set({lastReply:{turnId,phase:'final',text:'已完成 '+turnId}});await h.tick();await h.tick();}
  assert.equal(h.store.listEvents().length,2);assert.equal((await h.poll()).events.filter(e=>e.notify).length,2);
});

test('selection, reconnect, cancellation and disabled reminders do not replay old replies',async t=>{
  const h=await setup(t);await h.tick();
  h.set({connected:false});await h.tick();
  h.set({connected:true,lastReply:{turnId:'while-offline',phase:'final',text:'断线时结束'}});await h.tick();
  h.set({selectedThread:{id:'another',title:'其他聊天'},lastReply:{turnId:'another-old',phase:'final',text:'旧回复'}});await h.tick();
  h.set({status:'cancelled',lastReply:{turnId:'cancelled',phase:'final',text:'不能当完成'}});await h.tick();
  h.config.notify.replyCompleted=false;h.set({status:'complete',lastReply:{turnId:'disabled',phase:'final',text:'关闭时完成'}});await h.tick();
  h.config.notify.replyCompleted=true;await h.tick();assert.equal(h.sent.length,0);
  h.set({lastReply:{turnId:'fresh',phase:'final',text:'新的完成回复'}});await h.tick();assert.equal(h.sent.length,1);
});

test('reply notification click opens the saved reply event without sending approval',async()=>{
  const handlers={},opened=[];let task;
  const context={self:{addEventListener:(key,fn)=>handlers[key]=fn,clients:{matchAll:async()=>[],openWindow:async url=>opened.push(url)}},fetch:()=>{throw Error('Reply notification must not send a decision');}};
  vm.runInNewContext(fs.readFileSync(new URL('../public/sw.js',import.meta.url),'utf8'),context);
  handlers.notificationclick({notification:{data:{kind:'success',eventId:'ev_reply'},close(){}},action:'',waitUntil:p=>task=p});await task;
  assert.equal(opened[0],'/?event=ev_reply');
});
