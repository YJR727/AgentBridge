import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DesktopBridge, FramedPipe, extractState, applyPatches } from '../lib/desktop.mjs';

const fixture = () => ({id:'chat-1',hostId:'local',title:'示例',turns:[{turnId:'turn-1',turnStartedAtMs:1,status:'completed',items:[{id:'a1',type:'agentMessage',phase:'final_answer',text:'中文完整回复'.repeat(2000)}]},{turnId:'turn-2',turnStartedAtMs:2,status:'inProgress',items:[{id:'call-1',type:'agentMessage',phase:'commentary',questions:[{title:'选择颜色',options:['蓝色','绿色']},{title:'补充说明'}]}]}],requests:[]});

test('Mac stale discovered catalog does not override a newly supplied current socket',async()=>{
 const saved={platform:Object.getOwnPropertyDescriptor(process,'platform'),uid:Object.getOwnPropertyDescriptor(process,'getuid'),lstat:fs.lstatSync,realpath:fs.realpathSync,connect:FramedPipe.prototype.connect,request:FramedPipe.prototype.request,env:process.env.CODEX_APP_TOOLS_PIPE_PATH,thread:process.env.CODEX_THREAD_ID};
 try{
  Object.defineProperty(process,'platform',{value:'darwin',configurable:true});process.getuid=()=>501;
  process.env.CODEX_THREAD_ID='chat-test';process.env.CODEX_APP_TOOLS_PIPE_PATH='/owned/current.sock';
  fs.lstatSync=file=>{if(file==='/owned/current.sock')return {uid:501,isSocket:()=>true,isSymbolicLink:()=>false};if(file==='/owned'||file==='/')return {uid:file==='/'?0:501,mode:0o40700,isDirectory:()=>true,isSymbolicLink:()=>false};throw new Error('ENOENT');};
  fs.realpathSync=file=>file;
  FramedPipe.prototype.connect=async function(){};
  FramedPipe.prototype.request=async function(message){return message.method==='tools/list'?{result:{tools:[{name:'list_threads'}]}}:{result:{success:true,contentItems:[{type:'inputText',text:JSON.stringify({threads:[{id:'chat-test',kind:'codex',title:'Test',hostId:'local'}]})}]}};};
  const bridge=new DesktopBridge();bridge.toolsPipe='/owned/stale.sock';
  assert.equal((await bridge.listThreads())[0].id,'chat-test');assert.equal(bridge.toolsPipe,'/owned/current.sock');
 }finally{
  Object.defineProperty(process,'platform',saved.platform);if(saved.uid)Object.defineProperty(process,'getuid',saved.uid);else delete process.getuid;
  fs.lstatSync=saved.lstat;fs.realpathSync=saved.realpath;FramedPipe.prototype.connect=saved.connect;FramedPipe.prototype.request=saved.request;
  if(saved.env===undefined)delete process.env.CODEX_APP_TOOLS_PIPE_PATH;else process.env.CODEX_APP_TOOLS_PIPE_PATH=saved.env;
  if(saved.thread===undefined)delete process.env.CODEX_THREAD_ID;else process.env.CODEX_THREAD_ID=saved.thread;
 }
});
test('Mac lists recent local chats from the session index when no tools socket exists',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-mac-index-'));
 const saved={platform:Object.getOwnPropertyDescriptor(process,'platform'),home:process.env.CODEX_HOME,tools:process.env.CODEX_APP_TOOLS_PIPE_PATH,thread:process.env.CODEX_THREAD_ID};
 try{
  Object.defineProperty(process,'platform',{value:'darwin',configurable:true});
  process.env.CODEX_HOME=directory;delete process.env.CODEX_APP_TOOLS_PIPE_PATH;delete process.env.CODEX_THREAD_ID;
  fs.writeFileSync(path.join(directory,'session_index.jsonl'),[
   JSON.stringify({id:'chat-old',thread_name:'旧聊天'}),
   JSON.stringify({id:'chat-new',thread_name:'新聊天'}),
   JSON.stringify({id:'chat-old',thread_name:'旧聊天新标题'}),
   JSON.stringify({id:'bad/id',thread_name:'无效记录'})
  ].join('\n')+'\n');
  const bridge=new DesktopBridge();
  assert.deepEqual(await bridge.listThreads(),[
   {id:'chat-old',title:'旧聊天新标题',cwd:'',status:'unknown',needsAttention:false,hostId:'local'},
   {id:'chat-new',title:'新聊天',cwd:'',status:'unknown',needsAttention:false,hostId:'local'}
  ]);
  assert.equal(bridge.catalogSource,'session-index');
 }finally{
  Object.defineProperty(process,'platform',saved.platform);
  for(const [key,value] of [['CODEX_HOME',saved.home],['CODEX_APP_TOOLS_PIPE_PATH',saved.tools],['CODEX_THREAD_ID',saved.thread]])if(value===undefined)delete process.env[key];else process.env[key]=value;
  fs.rmSync(directory,{recursive:true,force:true});
 }
});
test('completed final owns timing, invalid metadata never invents a time',()=>{
 const s=fixture();Object.assign(s.turns[0],{turnStartedAtMs:100000,durationMs:48673,finalAssistantStartedAtMs:120000});
 assert.equal(extractState(s).lastReply.completedAtMs,148673);assert.equal(extractState(s).lastReply.durationMs,48673);assert.equal(extractState(s).lastReply.turnId,'turn-1');
 for(const durationMs of [undefined,-1,NaN,Infinity,Number.MAX_SAFE_INTEGER]){s.turns[0].durationMs=durationMs;assert.equal(extractState(s).lastReply.completedAtMs,null);}
 s.turns[0].status='interrupted';assert.equal(extractState(s).lastReply,null);
});
test('shared ledger retains records from two connections',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-ledger-'));try{
 const a=new DesktopBridge({dataDirectory:dir}),b=new DesktopBridge({dataDirectory:dir,ledger:a.ledger});
 a.ledger.A={state:'pending-confirmation',threadId:'A'};a.persist();b.ledger.B={state:'accepted',threadId:'B'};b.persist();
 assert.deepEqual(Object.keys(new DesktopBridge({dataDirectory:dir}).ledger).sort(),['A','B']);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('simultaneous cross-chat ID collision reserves only one ledger record and sends once',async()=>{
 const ledger={},a=new DesktopBridge({ledger}),b=new DesktopBridge({ledger});let release,sends=0;const gate=new Promise(r=>release=r);
 for(const [bridge,id] of [[a,'A'],[b,'B']]){bridge.selectedThread={id};bridge.fresh=()=>gate;bridge.sendText=async()=>{sends++;};bridge.hasMessage=()=>false;}
 const pending=[a.sendMessage({threadId:'A',text:'first',messageId:'collision'}),b.sendMessage({threadId:'B',text:'other',messageId:'collision'})];
 await new Promise(r=>setImmediate(r));release();const results=await Promise.allSettled(pending);
 assert.equal(sends,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);assert.equal(ledger.collision.threadId,'A');
});
test('extract complete final, paginated history, native and async IDs',()=>{
 const s=fixture();let state=extractState(s);assert.equal(state.lastReply.text,s.turns[0].items[0].text);assert.equal(state.questions[0].questionId,'["request_user_input_async","call-1",0]');assert.equal(state.questions.length,2);
 s.turnHistory={history:{entitiesByKey:{new:s.turns[1],old:s.turns[0]}}};s.turns=[];assert.equal(extractState(s).lastReply.text,state.lastReply.text);
 s.requests=[{id:42,method:'item/tool/requestUserInput',params:{threadId:s.id,turnId:'turn-2',questions:[{id:'q',question:'是否继续？',options:[{label:'继续',description:'开始工作'}]}]}}];
 assert.equal(extractState(s).questions.at(-1).kind,'native');assert.equal(extractState({}).connected,false);
});
test('answered, cancelled and partial finals cannot remain actionable',()=>{
 const s=fixture();s.turns[1].items.push({type:'userMessage',content:[{type:'text',text:'<send_user_message_question_reply>\n'+JSON.stringify([{questionItemId:'["request_user_input_async","call-1",0]',question:'选择颜色',answer:'蓝色'}])+'\n</send_user_message_question_reply>'}]});
 assert.equal(extractState(s).questions[0].status,'answered');s.turns[1].status='interrupted';assert.equal(extractState(s).questions[1].status,'cancelled');
 s.turns[1].items.push({type:'agentMessage',phase:'final_answer',text:'未写完'});assert.notEqual(extractState(s).lastReply.text,'未写完');
 s.turns[0].items[0].text='字'.repeat(100000);assert.equal(extractState(s).lastReply.truncated,true);
});
test('ordered array patches, invalid paths and prototype keys',()=>{
 const s={items:[{text:'a'}]};assert.deepEqual(applyPatches(s,[{op:'replace',path:['items',0,'text'],value:'中文'},{op:'add',path:['items',1],value:{text:'b'}}]).items,[{text:'中文'},{text:'b'}]);
 assert.throws(()=>applyPatches(s,[{op:'add',path:['__proto__','bad'],value:true}]));assert.throws(()=>applyPatches(s,[{op:'replace',path:['missing','x'],value:1}]));assert.equal(s.items[0].text,'a');
});
function frame(m){const b=Buffer.from(JSON.stringify(m));const h=Buffer.alloc(4);h.writeUInt32LE(b.length);return Buffer.concat([h,b]);}
async function fake(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-desktop-'));const endpoint=process.platform==='win32'?'\\\\.\\pipe\\bridge-test-'+randomUUID():path.join(dir,'ipc');const messages=[];let snapshot=fixture(),clientSocket;
 const server=net.createServer(socket=>{clientSocket=socket;let buffer=Buffer.alloc(0);socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(buffer.length>=4&&buffer.length>=buffer.readUInt32LE()+4){const n=buffer.readUInt32LE();const m=JSON.parse(buffer.subarray(4,4+n));buffer=buffer.subarray(n+4);messages.push(m);if(m.method==='thread-stream-following-changed'&&m.params.following){socket.write(frame({type:'broadcast',method:'thread-stream-state-changed',version:11,sourceClientId:'owner',params:{conversationId:'chat-1',hostId:'local',change:{type:'snapshot',revision:1,conversationState:snapshot}}}));}else if(m.type==='request'){let result=m.method==='initialize'?{clientId:'bridge'}:m.method==='thread-owner-discovery'?{supportsUntrustedAppInput:true}:{ok:true};if(m.method.includes('start-turn')||m.method.includes('steer-turn')){const input=m.params.input||m.params.turnStart.request.input;const id=m.params.clientUserMessageId||m.params.turnStart.request.clientUserMessageId;snapshot.turns[1].items.push({type:'userMessage',clientId:id,content:input});}if(m.method==='thread-follower-submit-user-input'){const request=snapshot.requests.find(r=>r.id===m.params.requestId);if(request){snapshot.requests=[];snapshot.turns[1].items.push({type:'userInputResponse',requestId:request.id,completed:true,answers:m.params.response.answers});}}socket.write(frame({type:'response',requestId:m.requestId,method:m.method,resultType:'success',handledByClientId:'owner',result}));}}});});
 await new Promise(r=>server.listen(endpoint,r));const bridge=new DesktopBridge({ipcPipe:endpoint,dataDirectory:dir,timeoutMs:300});
 t.after(async()=>{bridge.stop();clientSocket?.destroy();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
 return {bridge,dir,messages,setSnapshot:s=>{snapshot=s;},socket:()=>clientSocket,endpoint};
}
test('framing handles split/coalesced frames and rejects oversize/disconnect',async t=>{
 const f=await fake(t);const pipe=new FramedPipe(f.endpoint,{timeoutMs:300});await pipe.connect();await new Promise(r=>setTimeout(r,10));t.after(()=>pipe.close());const got=[];pipe.on('message',m=>got.push(m));const joined=Buffer.concat([frame({x:1}),frame({x:2})]);f.socket().write(joined.subarray(0,2));f.socket().write(joined.subarray(2));await new Promise(r=>setTimeout(r,30));assert.deepEqual(got,[{x:1},{x:2}]);const pending=pipe.request({type:'request',requestId:'waiting',method:'ignored'},'waiting');f.socket().destroy();await assert.rejects(pending);
});
test('large desktop snapshots with attachments still expose the selected chat and final reply',async t=>{
 const f=await fake(t);const s=fixture();s.attachments=[{data:'x'.repeat(40*1024*1024)}];
 f.setSnapshot(s);f.bridge.timeoutMs=15000;
 await f.bridge.selectThread('chat-1');
 assert.equal(f.bridge.getState().connected,true);
 assert.equal(f.bridge.getState().lastReply.text,s.turns[0].items[0].text);
});
test('an oversized desktop frame reports its size limit rather than claiming the desktop is closed',async t=>{
 const f=await fake(t);const pipe=new FramedPipe(f.endpoint,{timeoutMs:1000});await pipe.connect();await new Promise(r=>setTimeout(r,10));t.after(()=>pipe.close());
 const waiting=pipe.request({type:'no-response',requestId:'oversized'},'oversized');
 const header=Buffer.alloc(4);header.writeUInt32LE(128*1024*1024+1);f.socket().write(header);
 await assert.rejects(waiting,/128.*MB|数据过大/);
});
test('select, freshness, send dedupe, wrong chat and restart ledger',async t=>{
 const f=await fake(t);await f.bridge.selectThread('chat-1');assert.equal(f.bridge.getState().connected,true);
 await assert.rejects(f.bridge.sendMessage({threadId:'other',text:'hello',messageId:'m1'}),/聊天/);
 const message={threadId:'chat-1',text:'hello',messageId:'m1'};await f.bridge.sendMessage(message);await f.bridge.sendMessage(message);assert.equal(f.messages.filter(m=>m.method==='thread-follower-steer-turn').length,1);
 await assert.rejects(f.bridge.sendMessage({...message,text:'different'}),/重复|不同/);
 await assert.rejects(f.bridge.sendMessage({...message,text:' '.repeat(2),messageId:'m2'}));
 const other=new DesktopBridge({ipcPipe:f.endpoint,dataDirectory:f.dir,timeoutMs:300});t.after(()=>other.stop());await other.selectThread('chat-1');await other.sendMessage(message);assert.equal(f.messages.filter(m=>m.method==='thread-follower-steer-turn').length,1);
});
test('queued guard and wrong turn reject before desktop submission',async t=>{
 const f=await fake(t);await f.bridge.selectThread('chat-1');
 await assert.rejects(f.bridge.sendMessage({threadId:'chat-1',text:'never send',messageId:'guard'},()=>{throw new Error('device changed');}),/device changed/);
 const qid='["request_user_input_async","call-1",0]';
 await assert.rejects(f.bridge.answerQuestion({threadId:'chat-1',turnId:'wrong',questionId:qid,answers:{[qid]:'蓝色'},submissionId:'wrong-turn'}),/轮次/);
 assert.equal(f.messages.filter(m=>m.method==='thread-follower-steer-turn').length,0);
});
test('native answers preserve map, async answers use actual desktop format',async t=>{
 const f=await fake(t);const s=fixture();s.requests=[{id:42,method:'item/tool/requestUserInput',params:{threadId:s.id,turnId:'turn-2',questions:[{id:'q1',question:'说明'},{id:'q2',question:'选择',options:[{label:'A'}]}]}}];f.setSnapshot(s);await f.bridge.selectThread(s.id);
 const q=f.bridge.getState().questions.find(q=>q.kind==='native');const body={threadId:s.id,questionId:q.questionId,answers:{q1:'文字',q2:'A'},submissionId:'answer-1'};assert.equal((await f.bridge.answerQuestion(body)).state,'accepted');await f.bridge.answerQuestion(body);
 assert.deepEqual(f.messages.find(m=>m.method==='thread-follower-submit-user-input').params.response.answers,{q1:{answers:['文字']},q2:{answers:['A']}});
 const aq='["request_user_input_async","call-1",0]';await f.bridge.answerQuestion({threadId:s.id,questionId:aq,answers:{[aq]:'蓝色'},submissionId:'answer-2'});const sent=f.messages.find(m=>m.method==='thread-follower-steer-turn');assert.match(sent.params.input[0].text,/<send_user_message_question_reply>/);assert.match(sent.params.input[0].text,/questionItemId/);
 await assert.rejects(f.bridge.answerQuestion({threadId:s.id,questionId:aq,answers:{[aq]:'绿色'},submissionId:'answer-3'}));f.bridge.clearSelection();await assert.rejects(f.bridge.sendMessage({threadId:s.id,text:'hi',messageId:'m3'}));
});

test('incompatible stream and unknown owner fail closed',async t=>{
 const f=await fake(t);await f.bridge.selectThread('chat-1');
 f.bridge.onMessage({type:'broadcast',sourceClientId:'owner',method:'thread-stream-state-changed',version:99,params:{conversationId:'chat-1',change:{type:'snapshot',revision:1,conversationState:fixture()}}});
 assert.equal(f.bridge.getState().connected,false);assert.match(f.bridge.getState().error,/协议/);
 const oldRequest=f.bridge.request.bind(f.bridge);f.bridge.request=async(method,...args)=>method==='thread-owner-discovery'?{result:{supportsUntrustedAppInput:true},handledByClientId:'changed-owner'}:oldRequest(method,...args);
 await assert.rejects(f.bridge.sendMessage({threadId:'chat-1',text:'hi',messageId:'changed'}),/持有者/);assert.equal(f.messages.filter(m=>m.method==='thread-follower-steer-turn').length,0);
});
test('revision gap requires a fresh snapshot, wrong source never changes state',async t=>{
 const f=await fake(t);await f.bridge.selectThread('chat-1');
 f.bridge.onMessage({sourceClientId:'intruder',method:'thread-stream-state-changed',version:11,params:{conversationId:'chat-1',change:{type:'snapshot',revision:55,conversationState:{}}}});assert.equal(f.bridge.getState().connected,true);
 f.bridge.onMessage({sourceClientId:'owner',method:'thread-stream-state-changed',version:11,params:{conversationId:'chat-1',change:{type:'patches',baseRevision:999,revision:1000,patches:[]}}});assert.equal(f.bridge.getState().connected,false);
 await new Promise(r=>setTimeout(r,30));assert.equal(f.bridge.getState().connected,true);
});
test('expired native and cancelled async questions cannot be answered; idle sends retain settings',async t=>{
 const f=await fake(t);const s=fixture();s.turns[1].status='interrupted';f.setSnapshot(s);await f.bridge.selectThread('chat-1');
 await assert.rejects(f.bridge.answerQuestion({threadId:'chat-1',questionId:'native:42',answers:{q:'x'},submissionId:'expired'}),/过期/);
 await assert.rejects(f.bridge.answerQuestion({threadId:'chat-1',questionId:'["request_user_input_async","call-1",0]',answers:{x:'x'},submissionId:'cancelled'}),/取消/);
 await f.bridge.sendMessage({threadId:'chat-1',text:'continue',messageId:'idle'});const request=f.messages.find(m=>m.method==='thread-follower-start-turn');assert.equal(request.version,2);assert.deepEqual(request.params.turnStart.context,{inheritThreadSettings:true});assert.equal('model' in request.params.turnStart.request,false);
});
test('lost acknowledgement is persisted and never retried; queued requests revoked by reset',async t=>{
 const f=await fake(t);await f.bridge.selectThread('chat-1');let sends=0;f.bridge.sendText=async()=>{sends++;throw new Error('connection lost after write');};
 const payload={threadId:'chat-1',text:'work',messageId:'uncertain'};assert.equal((await f.bridge.sendMessage(payload)).state,'pending-confirmation');await f.bridge.sendMessage(payload);assert.equal(sends,1);
 const held=new Promise(resolve=>{f.release=resolve;});f.bridge.queue=held;const queued=f.bridge.sendMessage({...payload,messageId:'queued'});f.bridge.clearSelection();f.release();await assert.rejects(queued,/授权|聊天/);assert.equal(sends,1);
 const stored=JSON.parse(fs.readFileSync(path.join(f.dir,'desktop-deliveries.json'),'utf8'));assert.equal(stored.uncertain.state,'pending-confirmation');assert.equal(JSON.stringify(stored).includes('"work"'),false);
});
test('malformed JSON and oversized frames close pipe and reject outstanding requests',async t=>{
 for(const invalid of [Buffer.from([1,0,0,0,123]),Buffer.from([255,255,255,127])]){
  const f=await fake(t);const p=new FramedPipe(f.endpoint,{timeoutMs:300});await p.connect();await new Promise(r=>setTimeout(r,10));t.after(()=>p.close());
  const waiting=p.request({type:'no-response',requestId:'waiting'},'waiting');f.socket().write(invalid);await assert.rejects(waiting);assert.equal(p.socket.destroyed,true);
 }
});
test('uncertain answer blocks a second submission ID for the same question',async t=>{
 const f=await fake(t);await f.bridge.selectThread('chat-1');f.bridge.sendText=async()=>{throw new Error('lost acknowledgement');};const qid='["request_user_input_async","call-1",0]';
 const body={threadId:'chat-1',questionId:qid,answers:{[qid]:'蓝色'},submissionId:'answer-first'};assert.equal((await f.bridge.answerQuestion(body)).state,'pending-confirmation');
 await assert.rejects(f.bridge.answerQuestion({...body,submissionId:'answer-second'}),/已经提交|待确认/);
});
test('later desktop evidence upgrades an uncertain message without resending it',async t=>{
 const f=await fake(t);await f.bridge.selectThread('chat-1');const original=f.bridge.sendText.bind(f.bridge);f.bridge.sendText=async(...args)=>{await original(...args);throw new Error('lost reply');};
 const p={threadId:'chat-1',text:'one message',messageId:'late-proof'};assert.equal((await f.bridge.sendMessage(p)).state,'pending-confirmation');await f.bridge.fresh('chat-1');assert.equal(f.bridge.getState().deliveries.find(d=>d.id==='late-proof').state,'accepted');assert.equal(f.messages.filter(m=>m.method==='thread-follower-steer-turn').length,1);
});

