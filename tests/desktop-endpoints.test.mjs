import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {resolveDesktopEndpoint, discoverToolsEndpoints} from '../lib/desktop-endpoints.mjs';

// Windows cannot create Unix sockets: exercise real selection with controlled lstat metadata.
function fixture() {
  const files = new Map();
  const directory = name => {
    if(name!=='/'&&!files.has(path.posix.dirname(name)))directory(path.posix.dirname(name));
    const system=['/','/Users','/private','/private/tmp'].includes(name);
    files.set(name, {uid:system?0:501, mode:name==='/private/tmp'?0o41777:system?0o40755:0o40700, isDirectory:()=>true, isSocket:()=>false, isSymbolicLink:()=>false});
  };
  const socket = name => {directory(path.posix.dirname(name)); files.set(name, {uid:501, mode:0o140600, isDirectory:()=>false, isSocket:()=>true, isSymbolicLink:()=>false});};
  const fsImpl = {lstatSync(name) {if(!files.has(name))throw new Error('ENOENT');return files.get(name);},realpathSync:name=>name, readdirSync:()=>['codex-browser-use-123','other-pipe']};
  const options = {platform:'darwin',env:{},codexHome:'/Users/test/.codex',tmpdir:'/private/tmp',uid:501,fsImpl};
  return {files,socket,directory,options};
}
test('Windows retains the existing pipe and tools catalog',()=>{
 const f=fixture();
 assert.equal(resolveDesktopEndpoint({...f.options,platform:'win32'}),'\\\\.\\pipe\\codex-ipc');
 assert.deepEqual(discoverToolsEndpoints({...f.options,platform:'win32'}),['\\\\.\\pipe\\codex-browser-use-123']);
});
test('Mac prefers the current Codex home socket, then the owned legacy socket',()=>{
 const f=fixture(),current='/Users/test/.codex/ipc/ipc.sock',old='/private/tmp/codex-ipc/ipc-501.sock';
 f.socket(current);f.socket(old);
 assert.equal(resolveDesktopEndpoint(f.options),current);
 f.files.delete(current);assert.equal(resolveDesktopEndpoint(f.options),old);
 f.files.delete(old);assert.throws(()=>resolveDesktopEndpoint(f.options),/打开.*Codex|套接字/);
});
test('explicit socket wins only when it belongs to the current user',()=>{
 const f=fixture(),explicit='/private/tmp/bridge/ipc.sock';f.socket(explicit);
 assert.equal(resolveDesktopEndpoint({...f.options,env:{AGENT_BRIDGE_CODEX_IPC:explicit}}),explicit);
 f.files.get(explicit).uid=502;
 assert.throws(()=>resolveDesktopEndpoint({...f.options,env:{AGENT_BRIDGE_CODEX_IPC:explicit}}),/用户|安全|套接字/);
});
test('rejects symbolic sockets and writable or differently owned parent directories',()=>{
 for(const mutate of [f=>f.files.get('/private/tmp/bridge/ipc.sock').isSymbolicLink=()=>true,
  f=>f.files.get('/private/tmp/bridge').mode=0o40777,f=>f.files.get('/private/tmp/bridge').uid=502]) {
  const f=fixture();f.socket('/private/tmp/bridge/ipc.sock');mutate(f);
  assert.throws(()=>resolveDesktopEndpoint({...f.options,endpoint:'/private/tmp/bridge/ipc.sock'}),/用户|安全|套接字/);
 }
});
test('tools discovery uses reported real sockets and rejects stale or foreign candidates',()=>{
 const f=fixture(),safe='/private/tmp/bridge/codex-browser-use-123.sock',foreign='/private/tmp/other/codex-browser-use-456.sock';
 f.socket(safe);f.socket(foreign);f.files.get(foreign).uid=502;
 const options={...f.options,reportedPaths:[safe,foreign,safe,'/private/tmp/not-present.sock']};
 assert.deepEqual(discoverToolsEndpoints(options),[safe]);
 f.files.delete(safe);assert.deepEqual(discoverToolsEndpoints(options),[]);
});
test('explicit tools path cannot bypass socket ownership checks',()=>{
 const f=fixture(),safe='/private/tmp/bridge/custom.sock';f.socket(safe);
 assert.deepEqual(discoverToolsEndpoints({...f.options,env:{CODEX_APP_TOOLS_PIPE_PATH:safe}}),[safe]);
 f.files.get(safe).uid=502;
 assert.throws(()=>discoverToolsEndpoints({...f.options,env:{CODEX_APP_TOOLS_PIPE_PATH:safe}}),/用户|安全|套接字/);
});

test('rejects replaceable or symlinked ancestors even when socket and immediate parent are safe',()=>{
 for(const mutate of [f=>f.files.get('/Users/test').uid=502,
   f=>f.files.get('/Users/test').mode=0o40777,
   f=>f.files.get('/Users/test').isSymbolicLink=()=>true]) {
  const f=fixture(),endpoint='/Users/test/.codex/ipc/ipc.sock';f.socket(endpoint);mutate(f);
  assert.throws(()=>resolveDesktopEndpoint({...f.options,endpoint}),/用户|安全|套接字/);
 }
});
test('checks the canonical parent and rejects unsupported Unix path lengths',()=>{
 const f=fixture(),endpoint='/private/tmp/bridge/ipc.sock';f.socket(endpoint);
 f.directory('/Users/foreign');f.files.get('/Users/foreign').uid=502;
 f.options.fsImpl.realpathSync=()=>'/Users/foreign/ipc.sock';
 assert.throws(()=>resolveDesktopEndpoint({...f.options,endpoint}),/用户|安全|套接字/);
 const g=fixture(),long='/Users/test/'+ 'x'.repeat(110)+'/ipc.sock';g.socket(long);
 assert.throws(()=>resolveDesktopEndpoint({...g.options,endpoint:long}),/长度|套接字/);
});
