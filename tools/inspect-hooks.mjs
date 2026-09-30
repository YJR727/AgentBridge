// 只读查询本机 Codex 的 hook 加载/信任状态，不启动任务，不写信任。
import {spawn} from 'node:child_process';
import readline from 'node:readline';
const executable=process.argv[2];
if(!executable) throw new Error('参数需要当前 codex.exe 绝对路径');
const child=spawn(executable,['app-server','--stdio'],{cwd:process.cwd(),windowsHide:true,stdio:['pipe','pipe','ignore']});
const lines=readline.createInterface({input:child.stdout});
let initialized=false;
const timer=setTimeout(()=>{console.error('hook 状态查询超时');process.exitCode=1;child.kill();lines.close();},10000);
lines.on('line',line=>{
  let message; try{message=JSON.parse(line);}catch{return;}
  if(message.id===1){
    if(message.error){console.error('初始化失败');process.exitCode=1;child.kill();return;}
    initialized=true;
    child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
    child.stdin.write(JSON.stringify({id:2,method:'hooks/list',params:{cwds:[process.cwd()]}})+'\n');
  }else if(message.id===2){
    console.log(JSON.stringify(message.error ?? message.result,null,2));
    if(message.error)process.exitCode=1;
    clearTimeout(timer);lines.close();child.kill();
  }
});
child.on('error',()=>{clearTimeout(timer);lines.close();console.error('无法启动本机 Codex 只读检查');process.exitCode=1;});
child.on('exit',()=>{clearTimeout(timer);lines.close();if(!initialized)process.exitCode=1;});
child.stdin.write(JSON.stringify({id:1,method:'initialize',params:{clientInfo:{name:'agent_bridge_readonly_check',version:'0.2.0'},capabilities:{experimentalApi:true}}})+'\n');
