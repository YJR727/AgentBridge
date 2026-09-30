import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {deflateRawSync} from 'node:zlib';
import {verifyArchive,NODE_VERSION} from '../desktop-mac/runtime.mjs';

export const serviceFiles=['server.mjs','hook.mjs','hooks.template.json','desktop/worker.mjs',
 'lib/config.mjs','lib/crypto.mjs','lib/push.mjs','lib/server.mjs','lib/store.mjs','lib/desktop.mjs','lib/desktop-endpoints.mjs','lib/desktop-sessions.mjs',
 'public/index.html','public/app.js','public/app.css','public/sw.js','public/markdown.js','public/chat-status.js','public/manifest.webmanifest','public/icon.svg','public/icon-192.png','public/icon-512.png','public/favicon.png','public/apple-touch-icon.png',
 'tools/install.mjs','desktop-mac/service.mjs','desktop-mac/setup-hooks.mjs'];
export const sourceFiles=[...serviceFiles,'desktop-mac/BridgeController.swift','desktop-mac/AgentBridgeApp.swift','desktop-mac/BridgeChecks.swift',
 'desktop-mac/build.mjs','desktop-mac/runtime.mjs','desktop-mac/verify.mjs','desktop-mac/Build.command','desktop-mac/Verify.command','desktop-mac/README.md',
 'desktop-mac/dmg-background.png','desktop-mac/dmg-layout.applescript',
 'tools/package-macos-source.mjs','tools/run-tests.mjs',
 'tests/desktop-endpoints.test.mjs','tests/desktop.test.mjs','tests/install.test.mjs','tests/macos-package.test.mjs','tests/macos-runtime.test.mjs','tests/server.test.mjs','tests/multi-device-http.test.mjs','tests/desktop-sessions.test.mjs'];
const sha=data=>createHash('sha256').update(data).digest('hex');
function crc(data){let n=0xffffffff;for(const byte of data){n^=byte;for(let bit=0;bit<8;bit++)n=(n>>>1)^((n&1)?0xedb88320:0);}return(n^0xffffffff)>>>0;}
// A small standard ZIP writer for local source delivery; no package dependency.
export function zipEntries(entries) {
 const local=[],central=[];let offset=0;
 for(const {name,data,mode=0o100644}of entries){
  const label=Buffer.from(name),compressed=deflateRawSync(data),checksum=crc(data);
  const head=Buffer.alloc(30);head.writeUInt32LE(0x04034b50);head.writeUInt16LE(20,4);head.writeUInt16LE(0x800,6);head.writeUInt16LE(8,8);head.writeUInt16LE(0x21,12);
  head.writeUInt32LE(checksum,14);head.writeUInt32LE(compressed.length,18);head.writeUInt32LE(data.length,22);head.writeUInt16LE(label.length,26);
  local.push(head,label,compressed);
  const record=Buffer.alloc(46);record.writeUInt32LE(0x02014b50);record.writeUInt16LE(0x314,4);head.copy(record,6,4,30);
  record.writeUInt32LE((mode<<16)>>>0,38);record.writeUInt32LE(offset,42);central.push(record,label);
  offset+=head.length+label.length+compressed.length;
 }
 const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...local,directory,end]);
}
export function packageSource({root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),output=path.join(root,'dist','AgentBridge-macOS-0.1.0-Source.zip'),offlineArm64Archive}={}) {
 const entries=sourceFiles.map(name=>{
  const file=path.join(root,name);if(!fs.existsSync(file))throw new Error('Missing source resource: '+name);
  const resolved=fs.realpathSync(file),relative=path.relative(fs.realpathSync(root),resolved);
  if(relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||fs.lstatSync(file).isSymbolicLink()||!fs.statSync(file).isFile())throw new Error('Unsafe source resource: '+name);
  let data=fs.readFileSync(file);if(name.endsWith('.command'))data=Buffer.from(data.toString().replaceAll('\r\n','\n'));
  return {name,data,mode:name.endsWith('.command')?0o100755:0o100644};
 });
 const manifest=Object.fromEntries(entries.map(e=>[e.name,sha(e.data)]));entries.push({name:'SOURCE-SHA256.json',data:Buffer.from(JSON.stringify(manifest,null,2)+'\n')});
 // Build the entire offline ZIP with Unix metadata; updating it with Windows ZipFile loses the creator OS.
 if(offlineArm64Archive){
  verifyArchive(offlineArm64Archive,'arm64');
  entries.push({name:`desktop-mac/.build/cache/node-${NODE_VERSION}-darwin-arm64.tar.gz`,data:fs.readFileSync(offlineArm64Archive),mode:0o100644});
 }
 fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,zipEntries(entries));
 return {output,files:entries.length,sha256:sha(fs.readFileSync(output))};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 console.log(JSON.stringify(packageSource(process.argv.includes('--offline-arm64')?{root,output:path.join(root,'dist','AgentBridge-macOS-0.1.0-Offline-Source.zip'),offlineArm64Archive:path.join(root,'dist',`node-${NODE_VERSION}-darwin-arm64.tar.gz`)}:{}),null,2));
}
