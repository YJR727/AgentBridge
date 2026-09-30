import {DesktopBridge} from './desktop.mjs';

const fail=message=>Object.assign(new Error(message),{status:409});
const needsWatch=t=>['active','needsInput','needsAttention','waiting','requiresAttention'].includes(t.status)||t.needsAttention===true;

/** Device IDs route views, never authorize requests. One queue/ledger per real chat. */
export class DesktopSessions {
  constructor(options={}) {
    this.options=options;this.catalog=new DesktopBridge(options);this.entries=new Map();this.bindings=new Map();
    this.waiters=new Set();this.watched=new Set();this.generation=0;this.selectionSequence=0;
  }
  createBridge(){return new DesktopBridge({...this.options,ledger:this.catalog.ledger});}
  wake(){for(const callback of [...this.waiters])callback();}
  async ensure(threadId){
    let entry=this.entries.get(threadId);
    if(!entry){const bridge=this.createBridge();entry={bridge,error:null,ready:null};entry.changed=()=>this.wake();bridge.waiters.add(entry.changed);this.entries.set(threadId,entry);}
    if(entry.ready)return entry.ready;
    if(entry.bridge.getState().connected)return entry.bridge;
    const generation=this.generation;
    entry.ready=entry.bridge.selectThread(threadId).then(()=>{
      if(generation!==this.generation||this.entries.get(threadId)!==entry){entry.bridge.stop();throw fail('授权或聊天连接已变化');}
      entry.error=null;return entry.bridge;
    }).catch(e=>{entry.error=e.message;throw e;}).finally(()=>{entry.ready=null;this.wake();});
    return entry.ready;
  }
  async selectThread(threadId,deviceId='legacy'){
    if(typeof threadId!=='string'||!threadId||threadId.length>160)throw fail('聊天 ID 不合法');
    const binding={threadId,sequence:++this.selectionSequence};this.bindings.set(deviceId,binding);this.wake();
    try{const bridge=await this.ensure(threadId);if(this.bindings.get(deviceId)!==binding)throw fail('所选聊天已变化');this.reap();return bridge.getState().selectedThread;}
    catch(e){if(this.bindings.get(deviceId)===binding)this.bindings.delete(deviceId);throw e;}
  }
  getState(deviceId='legacy'){
    const id=this.bindings.get(deviceId)?.threadId,entry=this.entries.get(id);
    if(!id)return {connected:false,status:'disconnected',selectedThread:null,lastReply:null,questions:[],approvals:[],deliveries:[]};
    const state=entry?.bridge.getState();
    return {...state,selectedThread:state?.selectedThread??{id,title:id},connected:!!state?.connected,error:entry?.error??state?.error??null};
  }
  getStates(){return [...this.entries.values()].map(e=>e.bridge.getState());}
  listPending(){
    return this.getStates().filter(s=>s.connected&&s.selectedThread).flatMap(s=>[
      ...(s.questions??[]).filter(q=>q.status==='pending').map(q=>({...q,kind:'question',questionKind:q.kind})),
      ...(s.approvals??[]).map(q=>({...q,kind:'approval',approvalKind:q.kind}))
    ].filter(q=>q.turnId&&q.questionId).map(q=>({...q,threadId:s.selectedThread.id,threadTitle:s.selectedThread.title})));
  }
  getSummary(){
    const ids=new Set([...this.bindings.values()].map(b=>b.threadId));
    return {devices:this.bindings.size,threads:[...ids].map(id=>{const e=this.entries.get(id),s=e?.bridge.getState();return {id,title:s?.selectedThread?.title??id,connected:!!s?.connected,devices:[...this.bindings.values()].filter(b=>b.threadId===id).length};}),errors:[...(this.discoveryError?[{id:null,error:'后台待办检测：'+this.discoveryError}]:[]),...[...this.entries].filter(([,e])=>e.error||e.bridge.getState().error).map(([id,e])=>({id,error:e.error??e.bridge.getState().error}))]};
  }
  listThreads(){return this.catalog.listThreads();}
  async sendMessage(body,deviceId='legacy'){
    const binding=this.bindings.get(deviceId),entry=this.entries.get(body.threadId);
    const guard=()=>{if(!binding||binding.threadId!==body.threadId||this.bindings.get(deviceId)!==binding)throw fail('设备所选聊天已变化或不匹配');};
    guard();if(!entry)throw fail('聊天未连接');return entry.bridge.sendMessage(body,guard);
  }
  async action(body,deviceId,method,submissionGuard=()=>{}){
    const entry=this.entries.get(body.threadId),generation=this.generation;
    const guard=()=>{
      submissionGuard();
      if(generation!==this.generation)throw fail('配对已变化');
      if(deviceId==='legacy'&&!body.turnId){if(this.bindings.get(deviceId)?.threadId!==body.threadId)throw fail('所选聊天不匹配');return;}
      if(!body.turnId||!this.listPending().some(q=>q.threadId===body.threadId&&q.turnId===body.turnId&&q.questionId===body.questionId))throw fail('申请已处理、失效或轮次已变化');
    };
    guard();if(!entry)throw fail('来源聊天未连接');return entry.bridge[method](body,guard);
  }
  answerQuestion(body,deviceId='legacy'){return this.action(body,deviceId,'answerQuestion');}
  decideApproval(body,deviceId='legacy',guard){return this.action(body,deviceId,'decideApproval',guard);}
  reap(){
    for(const [id,e] of this.entries){const s=e.bridge.getState();
      if(e.ready||this.watched.has(id)||[...this.bindings.values()].some(b=>b.threadId===id)||s.activeTurnId||s.status==='processing'||(s.questions??[]).some(q=>q.status==='pending')||(s.approvals??[]).length)continue;
      e.bridge.waiters.delete(e.changed);e.bridge.stop();this.entries.delete(id);
    }
  }
  async scan(){
    if(this.scanning)return;this.scanning=true;const generation=this.generation;
    try{
      const threads=await this.listThreads();if(generation!==this.generation)return;
      this.discoveryError=this.catalog.catalogSource==='session-index'?'Mac 聊天目录不含运行状态；仅监测已选聊天，其他聊天的待办提醒尚未验收':null;
      this.watched=new Set(threads.filter(t=>(!t.hostId||t.hostId==='local')&&needsWatch(t)).map(t=>t.id));
      const ids=new Set([...this.watched,...[...this.bindings.values()].map(b=>b.threadId)]);
      // ponytail: at most three simultaneous large snapshots; no new worker pool dependency.
      const pending=[...ids];for(let i=0;i<pending.length;i+=3){if(generation!==this.generation)return;await Promise.allSettled(pending.slice(i,i+3).map(id=>this.ensure(id)));}
      if(generation===this.generation)this.reap();
    }catch(e){this.discoveryError=e.message;}finally{this.scanning=false;}
  }
  start(){if(this.timer)return;void this.scan();this.timer=setInterval(()=>void this.scan(),5000);this.timer.unref?.();}
  clearSelection(){this.generation++;this.bindings.clear();this.watched.clear();for(const e of this.entries.values()){e.bridge.waiters.delete(e.changed);e.bridge.stop();}this.entries.clear();this.wake();}
  stop(){clearInterval(this.timer);this.timer=null;this.clearSelection();this.catalog.stop();}
}
