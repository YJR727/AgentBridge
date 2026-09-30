export class ChatStatus {
  thread='';generation=0;confirmedAt=-1;connected=false;
  begin(id){this.thread=id;this.connected=false;this.confirmedAt=-1;return ++this.generation;}
  confirm(id,generation,now,connected){
    if(generation!==this.generation||(this.thread&&this.thread!==id))return;
    this.thread=id;this.connected=!!connected&&!!id;this.confirmedAt=this.connected?now:-1;
  }
  isConnected(now){return this.connected&&now>=this.confirmedAt&&now-this.confirmedAt<10000;}
}
export function formatReplyTime(reply,now=Date.now(),timeZone){
  const duration=reply?.durationMs,completed=reply?.completedAtMs;
  if(!Number.isSafeInteger(duration)||duration<0||!Number.isSafeInteger(completed)||completed<0||completed>8640000000000000)return '时间不可用';
  const seconds=Math.floor(duration/1000),elapsed=seconds>=3600?`${Math.floor(seconds/3600)} 小时 ${Math.floor(seconds%3600/60)} 分`:seconds>=60?`${Math.floor(seconds/60)} 分 ${seconds%60} 秒`:`${seconds} 秒`;
  const zone=timeZone?{timeZone}:{},date=new Intl.DateTimeFormat('en-CA',{...zone,year:'numeric',month:'2-digit',day:'2-digit'}),clock=new Intl.DateTimeFormat('zh-CN',{...zone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const day=date.format(completed);return `耗时 ${elapsed} · ${day===date.format(now)?'今日':day} ${clock.format(completed)} 完成`;
}
