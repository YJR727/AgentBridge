// Mac-only entry: private per-user files and a read-only application bundle.
import {loadConfig,saveConfig} from '../lib/config.mjs';
import fs from 'node:fs';
process.umask(0o077);
if(process.argv.includes('--prepare')) {
  const {config}=loadConfig();
  const index=process.argv.indexOf('--subject');
  if(index!==-1){
    const value=process.argv[index+1],url=new URL(value);
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!['','/'].includes(url.pathname))throw new Error('Invalid HTTPS contact address');
    config.vapid.subject=value;saveConfig(config);
  }
} else {
  const file=process.env.AGENT_BRIDGE_LOG;
  const timer=setInterval(()=>{
    try { if(fs.statSync(file).size>4*1024*1024){fs.rmSync(file+'.previous',{force:true});fs.renameSync(file,file+'.previous');} } catch {}
  },10000);timer.unref();
  await import('../desktop/worker.mjs');
}
