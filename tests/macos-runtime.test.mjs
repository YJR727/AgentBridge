import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {validateMachO,verifyArchive,NODE_ARCHIVES} from '../desktop-mac/runtime.mjs';
import {build} from '../desktop-mac/build.mjs';
test('runtime rejects missing files, wrong architecture and non-Mach-O input',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'runtime space '));
 try{
  const file=path.join(dir,'node');assert.throws(()=>validateMachO(file,'arm64'),/runtime|运行时/);
  fs.writeFileSync(file,'not a Mach-O');assert.throws(()=>validateMachO(file,'arm64'),/Mach-O/);
  const binary=Buffer.alloc(32);binary.writeUInt32LE(0xfeedfacf);binary.writeUInt32LE(0x0100000c,4);fs.writeFileSync(file,binary);
  assert.doesNotThrow(()=>validateMachO(file,'arm64'));assert.throws(()=>validateMachO(file,'x64'),/architecture|架构/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('corrupt archives cannot pass pinned official checksums',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-archive-'));
 try{const file=path.join(dir,'runtime.tar.gz');fs.writeFileSync(file,'corrupt');assert.throws(()=>verifyArchive(file,'arm64'),/checksum|校验/);assert.equal(NODE_ARCHIVES.arm64.sha256.length,64);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('existing app blocks rebuild before modifying artifacts or requiring Mac tools',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mac-build-output-'));
 try{
  const dist=path.join(directory,'dist');fs.mkdirSync(path.join(dist,'Agent Bridge.app'),{recursive:true});
  const report=path.join(dist,'build-report.json');fs.writeFileSync(report,'OLD REPORT');
  await assert.rejects(build({workspaceRoot:directory}),/already exists/);
  assert.equal(fs.readFileSync(report,'utf8'),'OLD REPORT');assert.deepEqual(fs.readdirSync(dist).sort(),['Agent Bridge.app','build-report.json']);
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
