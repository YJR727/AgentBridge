// Codex desktop IPC, verified against 26.924.1866.0. No standalone app-server.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import {resolveDesktopEndpoint, discoverToolsEndpoints} from './desktop-endpoints.mjs';

const fail = (message, status = 503) => Object.assign(new Error(message), { status });
const MAX_FRAME = 128 * 1024 * 1024;
const validId = id => typeof id === 'string' && /^[\w-]{1,100}$/.test(id);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const answersHash = answers => hash(Object.entries(answers).sort(([a],[b])=>a.localeCompare(b)));
function localIndexThreads(file) {
  if(!fs.existsSync(file)||fs.statSync(file).size>=8*1024*1024)return [];
  const threads=[],seen=new Set();
  for(const line of fs.readFileSync(file,'utf8').trim().split('\n').reverse()){
    try{
      const entry=JSON.parse(line),id=entry.id;
      if(!validId(id)||seen.has(id))continue;
      seen.add(id);
      threads.push({id,title:typeof entry.thread_name==='string'&&entry.thread_name.trim()?entry.thread_name.slice(0,160):id,cwd:'',status:'unknown',needsAttention:false,hostId:'local'});
      if(threads.length===50)break;
    }catch{}
  }
  return threads;
}

export class FramedPipe extends EventEmitter {
  constructor(endpoint, { timeoutMs = 3500 } = {}) { super(); this.endpoint = endpoint; this.timeoutMs = timeoutMs; this.pending = new Map(); }
  async connect() {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const socket = net.connect(this.endpoint); this.socket = socket;
      this.disconnectError = null;
      const header = Buffer.alloc(4); let headerBytes = 0, body = null, bodyBytes = 0;
      const timer = setTimeout(() => { reject(fail('桌面连接超时')); socket.destroy(); }, this.timeoutMs);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
      socket.on('error', () => { clearTimeout(timer); reject(fail('无法连接 Codex 桌面，请先打开电脑上的聊天')); });
      socket.on('close', () => {
        clearTimeout(timer); body = null;
        const error = this.disconnectError || fail('桌面连接已断开'); reject(error);
        if (this.socket !== socket) return;
        for (const p of this.pending.values()) p.reject(error);
        this.pending.clear(); this.emit('disconnect', error);
      });
      socket.on('data', chunk => {
        try {
          // Allocate once per validated frame; large image histories arrive in many chunks.
          for (let offset = 0; offset < chunk.length;) {
            if (!body) {
              const count = Math.min(4 - headerBytes, chunk.length - offset);
              chunk.copy(header, headerBytes, offset, offset + count); headerBytes += count; offset += count;
              if (headerBytes < 4) continue;
              const size = header.readUInt32LE(); headerBytes = 0;
              if (!size) throw fail('桌面响应格式无效，请刷新或重新选择聊天');
              if (size > MAX_FRAME) throw fail('聊天数据超过 128 MB，无法连接；请在电脑另开聊天或减少附件');
              body = Buffer.allocUnsafe(size); bodyBytes = 0;
            }
            const count = Math.min(body.length - bodyBytes, chunk.length - offset);
            chunk.copy(body, bodyBytes, offset, offset + count); bodyBytes += count; offset += count;
            if (bodyBytes < body.length) continue;
            const message = JSON.parse(body.toString('utf8')); body = null; bodyBytes = 0;
            const key = message.type === 'response' ? message.requestId : message.jsonrpc === '2.0' ? message.id : null;
            if (key != null && this.pending.has(key)) { this.pending.get(key).resolve(message); this.pending.delete(key); }
            else this.emit('message', message);
          }
        } catch (error) { this.close(error.status ? error : fail('桌面响应格式无效，请刷新或重新选择聊天')); }
      });
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }
  send(message) {
    if (!this.socket || this.socket.destroyed) throw fail('桌面连接已断开');
    const body = Buffer.from(JSON.stringify(message)); if (body.length > MAX_FRAME) throw fail('请求过大', 400);
    const header = Buffer.alloc(4); header.writeUInt32LE(body.length); this.socket.write(Buffer.concat([header, body]));
  }
  request(message, id) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(fail('桌面响应超时，送达状态待确认')); }, this.timeoutMs);
      this.pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
      try { this.send(message); } catch (error) { this.pending.get(id).reject(error); this.pending.delete(id); }
    });
  }
  close(error) { if (error) this.disconnectError = error; this.socket?.destroy(); }
}

