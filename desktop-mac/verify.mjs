import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

async function isolatedCheck(resourceRoot){
 const load=name=>import(pathToFileURL(path.join(resourceRoot,name)));
 const [{loadConfig},{Store},{BridgeServer},{DesktopSessions},{resolveDesktopEndpoint}]=await Promise.all(['lib/config.mjs','lib/store.mjs','lib/server.mjs','lib/desktop-sessions.mjs','lib/desktop-endpoints.mjs'].map(load));
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'Agent Bridge isolated ')),oldData=process.env.AGENT_BRIDGE_DATA;
 process.env.AGENT_BRIDGE_DATA=directory;fs.chmodSync(directory,0o700);
 let bridge,sessions,socketServer;
 try{
  const {config}=loadConfig();config.port=0;
  const originalPublicKey=config.vapid.publicKey;
  sessions=new DesktopSessions({dataDirectory:directory});sessions.start=()=>{};
  sessions.createBridge=()=>({waiters:new Set(),async selectThread(id){this.selectedThread={id,title:id};},getState(){return {connected:!!this.selectedThread,selectedThread:this.selectedThread,questions:[],approvals:[],status:'complete'};},stop(){this.selectedThread=null;}});
  bridge=new BridgeServer({store:new Store(directory),config,desktop:sessions,logger:{log(){},warn(){},error(){}}});
  const address=await bridge.start(),base=`http://127.0.0.1:${address.port}`;
  const request=async(route,{token,body,device}={})=>{
   const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...(device?{'X-Agent-Bridge-Device':device}:{})},body:body===undefined?undefined:JSON.stringify(body)});
   return {status:response.status,body:await response.json()};
  };
  const pairing=(await request('/api/local/pairing',{token:config.hookToken})).body;
  const first=await request('/api/pair',{body:{code:pairing.code}});assert.equal(first.status,200);
  const token=first.body.token;assert.ok(token);
  const extra=(await request('/api/local/pairing/add-device',{token:config.hookToken,body:{}})).body;
  const second=await request('/api/pair',{body:{code:extra.code}});assert.equal(second.status,200);
  const phone='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',ipad='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  assert.equal((await request('/api/codex/select',{token,device:phone,body:{threadId:'A'}})).status,200);
  assert.equal((await request('/api/codex/select',{token,device:ipad,body:{threadId:'B'}})).status,200);
  assert.equal((await request('/api/codex/state',{token,device:phone})).body.selectedThread.id,'A');
  assert.equal((await request('/api/codex/state',{token,device:ipad})).body.selectedThread.id,'B');
  const before=loadConfig().config;assert.equal(before.vapid.publicKey,originalPublicKey);assert.equal(before.appToken,token);
  const event=await request('/api/admin/test-event',{token,body:{kind:'decision',title:'隔离测试',summary:'不执行命令'}});assert.equal(event.status,200);
  const occupied=new BridgeServer({store:new Store(directory),config:{...config,port:address.port},logger:{log(){},warn(){},error(){}}});
  await assert.rejects(occupied.start(),/EADDRINUSE|占用/);assert.equal((await request('/api/health')).body.ok,true);
  assert.equal((await request('/api/local/pairing/reset',{token:config.hookToken,body:{}})).status,200);
  assert.equal((await request('/api/codex/state',{token,device:phone})).status,401);
  assert.equal(loadConfig().config.vapid.publicKey,originalPublicKey);
  if(process.platform==='darwin'){
   const endpoint=path.join(directory,'test.sock');socketServer=net.createServer(socket=>socket.end());
   await new Promise((resolve,reject)=>{socketServer.once('error',reject);socketServer.listen(endpoint,resolve);});
   assert.equal(resolveDesktopEndpoint({endpoint}),endpoint);
  }
  return {ok:true,pairingPreservedOnReload:true,secondDevicePreservesFirst:true,independentDeviceChats:true,resetRevokesOldToken:true,conflictPreservesExternalService:true,realUnixSocket:process.platform==='darwin',fakeEventsOnly:true};
 }finally{
  if(socketServer)await new Promise(r=>socketServer.close(r));
  await bridge?.stop();sessions?.stop();
  if(oldData===undefined)delete process.env.AGENT_BRIDGE_DATA;else process.env.AGENT_BRIDGE_DATA=oldData;
  fs.rmSync(directory,{recursive:true,force:true});
 }
}
async function desktopCheck(){
 if(process.platform!=='darwin')return {ok:false,error:'Requires macOS; Windows is not Mac acceptance'};
 const {DesktopBridge}=await import('../lib/desktop.mjs');
 const bridge=new DesktopBridge({logger:{log(){},warn(){},error(){}}});
 const result={ok:false,architecture:process.arch,system:os.release(),readOnly:true};
 try{
  try{result.codexVersion=execFileSync('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString','/Applications/Codex.app/Contents/Info.plist'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{result.codexVersion='未在 /Applications/Codex.app 找到；仅版本检查，不影响连接';}
  await bridge.start();result.ipcInitialized=true;
  const threads=await bridge.listThreads();result.catalogCount=threads.length;result.catalogSource=bridge.catalogSource;
  // Subscription is read-only; never send or answer a real request from this script.
  const candidate=threads.find(t=>t.status!=='archived');
  if(candidate){await bridge.selectThread(candidate.id);const state=bridge.getState();result.snapshotConnected=state.connected;result.finalReplyPresent=!!state.lastReply;result.timingPresent=state.lastReply?.durationMs!=null&&state.lastReply?.completedAtMs!=null;}
  result.ok=result.ipcInitialized&&result.snapshotConnected===true;
 }catch(error){result.error=error.message;}
 finally{bridge.stop();}
 return result;
}
export async function verify({isolated=false,desktopReadonly=false,resourceRoot=root}={}){
 const report={at:new Date().toISOString(),platform:process.platform,arch:process.arch,ok:true};
 if(isolated)try{report.isolated=await isolatedCheck(resourceRoot);}catch(error){report.isolated={ok:false,error:error.message};report.ok=false;}
 if(desktopReadonly){report.desktop=await desktopCheck();if(!report.desktop.ok)report.ok=false;}
 report.manualAcceptance={nativeWindow:'pending',menuBarAndSingleInstance:'pending',androidMessageQuestionApproval:'pending',ipadIndependentChatAndPush:'pending'};
 return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=new Set(process.argv.slice(2));
 if(args.has('--setup-hooks')){await import('./setup-hooks.mjs');}
 else{
  const appRoot=path.join(root,'dist','Agent Bridge.app','Contents','Resources','app');
  const report=await verify({isolated:args.has('--isolated'),desktopReadonly:args.has('--desktop-readonly'),resourceRoot:fs.existsSync(appRoot)?appRoot:root});
  const dist=path.join(root,'dist');fs.mkdirSync(dist,{recursive:true});fs.writeFileSync(path.join(dist,'macOS-verify-report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));if(!report.ok)process.exitCode=1;
 }
}
