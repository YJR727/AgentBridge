import {renderMarkdown,renderCode,plainMarkdown} from './markdown.js';
import {ChatStatus,formatReplyTime} from './chat-status.js';
const connection=new ChatStatus(),DEVICE_KEY='ab_device_id';
const deviceId=localStorage.getItem(DEVICE_KEY)||crypto.randomUUID();localStorage.setItem(DEVICE_KEY,deviceId);
let pendingConfirmedAt=-1;

const TOKEN_KEY='ab_app_token', DRAFT_KEY='ab_command_draft', MESSAGE_KEY='ab_pending_message';
const $=id=>document.getElementById(id);
const state={token:null,authorized:false,page:'chat',events:[],codex:{},hello:null,registration:null,subscription:null,refreshing:false,sending:false,replySource:null,pendingSignature:'',detail:null};
const appMode=matchMedia('(display-mode: standalone)');
function showAppMode(){const installed=appMode.matches||navigator.standalone===true;$('app-mode').textContent=installed?'已从独立 App 窗口打开':'当前在浏览器中，可添加到主屏幕，像 App 一样打开。';$('home-screen-guide').open=!installed;}
showAppMode();appMode.addEventListener('change',showAppMode);
function node(tag,text='',className=''){const el=document.createElement(tag);el.textContent=text;el.className=className;return el;}
function button(parent,label,action,className=''){const b=node('button',label,className);b.type='button';b.onclick=action;parent.append(b);return b;}
function toast(message){$('toast').textContent=message;$('toast').classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').classList.remove('show'),3500);}
function feedback(text){$('send-state').textContent=text;$('send-state').classList.toggle('hidden',!text);}
function fmtTime(value){return value?new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';}
function setConn(ok,text){$('connection-state').textContent=text;$('connection-state').classList.toggle('error',!ok);}
async function copy(text){try{await navigator.clipboard.writeText(text);toast('已复制');}catch{toast('无法自动复制，请长按正文选择复制。');}}
async function api(path,{body,token=state.token,timeout=20000}={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
  try{
    const res=await fetch(path,{method:body===undefined?'GET':'POST',headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(token?{Authorization:`Bearer ${token}`}:{}) ,'X-Agent-Bridge-Device':deviceId},credentials:'include',body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal});
    const data=await res.json().catch(()=>null);
    if(!res.ok){const error=new Error(data?.error||`HTTP ${res.status}`);error.status=res.status;throw error;}
    return data;
  }finally{clearTimeout(timer);}
}
function showPage(page,push=true){
  if(!['chat','pending','settings'].includes(page))page='chat';state.page=page;
  for(const p of ['chat','pending','settings'])$('view-'+p).classList.toggle('hidden',p!==page);
  for(const b of document.querySelectorAll('[data-page]')){if(b.dataset.page===page)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');}
  if(push&&location.hash!==`#${page}`)history.pushState({page},'',`#${page}`);
  if(page==='settings')void refreshSubscriptionState().catch(e=>toast(e.message));
}
function openDialog(title,model){
  $('detail-title').textContent=title;$('detail-content').replaceChildren();$('detail-actions').replaceChildren();$('detail-feedback').textContent='';state.detail=model;
  if(!$('detail-dialog').open){history.pushState({page:state.page,detail:true},'','#detail');$('detail-dialog').showModal();}
  $('detail-content').scrollTop=0;return $('detail-content');
}
function closeDetail(){if(history.state?.detail)history.back();else $('detail-dialog').close();}
function lockDetail(){for(const b of $('detail-actions').querySelectorAll('button'))b.disabled=true;}
function detailMessage(message){$('detail-feedback').textContent=message;}
function isCurrent(model){return state.detail===model&&$('detail-dialog').open;}
function renderConnection(){
  const good=state.authorized&&document.visibilityState==='visible'&&connection.isConnected(performance.now());
  $('chat-connection').classList.toggle('online',good);$('chat-connection-text').textContent=good?'已连接':state.codex.selectedThread?'未连接 · 等待确认':'未连接 · 请选择聊天';
  $('send-command').disabled=!good||!state.codex.selectedThread||state.sending;
}
function targetValid(target){return state.authorized&&connection.isConnected(performance.now())&&state.codex.selectedThread?.id===target;}
function pendingValid(item){return state.authorized&&pendingConfirmedAt>=0&&performance.now()-pendingConfirmedAt<10000&&pendingItems().some(i=>i.id===item.id&&i.threadId===item.threadId&&i.turnId===item.turnId);}
function eventActive(e){return e.needsDecision&&e.state==='pending'&&e.expiresAt>Date.now();}
function eventLabel(e){return e.state==='resolved'?`已记录：${e.decision?.choice==='approve'?'批准':'拒绝'}`:e.state==='cancelled'?'已取消':e.state==='expired'||(e.expiresAt&&e.expiresAt<=Date.now())?'已过期':e.needsDecision?'等待审批':'已记录';}
function pendingItems(){return [
  ...(state.codex.pending||[]).map(q=>({kind:q.kind,id:q.questionId,turnId:q.turnId,threadId:q.threadId,threadTitle:q.threadTitle,data:q,title:q.title||q.questions?.[0]?.question||'Codex 需要您处理'})),
  ...state.events.filter(eventActive).map(e=>({kind:'event',id:e.id,threadTitle:e.threadTitle||e.sessionId,data:e,title:e.title,summary:e.summary}))
];}
function renderPending(){
  const list=pendingItems();$('pending-label').textContent=list.length?`待办 · ${list.length}`:'待办';$('empty-pending').classList.toggle('hidden',!!list.length);
  $('pending-banner').classList.toggle('hidden',!list.length);$('pending-banner').textContent=`有 ${list.length} 项待处理  ›`;
  const signature=JSON.stringify(list);if(signature===state.pendingSignature)return;state.pendingSignature=signature;
  $('pending-items').replaceChildren();
  for(const item of list){const card=node('article','','card pending-item');card.append(node('p',item.kind==='question'?'需要您回答':'需要审批','category'),node('h2',plainMarkdown(item.title)));
    if(item.threadTitle)card.append(node('p','来源聊天：'+item.threadTitle,'muted'));
    if(item.summary)card.append(node('p',plainMarkdown(item.summary),'preview'));
    button(card,item.kind==='question'?'查看并回答  ›':'查看申请详情  ›',()=>openItem(item),'wide');$('pending-items').append(card);
  }
}
function renderChat(){
  const c=state.codex,status={processing:'正在处理 · 下方为最近已完成回复',question:'等待您回答问题',approval:'等待审批',complete:'本轮已完成',cancelled:'本轮已取消',error:'本轮出错，请查看电脑'};
  $('thread-title').textContent=c.selectedThread?.title||'选择电脑上的聊天';$('chat-status').textContent=!state.authorized?'请先在设置中配对电脑':c.error||status[c.status]||'未连接聊天，请选择';
  const source=c.lastReply?.text||'尚无已完成回复，新回复完成后会自动显示。';if(source!==state.replySource){const pos=$('chat-reading').scrollTop;state.replySource=source;renderMarkdown($('reply'),source,copy);$('chat-reading').scrollTop=pos;}
  $('reply-time').textContent=c.lastReply?formatReplyTime(c.lastReply):'';$('reply-time').classList.toggle('hidden',!c.lastReply);
  $('copy-reply').disabled=!c.lastReply?.text;renderConnection();
  const pending=localStorage.getItem(MESSAGE_KEY);
  if(pending&&c.deliveries?.some(d=>d.id===pending&&d.state==='accepted')){localStorage.removeItem(MESSAGE_KEY);if($('command').value.trim()===localStorage.getItem(MESSAGE_KEY+'_text')){$('command').value='';localStorage.removeItem(DRAFT_KEY);resizeComposer();}localStorage.removeItem(MESSAGE_KEY+'_text');feedback('电脑已收到上一条指令');}
  const detail=state.detail;if(detail&&!detail.submitted&&['question','approval','event'].includes(detail.kind)){
    const valid=detail.kind==='event'?state.events.some(e=>e.id===detail.id&&eventActive(e)):pendingValid(detail);
    if(!valid){lockDetail();detailMessage('此请求已处理、失效或连接已变化，请返回后重新打开。');}
  }
  if(detail?.submitted&&detail.submissionId&&c.deliveries?.some(d=>d.id===detail.submissionId&&d.state==='accepted'))detailMessage('电脑已收到提交，请查看对应任务。');
}
async function refresh(){
  if(!state.authorized||state.refreshing)return;state.refreshing=true;const generation=connection.generation;
  try{
    const results=await Promise.allSettled([api('/api/events?limit=80'),api('/api/codex/state')]);
    if(results.some(r=>r.status==='rejected'&&r.reason.status===401)){state.authorized=false;state.codex={};state.events=[];setConn(false,'配对已失效，请重新配对');$('pairing').open=true;showPage('settings');}
    else {
      if(results[0].status==='fulfilled')state.events=results[0].value.events||[];
      if(generation===connection.generation){
        if(results[1].status==='fulfilled'){state.codex=results[1].value;connection.confirm(state.codex.selectedThread?.id||'',generation,performance.now(),state.codex.connected);pendingConfirmedAt=performance.now();}
        else {state.codex={...state.codex,connected:false,error:'连接暂不可用：'+results[1].reason.message};connection.begin(state.codex.selectedThread?.id||'');pendingConfirmedAt=-1;}
      }
      const ok=results.every(r=>r.status==='fulfilled');setConn(ok,ok?'电脑服务在线':'连接暂不可用，请检查电脑与 Tailscale');
    }
    renderChat();renderPending();
  }finally{state.refreshing=false;}
}
async function chooseThread(){
  if(!state.authorized){showPage('settings');return toast('请先配对电脑');}
  const model={kind:'threads'};const body=openDialog('选择电脑聊天',model);body.append(node('p','正在读取聊天…','muted'));
  try{const result=await api('/api/codex/threads');if(!isCurrent(model))return;body.replaceChildren();
    if(!result.threads?.length)body.append(node('p','请先在电脑打开一个已有聊天。'));
    for(const thread of result.threads||[])button(body,thread.title+'\n'+(thread.cwd||''),async()=>{
      for(const b of body.querySelectorAll('button'))b.disabled=true;detailMessage('正在连接所选聊天…');
      connection.begin(thread.id);renderConnection();
      try{await api('/api/codex/select',{body:{threadId:thread.id}});if(isCurrent(model))closeDetail();state.codex={...state.codex,selectedThread:thread,connected:false};await refresh();showPage('chat');}
      catch(e){if(isCurrent(model)){detailMessage(e.message);for(const b of body.querySelectorAll('button'))b.disabled=false;}}
    },'wide option');
  }catch(e){if(isCurrent(model)){body.replaceChildren(node('p',e.message,'error'));}}
}
async function sendCommand(event){
  event.preventDefault();const text=$('command').value.trim(),target=state.codex.selectedThread?.id;if(!text||!targetValid(target)||state.sending)return;
  if(localStorage.getItem(MESSAGE_KEY)){
    openDialog('上一条指令仍待确认',{kind:'uncertain'}).append(node('p','请先在电脑确认是否收到，避免重复执行。解除提示不会自动重发。'));
    button($('detail-actions'),'已在电脑核对',()=>{localStorage.removeItem(MESSAGE_KEY);closeDetail();feedback('已解除提示，请勿重复发送已收到的指令。');},'primary');return;
  }
  const id=crypto.randomUUID();try{localStorage.setItem(MESSAGE_KEY,id);localStorage.setItem(MESSAGE_KEY+'_text',text);localStorage.setItem(DRAFT_KEY,text);}catch{return toast('无法保存发送记录，本次指令未发送。');}
  state.sending=true;renderChat();feedback('正在发送…');
  try{const r=await api('/api/codex/message',{body:{threadId:target,text,messageId:id}});
    if(r.state==='accepted'){localStorage.removeItem(MESSAGE_KEY);localStorage.removeItem(MESSAGE_KEY+'_text');feedback('电脑已收到，等待回复。');if($('command').value.trim()===text){$('command').value='';localStorage.removeItem(DRAFT_KEY);resizeComposer();}}
    else feedback('送达状态待确认，请核对电脑；不会自动重发。');
  }catch(e){if(e.status){localStorage.removeItem(MESSAGE_KEY);feedback('未发送：'+e.message);}else feedback('送达状态待确认，请核对电脑；不会自动重发。');}
  finally{state.sending=false;renderChat();void refresh();}
}
function openItem(item){if(item.kind==='question')openQuestion(item);else if(item.kind==='approval')openApproval(item);else void openEvent(item.id);}
function openQuestion(item){
  if(!pendingValid(item))return toast('连接或所选聊天已变化，请刷新后重新打开。');
  const model={...item,submitted:false},body=openDialog('回答 Codex',model);body.append(node('p','来源聊天：'+item.threadTitle,'muted'));const inputs=new Map(),fields=item.data.questions||[];
  for(const [index,f] of fields.entries()){
    const card=node('section','','card question-field'),question=node('div','','markdown');card.append(node('p',`问题 ${index+1} / ${fields.length}`,'question-index'),question);renderMarkdown(question,f.question||'',copy);
    const id='answer-'+index,answer=node('textarea');answer.id=id;answer.maxLength=16000;answer.rows=3;answer.placeholder='补充或输入您的回答';
    const choices=[];for(const o of f.options||[]){const value=typeof o==='string'?o:o.label,description=typeof o==='string'?'':o.description;
      const b=button(card,plainMarkdown(value)+(description?'\n'+plainMarkdown(description):''),()=>{answer.value=value;answer.dispatchEvent(new Event('input'));},'wide option');b.setAttribute('aria-pressed','false');choices.push({b,value});
    }
    answer.addEventListener('input',()=>{for(const {b,value} of choices)b.setAttribute('aria-pressed',String(answer.value===value));});
    const label=node('label','您的回答');label.htmlFor=id;card.append(label,answer);body.append(card);inputs.set(f.id,answer);
  }
  const key=`ab_answer:${item.threadId}:${item.turnId}:${item.id}`;model.submitted=!!localStorage.getItem(key);detailMessage(model.submitted?'该问题已提交，请核对电脑确认结果。':'答案将回到上方标注的来源聊天。');
  const submit=button($('detail-actions'),'提交答案',async()=>{
    if(!pendingValid(item)){lockDetail();return detailMessage('连接或所选聊天已变化，请返回后重新打开。');}
    const answers={};for(const [id,input] of inputs){if(!input.value.trim()){detailMessage('请回答每个问题');input.focus();return;}answers[id]=input.value.trim();}
    await submitNative(model,key,'/api/codex/answer',{answers},submit);
  },'primary');submit.disabled=model.submitted||!fields.length;
}
async function submitNative(model,key,path,data,retryButton){
  const id=crypto.randomUUID();try{localStorage.setItem(key,id);}catch{return detailMessage('无法保存提交记录，本次未提交。');}
  model.submitted=true;model.submissionId=id;lockDetail();detailMessage('正在提交…');
  try{const r=await api(path,{body:{threadId:model.threadId,turnId:model.turnId,questionId:model.id,submissionId:id,...data}});if(isCurrent(model))detailMessage(r.state==='accepted'?'电脑已收到提交，请查看对应任务。':'送达状态待确认，请核对电脑，不会自动重发。');}
  catch(e){if(isCurrent(model)){detailMessage(e.status?e.message:'送达状态待确认，请核对电脑，不会自动重发。');if(e.status===400&&retryButton){localStorage.removeItem(key);model.submitted=false;retryButton.disabled=false;}}}
  finally{void refresh();}
}
function openApproval(item){
  if(!pendingValid(item))return toast('连接或所选聊天已变化，请刷新后重新打开。');
  const model={...item,submitted:false},body=openDialog('审批申请',model),heading=node('div','','markdown');body.append(node('p','来源聊天：'+item.threadTitle,'muted'),heading);renderMarkdown(heading,item.title,copy);
  body.append(node('p','操作：'+(item.data.approvalKind==='file'?'修改文件':'执行命令')));
  try{const p=JSON.parse(item.data.body);if(p.command)renderCode(body,typeof p.command==='string'?p.command:JSON.stringify(p.command),copy);if(p.cwd)body.append(node('p','目录：'+p.cwd,'muted'));}catch{}
  const full=node('details'),summary=node('summary','查看完整申请与参数');full.append(summary);renderCode(full,item.data.body||'',copy);body.append(full);
  const key=`ab_approval:${item.threadId}:${item.turnId}:${item.id}`;model.submitted=!!localStorage.getItem(key);detailMessage(model.submitted?'该申请已提交，请核对电脑确认结果。':'请确认完整内容后决定，只处理这次申请。');
  for(const choice of ['deny','approve']){const b=button($('detail-actions'),choice==='approve'?'批准':'拒绝',async()=>{
    if(!pendingValid(item)){lockDetail();return detailMessage('连接或所选聊天已变化，请返回后重新打开。');}
    await submitNative(model,key,'/api/codex/approval',{choice});
  },choice==='approve'?'primary':'danger');b.disabled=model.submitted;}
}
async function openEvent(id){
  const model={kind:'event',id,submitted:false},body=openDialog('审批与事件详情',model);body.append(node('p','正在读取详情…','muted'));
  try{const {event:e}=await api('/api/events/'+encodeURIComponent(id));if(!isCurrent(model))return;body.replaceChildren(node('h2',plainMarkdown(e.title||'')));if(e.threadTitle||e.sessionId)body.append(node('p','来源聊天：'+(e.threadTitle||e.sessionId),'muted'));
    const summary=node('div','','markdown');body.append(summary);renderMarkdown(summary,e.summary||'',copy);body.append(node('p','状态：'+eventLabel(e),'muted'));
    const full=node('details');full.append(node('summary','查看完整内容与参数'));if(e.body?.trim().startsWith('{'))renderCode(full,e.body,copy);else {const text=node('div','','markdown');full.append(text);renderMarkdown(text,e.body||'',copy);}
    full.append(node('p',`目录：${e.cwd||'—'}\n来源：${e.source||'—'}\n任务：${e.sessionId||'—'}\n时间：${fmtTime(e.createdAt)}`,'metadata'));body.append(full);
    if(e.source==='codex-desktop-reply'){full.open=true;model.submitted=true;return detailMessage('回复已完成，无需审批。');}
    if(!eventActive(e)){model.submitted=true;return detailMessage('此事件已处理、过期或取消。');}detailMessage('请确认完整内容后决定，只处理这次申请。');
    for(const choice of ['deny','approve'])button($('detail-actions'),choice==='approve'?'批准':'拒绝',async()=>{
      if(!eventActive(e)){lockDetail();return detailMessage('申请已过期，不能继续提交。');}model.submitted=true;lockDetail();detailMessage('正在回传…');
      try{const r=await api('/api/events/'+encodeURIComponent(id)+'/decision',{body:{choice,via:'web-app'}});if(!r.ok||r.decision?.choice!==choice)throw new Error('服务未接受选择');if(isCurrent(model))detailMessage('选择已回传电脑，请查看对应任务结果。');}
      catch(error){if(isCurrent(model))detailMessage('回传未确认：'+error.message+'。请核对电脑。');}finally{void refresh();}
    },choice==='approve'?'primary':'danger');
  }catch(e){if(isCurrent(model)){body.replaceChildren(node('p',e.message,'error'));lockDetail();}}
}
function openHistory(){const body=openDialog('近期记录',{kind:'history'});if(!state.events.length)body.append(node('p','还没有记录','muted'));for(const e of state.events)button(body,plainMarkdown(e.title)+'\n'+eventLabel(e)+' · '+fmtTime(e.createdAt),()=>void openEvent(e.id),'wide option');}
async function registerServiceWorker(){if(!('serviceWorker' in navigator))return;try{state.registration=await navigator.serviceWorker.register('/sw.js',{scope:'/'});}catch{toast('通知组件未能启动，请刷新页面后重试。');}}
async function sendSubscriptionToServer(sub){const s=sub.toJSON();await api('/api/subscribe',{body:{endpoint:s.endpoint,keys:s.keys,userAgent:navigator.userAgent}});}
async function refreshSubscriptionState(){
  const el=$('push-state'),b=$('btn-enable-push');b.disabled=true;
  if(!state.authorized){el.textContent='配对后可开启通知。';return;}
  if(!('PushManager' in window)||!('Notification' in window)||!state.registration){el.textContent='请用 HTTPS 打开。苹果设备需先添加到主屏幕，并从图标进入。';return;}
  state.subscription=await state.registration.pushManager.getSubscription();
  if(state.subscription&&Notification.permission==='granted'){el.textContent='通知已开启 · 锁屏接收效果请在本机确认。';b.textContent='通知已开启';}
  else if(Notification.permission==='denied'){el.textContent='通知权限已关闭，请在系统或浏览器设置中允许手机桥通知。';}
  else{el.textContent='允许通知后，新的问题、申请和回复完成都会提醒您。';b.textContent='开启通知';b.disabled=false;}
}
async function enablePush(){
  if(!state.authorized||!state.registration||!('Notification' in window))return;
  const permission=await Notification.requestPermission();if(permission!=='granted')return refreshSubscriptionState();
  const key=Uint8Array.from(atob(state.hello.vapidPublicKey.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-state.hello.vapidPublicKey.length%4)%4)),c=>c.charCodeAt(0));
  const sub=await state.registration.pushManager.getSubscription()||await state.registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});await sendSubscriptionToServer(sub);await refreshSubscriptionState();toast('通知已开启');
}
async function pair(){
  const code=$('pair-code').value.trim().toUpperCase();if(!code)return toast('请输入电脑显示的配对码');$('btn-pair').disabled=true;$('pair-error').textContent='正在配对…';
  try{const result=await api('/api/pair',{body:{code},token:null});state.token=result.token;localStorage.setItem(TOKEN_KEY,result.token);localStorage.removeItem('ab_forget_cookie');localStorage.removeItem(MESSAGE_KEY);state.authorized=true;$('pair-code').value='';$('pairing').open=false;$('pair-error').textContent='';await refresh();await refreshSubscriptionState();toast('配对成功，请选择电脑聊天');showPage('chat');}
  catch(e){$('pair-error').textContent=e.message;}finally{$('btn-pair').disabled=false;}
}
async function openNotification(data){
  if(data.threadId&&data.questionId){await refresh();showPage('pending');const item=pendingItems().find(i=>i.threadId===data.threadId&&i.id===data.questionId&&(!data.turnId||i.turnId===data.turnId));if(item)openItem(item);else toast('问题已处理或失效，请核对来源聊天。');}
  else if(data.eventId){showPage('pending');await openEvent(data.eventId);}
}
function resizeComposer(){const input=$('command');input.style.height='auto';input.style.height=Math.min(150,input.scrollHeight)+'px';}
function viewport(){const v=window.visualViewport;if(!v)return;const editing=['INPUT','TEXTAREA'].includes(document.activeElement?.tagName),keyboard=editing&&v.scale===1&&window.innerHeight-v.height>120;
  document.body.classList.toggle('keyboard-open',keyboard);if(v.scale===1){document.documentElement.style.setProperty('--viewport-height',v.height+'px');document.documentElement.style.setProperty('--viewport-top',v.offsetTop+'px');}}