export function applyPatches(snapshot, patches) {
  let result = structuredClone(snapshot);
  if (!Array.isArray(patches)) throw fail('未知状态补丁');
  for (const { op, path: parts, value } of patches) {
    if (!Array.isArray(parts) || parts.some(k => ['__proto__', 'prototype', 'constructor'].includes(k)) || !['add','remove','replace'].includes(op)) throw fail('无效状态补丁');
    if (!parts.length) { if (op !== 'replace') throw fail('无效根补丁'); result = structuredClone(value); continue; }
    let target = result;
    for (const key of parts.slice(0, -1)) { if (!target || !Object.hasOwn(target, key)) throw fail('状态补丁路径不存在'); target = target[key]; }
    const key = parts.at(-1);
    if (!target || typeof target !== 'object') throw fail('状态补丁路径不存在');
    if (Array.isArray(target)) {
      if (!Number.isInteger(key) || key < 0 || key > target.length || (op !== 'add' && key >= target.length)) throw fail('状态补丁索引错误');
      if (op === 'add') target.splice(key, 0, structuredClone(value)); else if (op === 'remove') target.splice(key, 1); else target[key] = structuredClone(value);
    } else { if (op !== 'add' && !Object.hasOwn(target, key)) throw fail('状态补丁字段不存在'); if (op === 'remove') delete target[key]; else target[key] = structuredClone(value); }
  }
  return result;
}

