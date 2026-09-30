import test from 'node:test';
import assert from 'node:assert/strict';
import {DesktopSessions} from '../lib/desktop-sessions.mjs';

function fixture(t){
 const sessions=new DesktopSessions(),made=new Map();let threads=[];
 sessions.catalog.listThreads=async()=>threads;
 sessions.createBridge=()=>{const bridge={waiters:new Set(),ledger:sessions.catalog.ledger,connected:true,questions:[],approvals:[],status:'complete',queue:Promise.resolve(),
  async selectThread(id){this.selectedThread={id,title:'Title '+id};made.set(id,(made.get(id)||0)+1);return this.selectedThread;},
  getState(){return {connected:this.connected&&!!this.selectedThread,selectedThread:this.selectedThread,questions:this.questions,approvals:this.approvals,status:this.status};},
  sendMessage(body,guard){const p=this.queue.then(()=>{guard();this.sent=body;return {state:'accepted'};});this.queue=p.catch(()=>{});return p;},
  decideApproval(body,guard){return this.sendMessage(body,guard).then(r=>{this.approvals=[];return r;});},
  answerQuestion(body,guard){return this.sendMessage(body,guard).then(r=>{this.questions=[];return r;});},stop(){this.stopped=true;}};return bridge;};
 t.after(()=>sessions.stop());return {sessions,made,setThreads:value=>threads=value};
}
test('device selections share chat connections, queued messages fail after target changes',async t=>{
 const {sessions:s,made}=fixture(t);await s.selectThread('A','phone');await s.selectThread('B','ipad');await s.selectThread('A','other');
 assert.equal(s.getState('phone').selectedThread.id,'A');assert.equal(s.getState('ipad').selectedThread.id,'B');assert.equal(made.get('A'),1);
 const a=s.entries.get('A').bridge;let release;a.queue=new Promise(r=>release=r);
 const queued=s.sendMessage({threadId:'A',text:'old',messageId:'x'},'phone');await s.selectThread('B','phone');release();await assert.rejects(queued,/变化|不匹配/);assert.equal(a.sent,undefined);
 s.clearSelection();assert.equal(s.getState('ipad').selectedThread,null);
});
test('monitor discovers unselected C, pending survives idle, unrelated histories stay closed',async t=>{
 const {sessions:s,setThreads,made}=fixture(t);await s.selectThread('A','phone');await s.selectThread('B','ipad');
 setThreads([{id:'C',status:'active'},{id:'D',status:'notLoaded'},{id:'E',status:'idle'}]);await s.scan();assert.equal(made.get('C'),1);assert.equal(made.has('D'),false);assert.equal(made.has('E'),false);
 const c=s.entries.get('C').bridge;c.approvals=[{questionId:'approval:1',turnId:'C-turn',status:'pending'}];
 setThreads([{id:'C',status:'idle'}]);await s.scan();assert.equal(s.listPending()[0].threadTitle,'Title C');
 await s.decideApproval({threadId:'C',turnId:'C-turn',questionId:'approval:1',submissionId:'choice',choice:'approve'},'phone');
 assert.equal(s.getState('phone').selectedThread.id,'A');assert.equal(s.getState('ipad').selectedThread.id,'B');
 await s.scan();assert.equal(s.entries.has('C'),false);
});
test('origin and turn guards reject stale requests, failures do not break another chat',async t=>{
 const {sessions:s}=fixture(t);await s.selectThread('A','phone');await s.selectThread('B','ipad');
 s.entries.get('A').bridge.connected=false;assert.equal(s.getState('ipad').connected,true);
 await assert.rejects(s.decideApproval({threadId:'B',turnId:'old',questionId:'approval:1'},'phone'),/处理|失效|轮次/);
 assert.equal(s.getSummary().devices,2);
});
test('discovery failure is visible without disconnecting selected chat, success clears it',async t=>{
 const {sessions:s}=fixture(t);await s.selectThread('A','phone');s.catalog.listThreads=async()=>{throw Error('list unavailable');};await s.scan();
 assert.equal(s.getState('phone').connected,true);assert.ok(s.getSummary().errors.some(e=>e.error.includes('list unavailable')));
 s.catalog.listThreads=async()=>[];await s.scan();assert.equal(s.getSummary().errors.length,0);
});
test('index fallback reports that unknown chats cannot be watched for pending requests',async t=>{
 const {sessions:s,setThreads,made}=fixture(t);await s.selectThread('A','phone');
 s.catalog.catalogSource='session-index';setThreads([{id:'C',status:'unknown',hostId:'local'}]);await s.scan();
 assert.equal(made.has('C'),false);
 assert.ok(s.getSummary().errors.some(e=>e.error.includes('仅监测已选聊天')));
 s.catalog.catalogSource='tools';await s.scan();assert.equal(s.getSummary().errors.length,0);
});
