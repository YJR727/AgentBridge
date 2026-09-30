import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {inflateRawSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {packageSource,sourceFiles} from '../tools/package-macos-source.mjs';

function unzip(buffer) {
  const entries=new Map();let pos=0;
  while(buffer.readUInt32LE(pos)===0x04034b50){
    const size=buffer.readUInt32LE(pos+18),n=buffer.readUInt16LE(pos+26),x=buffer.readUInt16LE(pos+28);
    const name=buffer.subarray(pos+30,pos+30+n).toString();const offset=pos+30+n+x;
    entries.set(name,inflateRawSync(buffer.subarray(offset,offset+size)));pos=offset+size;
  }
  const modes=new Map(),hosts=new Map();
  while(buffer.readUInt32LE(pos)===0x02014b50){const n=buffer.readUInt16LE(pos+28),x=buffer.readUInt16LE(pos+30),c=buffer.readUInt16LE(pos+32),name=buffer.subarray(pos+46,pos+46+n).toString();modes.set(name,buffer.readUInt32LE(pos+38)>>>16);hosts.set(name,buffer[pos+5]);pos+=46+n+x+c;}
  return {entries,modes,hosts};
}
test('source archive preserves resources, space paths, LF and executable commands, excludes credentials',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mac source space '));
 try{
  for(const file of sourceFiles){fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),file.endsWith('.command')?'#!/bin/bash\r\necho check\r\n':`fixture ${file}`);}
  fs.mkdirSync(path.join(root,'data'));fs.writeFileSync(path.join(root,'data/config.json'),'SECRET');
  fs.writeFileSync(path.join(root,'certificate.p12'),'PRIVATE');
  const output=path.join(root,'dist','source.zip');packageSource({root,output});
  const {entries,modes,hosts}=unzip(fs.readFileSync(output));
  assert.deepEqual([...entries.keys()].sort(),[...sourceFiles,'SOURCE-SHA256.json'].sort());
  assert.ok(entries.has('lib/desktop-endpoints.mjs'));assert.ok(entries.has('public/app.js'));
  assert.equal(entries.get('desktop-mac/Build.command').toString(),'#!/bin/bash\necho check\n');
  assert.equal(modes.get('desktop-mac/Build.command')&0o777,0o755);
  // macOS/libarchive ignores Unix execute bits when the ZIP identifies its creator as DOS.
  for(const name of ['desktop-mac/Build.command','desktop-mac/Verify.command'])assert.equal(hosts.get(name),3);
  assert.equal(modes.get('lib/config.mjs')&0o777,0o644);
  const manifest=JSON.parse(entries.get('SOURCE-SHA256.json'));assert.equal(Object.keys(manifest).length,sourceFiles.length);
  const badArchive=path.join(root,'bad-runtime.tar.gz');fs.writeFileSync(badArchive,'invalid runtime');
  const offlineOutput=path.join(root,'dist','offline.zip');
  assert.throws(()=>packageSource({root,output:offlineOutput,offlineArm64Archive:badArchive}),/checksum/i);
  assert.equal(fs.existsSync(offlineOutput),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('missing or symlinked input fails before producing an archive',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mac-missing-'));
 try{assert.throws(()=>packageSource({root,output:path.join(root,'out.zip')}),/missing|缺少/i);assert.equal(fs.existsSync(path.join(root,'out.zip')),false);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('branded disk image background is packaged at its Finder window size',()=>{
 assert.ok(sourceFiles.includes('desktop-mac/dmg-background.png'));
 const image=fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),'../desktop-mac/dmg-background.png'));
 assert.equal(image.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
 assert.equal(image.readUInt32BE(16),760);
 assert.equal(image.readUInt32BE(20),480);
});

