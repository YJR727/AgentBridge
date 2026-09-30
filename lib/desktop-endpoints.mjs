import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const fail = message => Object.assign(new Error(message), {status:503});
function safeAncestors(endpoint,uid,fsImpl) {
  for(let directory=path.posix.dirname(endpoint);;directory=path.posix.dirname(directory)) {
    const stat=fsImpl.lstatSync(directory);
    // macOS /var and /tmp are root-owned system aliases; validate their canonical chain too.
    if(stat.isSymbolicLink()) { if(stat.uid!==0)return false; }
    else if(!stat.isDirectory() || ![0,uid].includes(stat.uid) || ((stat.mode&0o022)&&!(stat.mode&0o1000)))return false;
    if(directory==='/')return true;
  }
}
function ownedSocket(endpoint, uid, fsImpl) {
  if (!Number.isInteger(uid) || !path.posix.isAbsolute(endpoint) || endpoint.includes('\0') || Buffer.byteLength(endpoint)>=104) return false;
  try {
    const socket=fsImpl.lstatSync(endpoint), parent=fsImpl.lstatSync(path.posix.dirname(endpoint));
    const canonical=fsImpl.realpathSync(endpoint), realSocket=fsImpl.lstatSync(canonical), realParent=fsImpl.lstatSync(path.posix.dirname(canonical));
    return socket.isSocket() && !socket.isSymbolicLink() && socket.uid===uid &&
      parent.isDirectory() && !parent.isSymbolicLink() && parent.uid===uid && !(parent.mode & 0o022) &&
      realSocket.isSocket() && realSocket.uid===uid && realParent.isDirectory() && realParent.uid===uid && !(realParent.mode&0o022) &&
      safeAncestors(endpoint,uid,fsImpl) && safeAncestors(canonical,uid,fsImpl);
  } catch { return false; }
}
export function resolveDesktopEndpoint({platform=process.platform,env=process.env,codexHome=env.CODEX_HOME||path.join(os.homedir(),'.codex'),tmpdir=os.tmpdir(),uid=process.getuid?.(),fsImpl=fs,endpoint}={}) {
  const explicit=endpoint || env.AGENT_BRIDGE_CODEX_IPC;
  if (platform==='win32') return explicit || '\\\\.\\pipe\\codex-ipc';
  if (explicit) {
    if(Buffer.byteLength(explicit)>=104)throw fail('Codex 套接字路径过长，请使用宿主提供的较短临时端点');
    if (!ownedSocket(explicit,uid,fsImpl)) throw fail('指定 Codex 套接字不可用或不属于当前用户的安全目录');
    return explicit;
  }
  const candidates=[path.posix.join(codexHome,'ipc','ipc.sock'),path.posix.join(tmpdir,'codex-ipc',`ipc-${uid}.sock`),path.posix.join(tmpdir,'codex-ipc','ipc.sock')];
  const found=candidates.find(file=>ownedSocket(file,uid,fsImpl));
  if (!found) throw fail('未找到当前用户的 Codex 套接字，请先打开电脑 Codex 和已有聊天');
  return found;
}
export function discoverToolsEndpoints({platform=process.platform,env=process.env,uid=process.getuid?.(),fsImpl=fs,reportedPaths}={}) {
  const explicit=env.CODEX_APP_TOOLS_PIPE_PATH;
  if(platform==='win32') {
    let names=[];try{names=fsImpl.readdirSync('\\\\.\\pipe\\').filter(n=>n.startsWith('codex-browser-use-')).map(n=>'\\\\.\\pipe\\'+n);}catch{}
    return [...new Set([explicit,...names].filter(Boolean))];
  }
  if(explicit && !ownedSocket(explicit,uid,fsImpl)) throw fail('指定聊天列表套接字不可用或不属于当前用户的安全目录');
  if(reportedPaths===undefined) {
    // Inspect only OS-reported Unix sockets; no recursive filesystem scan.
    try {
      const output=execFileSync('/usr/sbin/lsof',['-n','-P','-a','-U','-u',String(uid),'-Fn'],{encoding:'utf8',timeout:1500,maxBuffer:1024*1024,stdio:['ignore','pipe','ignore']});
      reportedPaths=output.split('\n').filter(line=>line.startsWith('n/')).map(line=>line.slice(1));
    } catch { reportedPaths=[]; }
  }
  return [...new Set([explicit,...reportedPaths.filter(file=>path.posix.basename(file).startsWith('codex-browser-use-'))].filter(Boolean))].filter(file=>ownedSocket(file,uid,fsImpl));
}