async function boot(){
  $('computer-address').value=location.origin;$('command').value=localStorage.getItem(DRAFT_KEY)||'';resizeComposer();state.token=localStorage.getItem(TOKEN_KEY);showPage(location.hash.slice(1),false);history.replaceState({page:state.page},'',location.pathname+location.search+'#'+state.page);
  try{state.hello=await api('/api/hello',{token:null});await registerServiceWorker();
    if(state.hello.paired&&(state.token||!localStorage.getItem('ab_forget_cookie'))){try{await api('/api/events?limit=1');state.authorized=true;}catch{}}
    if(!state.authorized){state.codex={};state.events=[];renderChat();renderPending();showPage('settings');$('pairing').open=true;setConn(true,'请在电脑配对窗生成配对码');}
    else {await refresh();await refreshSubscriptionState();if(state.subscription)await sendSubscriptionToServer(state.subscription).catch(()=>{});}
    const params=new URLSearchParams(location.search);if(state.authorized&&(params.has('event')||params.has('question'))){await openNotification({eventId:params.get('event'),threadId:params.get('thread'),questionId:params.get('question'),turnId:params.get('turn')});history.replaceState(history.state,'',location.pathname+location.hash);}
  }catch{setConn(false,'电脑服务未响应，请检查 Tailscale 与电脑服务');$('chat-status').textContent='服务未响应，请到设置检查连接。';showPage('settings');}
  await refreshSubscriptionState();
}
for(const b of document.querySelectorAll('[data-page]'))b.onclick=()=>showPage(b.dataset.page);
$('choose-thread').onclick=()=>void chooseThread();$('composer').onsubmit=sendCommand;$('copy-reply').onclick=()=>void copy(state.replySource);$('pending-banner').onclick=()=>showPage('pending');$('open-history').onclick=openHistory;
$('close-detail').onclick=closeDetail;$('detail-dialog').addEventListener('cancel',e=>{e.preventDefault();closeDetail();});$('detail-dialog').addEventListener('close',()=>{state.detail=null;viewport();});
window.addEventListener('popstate',e=>{if($('detail-dialog').open)$('detail-dialog').close();showPage(e.state?.page||location.hash.slice(1),false);});
$('command').addEventListener('input',()=>{resizeComposer();try{localStorage.setItem(DRAFT_KEY,$('command').value);}catch{feedback('无法保存草稿，请检查浏览器存储。');}});
$('btn-pair').onclick=()=>void pair();$('pair-code').onkeydown=e=>{if(e.key==='Enter')void pair();};
$('btn-enable-push').onclick=()=>void enablePush().catch(e=>toast('开启通知失败：'+e.message));
$('btn-resub').onclick=async()=>{try{if(!state.subscription)return toast('请先开启通知');await sendSubscriptionToServer(state.subscription);toast('通知订阅已重新登记');}catch(e){toast(e.message);}};
$('btn-probe').onclick=async()=>{try{const r=await api('/api/admin/probe',{body:{}});toast(`探测已发送：成功 ${r.result?.ok||0} / 失败 ${r.result?.failed||0}`);}catch(e){toast(e.message);}};
$('btn-test-event').onclick=async()=>{try{const r=await api('/api/admin/test-event',{body:{kind:'decision'}});await refresh();showPage('pending');await openEvent(r.eventId);}catch(e){toast(e.message);}};
$('btn-refresh').onclick=async()=>{if(!state.authorized)await boot();else await refresh();toast('已刷新连接');};
$('btn-unpair').onclick=async()=>{localStorage.removeItem(TOKEN_KEY);localStorage.setItem('ab_forget_cookie','1');state.token=null;state.authorized=false;state.codex={};state.events=[];renderChat();renderPending();$('pairing').open=true;setConn(true,'网页凭证已清除，请重新配对');try{await state.subscription?.unsubscribe();state.subscription=null;}catch{}await refreshSubscriptionState();toast('本浏览器凭证已清除');};
navigator.serviceWorker?.addEventListener('message',event=>{const data=event.data||{};if(data.type==='open-event'||data.type==='open-codex')void openNotification(data);if(data.type==='resubscribe')void refreshSubscriptionState();if(data.type==='probe')toast('收到后台探测推送');});
document.querySelector('details:has(#s-pushes)').addEventListener('toggle',async event=>{if(!event.target.open||!state.authorized)return;try{const {log}=await api('/api/pushes');$('s-pushes').textContent=(log||[]).slice(0,8).map(p=>`${fmtTime(p.at)} · 成功 ${p.ok||0} / 失败 ${p.failed||0}`).join('\n')||'还没有推送记录';}catch{$('s-pushes').textContent='读取失败，请检查连接。';}});
document.addEventListener('visibilitychange',()=>{document.body.classList.toggle('background',document.visibilityState!=='visible');connection.begin('');pendingConfirmedAt=-1;renderConnection();if(document.visibilityState==='visible')void refresh();});setInterval(renderConnection,1000);setInterval(()=>{if(document.visibilityState==='visible')void refresh();},4000);
window.visualViewport?.addEventListener('resize',viewport);window.visualViewport?.addEventListener('scroll',viewport);document.addEventListener('focusin',viewport);document.addEventListener('focusout',()=>setTimeout(viewport,100));viewport();
void boot();
