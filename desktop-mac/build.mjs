import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {serviceFiles} from '../tools/package-macos-source.mjs';
import {officialRuntime,validateMachO,sha256,NODE_VERSION} from './runtime.mjs';
import {verify} from './verify.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const run=(program,args)=>execFileSync(program,args,{stdio:'inherit'});
function option(name,fallback){const index=process.argv.indexOf(name);if(index===-1)return fallback;if(!process.argv[index+1]||process.argv[index+1].startsWith('--'))throw new Error('Missing value for '+name);return process.argv[index+1];}
export async function build({workspaceRoot=root}={}){
 const root=workspaceRoot;
 const keptApp=path.join(root,'dist','Agent Bridge.app');
 if(fs.existsSync(keptApp))throw new Error('dist/Agent Bridge.app already exists; move it aside before rebuilding. Existing artifacts were not replaced.');
 if(process.platform!=='darwin')throw new Error('请在 Mac 上运行 Build.command；Windows 不能构建 SwiftUI 或 DMG');
 const arch=option('--arch',process.arch),identity=option('--identity','-');
 if(!['arm64','x64'].includes(arch))throw new Error('--arch must be arm64 or x64');
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'SOURCE-SHA256.json'),'utf8'));
 for(const [name,hash]of Object.entries(manifest)){if(sha256(fs.readFileSync(path.join(root,name)))!==hash)throw new Error('Source resource changed or corrupted: '+name);}
 try{execFileSync('/usr/bin/xcrun',['--find','swiftc'],{stdio:'pipe'});}catch{throw new Error('先在终端运行 xcode-select --install，完成苹果命令行工具安装后重新双击 Build.command');}
 const buildBase=path.join(root,'desktop-mac','.build');fs.mkdirSync(buildBase,{recursive:true});
 const runtime=await officialRuntime(path.join(buildBase,'cache'),arch);
 const node=path.resolve(option('--node',runtime.node));validateMachO(node,arch);
 if(sha256(fs.readFileSync(node))!==sha256(fs.readFileSync(runtime.node)))throw new Error('--node must match the pinned official Node runtime');
 const work=fs.mkdtempSync(path.join(buildBase,'build-'));
 try{
  const swiftArch=arch==='x64'?'x86_64':'arm64',target=`${swiftArch}-apple-macos13.0`,sdk=execFileSync('/usr/bin/xcrun',['--sdk','macosx','--show-sdk-path'],{encoding:'utf8'}).trim();
  const checks=path.join(work,'BridgeChecks');
  run('/usr/bin/xcrun',['swiftc','-swift-version','5','-parse-as-library','-sdk',sdk,'-target',target,path.join(root,'desktop-mac/BridgeController.swift'),path.join(root,'desktop-mac/BridgeChecks.swift'),'-o',checks]);
  const app=path.join(work,'Agent Bridge.app'),contents=path.join(app,'Contents'),macOS=path.join(contents,'MacOS'),resources=path.join(contents,'Resources');
  fs.mkdirSync(macOS,{recursive:true});fs.mkdirSync(resources,{recursive:true});
  run('/usr/bin/xcrun',['swiftc','-swift-version','5','-parse-as-library','-O','-sdk',sdk,'-target',target,path.join(root,'desktop-mac/BridgeController.swift'),path.join(root,'desktop-mac/AgentBridgeApp.swift'),'-o',path.join(macOS,'AgentBridge')]);
  for(const name of serviceFiles){const dest=path.join(resources,'app',name);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(root,name),dest);}
  fs.mkdirSync(path.join(resources,'runtime/bin'),{recursive:true});fs.copyFileSync(node,path.join(resources,'runtime/bin/node'));fs.chmodSync(path.join(resources,'runtime/bin/node'),0o755);
  fs.copyFileSync(runtime.license,path.join(resources,'Node-LICENSE.txt'));
  run(checks,[resources]);
  fs.copyFileSync(path.join(root,'desktop-mac/README.md'),path.join(resources,'README.md'));
  const icons=path.join(work,'AgentBridge.iconset');fs.mkdirSync(icons);
  for(const size of [16,32,128,256,512])for(const scale of [1,2]){
   const pixels=Math.min(size*scale,1024),suffix=scale===2?'@2x':'';
   run('/usr/bin/sips',['-z',String(pixels),String(pixels),path.join(root,'public/icon-512.png'),'--out',path.join(icons,`icon_${size}x${size}${suffix}.png`)]);
  }
  run('/usr/bin/iconutil',['-c','icns',icons,'-o',path.join(resources,'AgentBridge.icns')]);
  fs.writeFileSync(path.join(contents,'Info.plist'),`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>CFBundleName</key><string>Agent Bridge</string><key>CFBundleDisplayName</key><string>Agent Bridge</string>
<key>CFBundleIdentifier</key><string>com.agentbridge.desktop</string><key>CFBundleExecutable</key><string>AgentBridge</string>
<key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>0.1.0</string><key>CFBundleVersion</key><string>1</string>
<key>CFBundleIconFile</key><string>AgentBridge</string><key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/><key>NSPrincipalClass</key><string>NSApplication</string></dict></plist>`);
  const entitlements=path.join(work,'node-entitlements.plist');fs.writeFileSync(entitlements,'<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/></dict></plist>');
  const sign=identity==='-'?[]:['--timestamp','--options','runtime'];
  // Finder may attach resource-fork metadata to extracted inputs; codesign rejects it in the staged app.
  run('/usr/bin/xattr',['-cr',app]);
  run('/usr/bin/codesign',['--force','--sign',identity,...sign,'--entitlements',entitlements,path.join(resources,'runtime/bin/node')]);
  run('/usr/bin/codesign',['--force','--sign',identity,...sign,app]);
  run('/usr/bin/codesign',['--verify','--deep','--strict',app]);
  run('/usr/bin/lipo',[path.join(macOS,'AgentBridge'),'-verify_arch',swiftArch]);
  run('/usr/bin/lipo',[path.join(resources,'runtime/bin/node'),'-verify_arch',swiftArch]);
  run(path.join(resources,'runtime/bin/node'),['--version']);
  const hashes={};for(const name of serviceFiles)hashes[name]=sha256(fs.readFileSync(path.join(resources,'app',name)));
  // Store outside signed application, and verify exact packaged backend in isolation.
  const dist=path.join(root,'dist');fs.mkdirSync(dist,{recursive:true});
  const verification=await verify({isolated:true,resourceRoot:path.join(resources,'app')});
  if(!verification.ok)throw new Error('Isolated backend verification failed');
  run(path.join(resources,'runtime/bin/node'),[path.join(root,'tools/run-tests.mjs')]);
  const base=`AgentBridge-macOS-0.1.0-${arch}`,dmg=path.join(dist,base+'.dmg'),zip=path.join(dist,base+'.app.zip');
  run('/usr/bin/ditto',['-c','-k','--sequesterRsrc','--keepParent',app,zip]);
  const stage=path.join(work,'volume');fs.mkdirSync(stage);fs.cpSync(app,path.join(stage,'Agent Bridge.app'),{recursive:true});fs.symlinkSync('/Applications',path.join(stage,'Applications'));
  fs.mkdirSync(path.join(stage,'.background'));fs.copyFileSync(path.join(root,'desktop-mac/dmg-background.png'),path.join(stage,'.background/install.png'));
  const writable=path.join(work,'installer-rw.dmg'),mount=path.join(work,'mounted');
  run('/usr/bin/hdiutil',['create','-ov','-format','UDRW','-volname','Agent Bridge','-srcfolder',stage,writable]);
  fs.mkdirSync(mount);
  run('/usr/bin/hdiutil',['attach','-readwrite','-noverify','-nobrowse','-mountpoint',mount,writable]);
  try{
   run('/usr/bin/osascript',[path.join(root,'desktop-mac/dmg-layout.applescript'),mount]);
   if(!fs.existsSync(path.join(mount,'.DS_Store')))throw new Error('Finder did not save the installer layout');
  }finally{run('/usr/bin/hdiutil',['detach',mount]);}
  run('/usr/bin/hdiutil',['convert',writable,'-format','UDZO','-o',dmg]);run('/usr/bin/hdiutil',['verify',dmg]);
  const report={builtAt:new Date().toISOString(),platform:os.release(),arch,node:NODE_VERSION,signing:identity==='-'?'ad-hoc local test (not notarized)':'Developer ID identity provided (not notarized)',nativeChecks:true,isolated:verification,resources:hashes,artifacts:{[path.basename(dmg)]:sha256(fs.readFileSync(dmg)),[path.basename(zip)]:sha256(fs.readFileSync(zip))},desktopIntegration:'pending actual Mac/phone acceptance'};
  fs.writeFileSync(path.join(dist,base+'-build-report.json'),JSON.stringify(report,null,2)+'\n');
  fs.cpSync(app,keptApp,{recursive:true});
  console.log('构建与隔离检查通过；安装包：'+dmg+'\n真实 Codex 和手机验收仍需执行。');
  run('/usr/bin/open',[dmg]);
 }finally{
  const resolved=fs.realpathSync(work),parent=fs.realpathSync(buildBase);
  if(path.dirname(resolved)===parent&&path.basename(resolved).startsWith('build-'))fs.rmSync(resolved,{recursive:true,force:true});
 }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))build().catch(error=>{console.error(error.message);process.exitCode=1;});
