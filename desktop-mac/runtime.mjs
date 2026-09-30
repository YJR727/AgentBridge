import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
export const NODE_VERSION='v24.19.0';
export const NODE_ARCHIVES={
 arm64:{sha256:'8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d'},
 x64:{sha256:'d1b5e999db158c62fe8f7267a4476b035d8bd93b1a605bac24a3f0dd166e3316'}
};
export const sha256=data=>createHash('sha256').update(data).digest('hex');
export function verifyArchive(file,arch){
 if(!NODE_ARCHIVES[arch])throw new Error('Unsupported architecture');
 if(sha256(fs.readFileSync(file))!==NODE_ARCHIVES[arch].sha256)throw new Error('Official Node archive checksum mismatch');
}
export function validateMachO(file,arch){
 if(!fs.existsSync(file))throw new Error('Missing Node runtime: '+file);
 const fd=fs.openSync(file,'r'),header=Buffer.alloc(8);try{fs.readSync(fd,header,0,8,0);}finally{fs.closeSync(fd);}
 if(header.readUInt32LE()!==0xfeedfacf)throw new Error('Runtime is not a 64-bit Mach-O executable');
 if(header.readUInt32LE(4)!==({arm64:0x0100000c,x64:0x01000007}[arch]))throw new Error('Runtime architecture mismatch');
}
export async function officialRuntime(cache,arch){
 const spec=NODE_ARCHIVES[arch];if(!spec)throw new Error('Unsupported architecture');
 fs.mkdirSync(cache,{recursive:true});const name=`node-${NODE_VERSION}-darwin-${arch}`,archive=path.join(cache,name+'.tar.gz');
 if(!fs.existsSync(archive)){
  const response=await fetch(`https://nodejs.org/dist/${NODE_VERSION}/${name}.tar.gz`,{signal:AbortSignal.timeout(120000)});
  if(!response.ok)throw new Error(`Official fixed Node runtime unavailable: HTTP ${response.status}`);
  const data=Buffer.from(await response.arrayBuffer());
  if(sha256(data)!==spec.sha256)throw new Error('Official Node download checksum mismatch');
  fs.writeFileSync(archive,data);
 }
 verifyArchive(archive,arch);
 // Always extract after verifying, so an altered cache binary cannot become the trusted reference.
 execFileSync('/usr/bin/tar',['-xzf',archive,'-C',cache],{stdio:'inherit'});
 const directory=path.join(cache,name),node=path.join(directory,'bin/node'),license=path.join(directory,'LICENSE');
 validateMachO(node,arch);
 if(!fs.existsSync(license)||fs.statSync(license).size<1000)throw new Error('Official Node LICENSE missing');
 return {directory,node,license};
}