function turnsOf(snapshot) {
  const turns = [...Object.values(snapshot.turnHistory?.history?.entitiesByKey ?? {}), ...(snapshot.turns ?? [])];
  return [...new Map(turns.filter(t => Array.isArray(t.items)).map((t, i) => [t.turnId ?? `local-${i}`, t])).values()].sort((a,b) => (a.turnStartedAtMs ?? 0) - (b.turnStartedAtMs ?? 0));
}
function replyAnswers(items) {
  const answers = new Map();
  for (const item of items) {
    if (item.type !== 'userMessage' && !(item.type === 'steeringUserMessage' && item.status === 'accepted')) continue;
    const content = item.content ?? item.input;
    if (content?.length !== 1 || content[0].type !== 'text') continue;
    const match = /^<send_user_message_question_reply>\s*([\s\S]*)\s*<\/send_user_message_question_reply>$/.exec(content[0].text.trim());
    if (match) try { const parsed = JSON.parse(match[1]); for (const answer of Array.isArray(parsed) ? parsed : [parsed]) if (typeof answer.answer === 'string') answers.set(answer.questionItemId, answer.answer); } catch { /* ordinary text */ }
  }
  return answers;
}
export function extractState(snapshot) {
  const empty = { connected: false, status: 'disconnected', lastReply: null, questions: [], approvals: [] };
  if (!snapshot?.id || (snapshot.hostId && snapshot.hostId !== 'local') || (!Array.isArray(snapshot.turns) && !snapshot.turnHistory?.history?.entitiesByKey) || !Array.isArray(snapshot.requests)) return empty;
  const turns = turnsOf(snapshot), questions = [], approvals = [];
  const items = turns.flatMap(t => t.items), replies = replyAnswers(items);
  let lastReply = null;
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type === 'agentMessage' && ['final','final_answer'].includes(item.phase) && typeof item.text === 'string' && turn.status === 'completed') {
        const bytes = Buffer.from(item.text); const truncated = bytes.length > 256 * 1024;
        const start=turn.turnStartedAtMs,duration=turn.durationMs;
        const timed=Number.isSafeInteger(start)&&start>=0&&Number.isSafeInteger(duration)&&duration>=0&&Number.isSafeInteger(start+duration)&&start+duration<=8640000000000000;
        lastReply = { text: truncated ? bytes.subarray(0, 256 * 1024).toString('utf8') + '\n\n回复过长，请在电脑查看完整内容。' : item.text, turnId: turn.turnId, phase: 'final', truncated, durationMs:timed?duration:null, completedAtMs:timed?start+duration:null };
      }
      if (item.type === 'agentMessage' && Array.isArray(item.questions)) item.questions.forEach((q, index) => {
        const questionId = JSON.stringify(['request_user_input_async', item.id, index]);
        questions.push({kind:'async',questionId,turnId:turn.turnId,requestId:item.id,status:replies.has(questionId)?'answered':turn.status==='inProgress'?'pending':'cancelled',answer:replies.get(questionId),questions:[{id:questionId,question:q.title,options:q.options ?? []}]});
      });
    }
  }
  for (const request of snapshot.requests) {
    const p = request.params;
    if (!p || p.threadId !== snapshot.id) continue;
    if (request.method === 'item/tool/requestUserInput' && Array.isArray(p.questions)) questions.push({kind:'native',questionId:`native:${request.id}`,requestId:request.id,turnId:p.turnId,status:'pending',questions:p.questions});
    if (['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(request.method)) approvals.push({questionId:`approval:${request.id}`,requestId:request.id,itemId:p.itemId,turnId:p.turnId,kind:request.method.includes('commandExecution')?'command':'file',title:p.reason || 'Codex 需要审批',body:JSON.stringify(p,null,2),status:'pending'});
  }
  const latest = turns.at(-1); const active = latest?.status === 'inProgress' || snapshot.threadRuntimeStatus?.type === 'active';
  return {connected:true,status:questions.some(q=>q.status==='pending')?'question':approvals.length?'approval':active?'processing':latest?.status==='interrupted'?'cancelled':latest?.error?'error':'complete',lastReply,questions:questions.slice(-100),approvals,activeTurnId:active?latest?.turnId:null};
}

export class DesktopBridge {
  constructor({logger=console,dataDirectory,toolsPipe,ipcPipe,timeoutMs=3500,ledger}={}) {
    this.logger=logger; this.toolsPipe=toolsPipe; this.toolsPipeOverride=toolsPipe; this.ipcPipe=ipcPipe; this.timeoutMs=timeoutMs; this.selectedThread=null; this.generation=0; this.queue=Promise.resolve(); this.waiters=new Set(); this.error=null;
    this.ledgerFile=dataDirectory?path.join(dataDirectory,'desktop-deliveries.json'):null;
    this.ledger=ledger??{};
    if(!ledger&&this.ledgerFile&&fs.existsSync(this.ledgerFile)) { this.ledger=JSON.parse(fs.readFileSync(this.ledgerFile,'utf8')); if(!this.ledger||Array.isArray(this.ledger))throw fail('发送记录损坏，请保留文件并检查'); }
  }
  async start() {
    if(this.clientId&&this.pipe?.socket&&!this.pipe.socket.destroyed)return;
    if(this.starting)return this.starting;
    this.starting=(async()=>{
      this.pipe?.close(); this.clientId=null; this.snapshot=null;
      const pipe=new FramedPipe(resolveDesktopEndpoint({endpoint:this.ipcPipe}),{timeoutMs:this.timeoutMs}); this.pipe=pipe;
      pipe.on('message',m=>this.onMessage(m));
      pipe.on('disconnect',error=>{if(this.pipe!==pipe)return;this.clientId=null;this.snapshot=null;this.error=error?.message==='桌面连接已断开'?'Codex 桌面连接已断开，请刷新或重新选择聊天':error?.message;this.wake();});
      await pipe.connect(); const result=await this.request('initialize',{clientType:'agent-bridge'},0); if(!result.result?.clientId)throw fail('桌面初始化协议不兼容');this.clientId=result.result.clientId;
    })().finally(()=>{this.starting=null;});return this.starting;
  }
  async request(method,params,version=1,targetClientId) {
    const requestId=randomUUID();const result=await this.pipe.request({type:'request',requestId,sourceClientId:this.clientId??'initializing-client',version,method,params,targetClientId,timeoutMs:this.timeoutMs},requestId);
    if(result.method!==method||result.resultType!=='success')throw fail('桌面未接受操作，请在电脑打开对应聊天后重试');return result;
  }
  follow(following) {
    if(this.clientId&&this.owner&&this.selectedThread)this.pipe.send({type:'broadcast',sourceClientId:this.clientId,version:1,method:'thread-stream-following-changed',targetClientIds:[this.owner],params:{hostId:'local',conversationId:this.selectedThread.id,following}});
  }
  wake(){for(const callback of [...this.waiters])callback();}
  onMessage(m) {
    if(m.type==='client-discovery-request'){this.pipe.send({type:'client-discovery-response',requestId:m.requestId,response:{canHandle:false}});return;}
    if(m.method==='client-status-changed'&&m.params?.clientId===this.owner&&m.params.status==='disconnected'){this.snapshot=null;this.error='聊天已在电脑关闭，请重新打开';this.wake();return;}
    if(m.method!=='thread-stream-state-changed'||m.sourceClientId!==this.owner||m.params?.conversationId!==this.selectedThread?.id)return;
    if(m.version!==11){this.snapshot=null;this.error='Codex 桌面协议已变化，请更新手机桥';this.wake();return;}
    const change=m.params.change;
    try {
      if(change?.type==='snapshot') { if(change.conversationState.id!==this.selectedThread.id)throw fail('聊天身份不符');this.snapshot=change.conversationState; }
      else if(change?.type==='patches'&&this.snapshot&&change.baseRevision===this.revision)this.snapshot=applyPatches(this.snapshot,change.patches);
      else {this.snapshot=null;this.follow(true);return;}
      this.revision=change.revision;this.snapshotSequence=(this.snapshotSequence??0)+1;this.error=extractState(this.snapshot).connected?null:'不支持当前桌面聊天结构';
      this.reconcile();
    }catch{this.snapshot=null;this.error='聊天状态已变化，正在重新同步';this.follow(true);}
    this.wake();
  }
  async fresh(threadId) {
    const generation=this.generation;
    if(this.selectedThread?.id!==threadId)throw fail('请先选择对应聊天',409);
    await this.start();const owner=await this.request('thread-owner-discovery',{hostId:'local',conversationId:threadId});
    if(generation!==this.generation||this.selectedThread?.id!==threadId)throw fail('所选聊天已变化',409);
    if(this.owner&&owner.handledByClientId!==this.owner){this.snapshot=null;this.owner=null;throw fail('聊天持有者已变化，请重新选择',409);}
    if(!owner.handledByClientId||owner.result?.supportsUntrustedAppInput!==true)throw fail('该聊天暂不支持手机输入');
    this.owner=owner.handledByClientId;this.error=null;const before=this.snapshotSequence??0;
    await new Promise((resolve,reject)=>{
      const done=()=>{if(generation!==this.generation||this.error||!this.clientId){cleanup();reject(fail(this.error||'聊天选择已变化',409));}else if((this.snapshotSequence??0)>before&&this.snapshot){cleanup();resolve();}};
      const timer=setTimeout(()=>{cleanup();reject(fail('等待桌面最新状态超时'));},this.timeoutMs);
      const cleanup=()=>{clearTimeout(timer);this.waiters.delete(done);};this.waiters.add(done);
      try{this.follow(true);}catch(e){cleanup();reject(e);}
    });
    if(!extractState(this.snapshot).connected)throw fail('桌面状态结构不兼容');
    return this.snapshot;
  }
  async selectThread(threadId) {
    if(!validId(threadId))throw fail('聊天 ID 不合法',400);
    this.clearSelection();const generation=this.generation;this.selectedThread={id:threadId,title:threadId,hostId:'local'};this.error=null;
    try{await this.fresh(threadId);this.selectedThread={id:threadId,title:this.snapshot.title??threadId,cwd:this.snapshot.cwd??'',hostId:'local'};return this.selectedThread;}catch(e){if(this.generation===generation)this.clearSelection();throw e;}
  }
  clearSelection(){try{this.follow(false);}catch{}this.generation++;this.selectedThread=null;this.owner=null;this.snapshot=null;this.error=null;this.wake();}
  stop(){this.clearSelection();this.pipe?.close();this.clientId=null;}
  getState(){const state=extractState(this.snapshot);return {...state,connected:state.connected&&!!this.clientId&&!this.error,selectedThread:this.selectedThread,error:this.error,deliveries:Object.entries(this.ledger).filter(([,v])=>v.threadId===this.selectedThread?.id).slice(-20).map(([id,v])=>({id,state:v.state}))};}
  async listThreads(){
    // This seed is read-only tool context, never a selected send target.
    const index=path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'session_index.jsonl');
    const localThreads=localIndexThreads(index);
    const contextThread=process.env.CODEX_THREAD_ID||localThreads[0]?.id;
    if(!contextThread)throw fail('尚未找到本机聊天，请在 Codex 中打开一个已有聊天');
    const endpoints=discoverToolsEndpoints({env:this.toolsPipeOverride?{...process.env,CODEX_APP_TOOLS_PIPE_PATH:this.toolsPipeOverride}:process.env});
    for(const endpoint of [...new Set(endpoints)]) {
      const pipe=new FramedPipe(endpoint,{timeoutMs:this.timeoutMs});
      try {
        await pipe.connect();const catalog=await pipe.request({jsonrpc:'2.0',id:1,method:'tools/list',params:{threadStartKind:'all'}},1);
        if(!catalog.result?.tools?.some(t=>t.name==='list_threads'))continue;
        const response=await pipe.request({jsonrpc:'2.0',id:2,method:'tools/call',params:{namespace:'codex_app',tool:'list_threads',arguments:{limit:50},callerSource:'codex',callId:'agent-bridge-'+randomUUID(),threadId:contextThread,turnId:'agent-bridge-'+randomUUID()}},2);
        const result=response.result;if(!result?.success)continue;
        const raw=result.contentItems?.find(i=>i.type==='inputText')?.text;const list=JSON.parse(raw);
        if(!Array.isArray(list.threads))continue;
        this.toolsPipe=endpoint;
        this.catalogSource='tools';
        return [...(list.pinnedThreads??[]),...list.threads].filter(t=>t.kind==='codex'&&(!t.hostId||t.hostId==='local')).map(t=>({id:t.id,title:t.title,cwd:t.cwd??'',status:t.status,needsAttention:t.needsAttention===true,hostId:'local'}));
      }catch{}finally{pipe.close();}
    }
    this.toolsPipe=null;
    if(process.platform==='darwin'&&localThreads.length){this.catalogSource='session-index';return localThreads;}
    this.catalogSource=null;throw fail('无法读取 Codex 聊天列表，请先打开 Codex 桌面');
  }
  serial(action){const generation=this.generation;const promise=this.queue.then(()=>{if(generation!==this.generation)throw fail('手机授权或所选聊天已变化',409);return action();});this.queue=promise.catch(()=>{});return promise;}
  persist(){if(!this.ledgerFile)return;fs.mkdirSync(path.dirname(this.ledgerFile),{recursive:true});const temp=this.ledgerFile+'.tmp';fs.writeFileSync(temp,JSON.stringify(this.ledger),{mode:0o600});fs.renameSync(temp,this.ledgerFile);}
  reconcile(){
    if(!this.snapshot)return;let changed=false;const items=turnsOf(this.snapshot).flatMap(t=>t.items),replies=replyAnswers(items);
    const delivered=new Set(items.flatMap(i=>i.type==='userMessage'?[i.clientId]:i.type==='steeringUserMessage'&&i.status==='accepted'?[i.clientUserMessageId]:[]));
    for(const [id,r] of Object.entries(this.ledger)){
      if(r.state!=='pending-confirmation'||r.threadId!==this.selectedThread?.id)continue;
      let confirmed=!r.questionId&&delivered.has(id);
      if(r.answerHash&&r.questionId?.startsWith('native:'))confirmed=items.some(i=>i.type==='userInputResponse'&&i.completed&&`native:${i.requestId}`===r.questionId&&answersHash(Object.fromEntries(Object.entries(i.answers??{}).map(([k,v])=>[k,Array.isArray(v)?v[0]:v?.answers?.[0]])))===r.answerHash);
      else if(r.answerHash&&replies.has(r.questionId))confirmed=answersHash({[r.questionId]:replies.get(r.questionId)})===r.answerHash;
      if(confirmed){r.state='accepted';changed=true;}
    }
    if(changed)this.persist();
  }
  duplicate(id,payload){if(!validId(id))throw fail('提交 ID 不合法',400);const digest=hash(payload),old=this.ledger[id];if(old){if(old.digest!==digest)throw fail('重复 ID 的内容不同',409);return old;}return null;}
  assertUnsubmitted(threadId,questionId,turnId){if(Object.values(this.ledger).some(r=>r.threadId===threadId&&r.questionId===questionId&&(!turnId||!r.turnId||r.turnId===turnId)))throw fail('该问题已经提交；结果待确认时请核对电脑，不能重复提交',409);}
  async deliver(id,payload,operation,confirmed,requestKey){
    // Shared across chat queues: reserve synchronously before any awaited operation.
    const old=this.duplicate(id,payload);if(old)return {state:old.state};
    if(Object.keys(this.ledger).length>=10000)throw fail('发送记录已达上限，请备份并维护记录');
    const record={digest:hash(payload),threadId:payload.threadId,turnId:payload.turnId,requestKey,questionId:payload.questionId,answerHash:payload.answers?answersHash(payload.answers):undefined,state:'pending-confirmation',at:Date.now()};this.ledger[id]=record;this.persist();
    try{await operation();await this.fresh(payload.threadId);if(confirmed(this.snapshot))record.state='accepted';}catch{/* A request may have reached the desktop. Never replay. */}
    this.persist();return {state:record.state};
  }
  sendText(text,id){
    const threadId=this.selectedThread.id,input=[{type:'text',text,text_elements:[]}];
    const state=extractState(this.snapshot);
    return state.activeTurnId?this.request('thread-follower-steer-turn',{conversationId:threadId,input,clientUserMessageId:id,attachments:[],restoreMessage:{id,text,cwd:this.snapshot.cwd,createdAt:Date.now(),context:{prompt:text,addedFiles:[],fileAttachments:[],imageAttachments:[]}}},1,this.owner):this.request('thread-follower-start-turn',{conversationId:threadId,turnStart:{request:{threadId,input,clientUserMessageId:id},context:{inheritThreadSettings:true}}},2,this.owner);
  }
  hasMessage(snapshot,id){return turnsOf(snapshot).some(t=>t.items.some(i=>i.type==='userMessage'&&i.clientId===id||i.type==='steeringUserMessage'&&i.clientUserMessageId===id&&i.status==='accepted'));}
  sendMessage({threadId,text,messageId}={},guard=()=>{}){return this.serial(async()=>{
    guard();
    if(this.selectedThread?.id!==threadId)throw fail('所选聊天不匹配',409);
    if(typeof text!=='string'||!text.trim()||text.length>16000)throw fail('消息应为 1–16000 字符',400);
    const payload={threadId,text};const old=this.duplicate(messageId,payload);if(old)return {messageId,state:old.state};
    await this.fresh(threadId);guard();const result=await this.deliver(messageId,payload,()=>this.sendText(text,messageId),s=>this.hasMessage(s,messageId));return {messageId,...result};
  });}
  answerQuestion({threadId,questionId,turnId,answers,submissionId}={},guard=()=>{}){return this.serial(async()=>{
    guard();
    if(this.selectedThread?.id!==threadId)throw fail('所选聊天不匹配',409);
    if(typeof questionId!=='string'||!answers||typeof answers!=='object'||Array.isArray(answers))throw fail('答案格式不合法',400);
    const payload={threadId,questionId,answers,...(turnId?{turnId}:{})};const old=this.duplicate(submissionId,payload);if(old)return {questionId,state:old.state};
    this.assertUnsubmitted(threadId,questionId,turnId);
    await this.fresh(threadId);const q=extractState(this.snapshot).questions.find(q=>q.questionId===questionId&&q.status==='pending');if(!q)throw fail('问题已处理、取消或过期',409);
    guard();if(turnId&&q.turnId!==turnId)throw fail('问题轮次已变化，请重新打开',409);
    if(Object.keys(answers).length!==q.questions.length||q.questions.some(p=>typeof answers[p.id]!=='string'||!answers[p.id].trim()||answers[p.id].length>16000))throw fail('请回答每个问题（单题最多 16000 字符）',400);
    let operation,confirmed;
    if(q.kind==='native'){
      const response={answers:Object.fromEntries(q.questions.map(p=>[p.id,{answers:[answers[p.id]]}]))};
      operation=()=>this.request('thread-follower-submit-user-input',{conversationId:threadId,requestId:q.requestId,response},1,this.owner);
      confirmed=s=>turnsOf(s).some(t=>t.items.some(i=>i.type==='userInputResponse'&&i.requestId===q.requestId&&i.completed&&q.questions.every(p=>JSON.stringify(i.answers?.[p.id])===JSON.stringify(response.answers[p.id])||JSON.stringify(i.answers?.[p.id])===JSON.stringify([answers[p.id]]))));
    }else{
      const text='<send_user_message_question_reply>\n'+JSON.stringify(q.questions.map(p=>({questionItemId:p.id,question:p.question,answer:answers[p.id]})))+'\n</send_user_message_question_reply>';
      operation=()=>this.sendText(text,submissionId);confirmed=s=>replyAnswers(turnsOf(s).flatMap(t=>t.items)).get(questionId)===answers[questionId];
    }
    return {questionId,...await this.deliver(submissionId,payload,operation,confirmed)};
  });}
  decideApproval({threadId,questionId,turnId,choice,submissionId}={},guard=()=>{}){return this.serial(async()=>{
    guard();
    if(this.selectedThread?.id!==threadId)throw fail('所选聊天不匹配',409);
    if(!['approve','deny'].includes(choice))throw fail('请选择批准或拒绝',400);
    const payload={threadId,questionId,choice,...(turnId?{turnId}:{})};const old=this.duplicate(submissionId,payload);if(old)return {questionId,state:old.state};
    this.assertUnsubmitted(threadId,questionId,turnId);
    await this.fresh(threadId);const q=extractState(this.snapshot).approvals.find(q=>q.questionId===questionId);if(!q)throw fail('审批已处理或取消',409);
    guard();if(turnId&&q.turnId!==turnId)throw fail('审批轮次已变化，请重新打开',409);
    return {questionId,...await this.deliver(submissionId,payload,()=>this.request(`thread-follower-${q.kind==='command'?'command':'file'}-approval-decision`,{conversationId:threadId,requestId:q.requestId,decision:choice==='approve'?'accept':'decline'},1,this.owner),s=>!s.requests.some(r=>r.id===q.requestId),JSON.stringify([threadId,q.turnId,String(q.itemId??q.requestId)]))};
  });}
}
