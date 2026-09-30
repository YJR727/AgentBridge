import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadConfig} from '../lib/config.mjs';
import {Store} from '../lib/store.mjs';
import {BridgeServer} from '../lib/server.mjs';

test('Codex routes authenticate first, preserve errors and revoke selection on re-pair',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-desktop-http-'));const prev=process.env.AGENT_BRIDGE_DATA;process.env.AGENT_BRIDGE_DATA=dir;const {config}=loadConfig();config.port=0;config.pairedAt=Date.now();let selected=null,calls=0;
 const desktop={listThreads:async()=>{calls++;return [{id:'chat',title:'测试'}];},selectThread:async id=>{calls++;selected={id};return selected;},getState:()=>({connected:true,selectedThread:selected,status:'question',lastReply:{text:'完整中文回复'},questions:[{questionId:'q',status:'pending',questions:[{question:'正文'}]}],approvals:[]}),sendMessage:async body=>{calls++;if(body.threadId!==selected?.id)throw Object.assign(new Error('聊天不符'),{status:409});return {messageId:body.messageId,state:'accepted'};},answerQuestion:async()=>{throw Object.assign(new Error('问题已回答'),{status:409});},clearSelection:()=>{selected=null;}};
 const bridge=new BridgeServer({store:new Store(dir),config,desktop,logger:{log(){},warn(){},error(){}}});const addr=await bridge.start();const base=`http://127.0.0.1:${addr.port}`;
 t.after(async()=>{await bridge.stop();process.env.AGENT_BRIDGE_DATA=prev??'';fs.rmSync(dir,{recursive:true,force:true});});
 const request=(route,body,auth=true)=>fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:`Bearer ${config.appToken}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 for(const [route,body] of [['threads'],['state'],['select',{}],['message',{}],['answer',{}]])assert.equal((await request('/api/codex/'+route,body,false)).status,401);
 assert.equal(calls,0);assert.equal((await request('/api/codex/threads')).status,200);
 assert.equal((await request('/api/codex/select',{threadId:'chat'})).status,200);
 assert.equal((await request('/api/codex/message',{threadId:'wrong',text:'hi',messageId:'m'})).status,409);
 assert.equal((await request('/api/codex/message',{threadId:'chat',text:'hi',messageId:'m'})).status,200);
 assert.equal((await request('/api/codex/answer',{})).status,409);
 const poll=await (await request('/api/native/poll')).json();assert.equal(poll.codex.threadId,'chat');assert.equal(poll.codex.questions[0].questionId,'q');
 const old=config.appToken;await bridge.resetPairing();assert.equal(selected,null);assert.equal((await fetch(base+'/api/codex/state',{headers:{Authorization:`Bearer ${old}`}})).status,401);
});
