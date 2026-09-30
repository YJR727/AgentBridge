// 仅管理 Agent Bridge hooks；不写 config.toml，不替换 notify，不代用户信任。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(ROOT, 'hook.mjs').replaceAll('\\', '/');
const projectHome = path.join(ROOT, '.codex');
function ours(handler) {
  return [handler.command, handler.commandWindows].some(command => typeof command === 'string' && command.replaceAll('\\','/').includes('"' + HOOK + '"'));
}
function read(home) {
  const file = path.join(home,'hooks.json');
  const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')) : {hooks:{}};
  if (!data.hooks || typeof data.hooks !== 'object' || Array.isArray(data.hooks)) throw new Error('hooks 配置格式不正确，保持原文件不变');
  for (const groups of Object.values(data.hooks)) {
    if (!Array.isArray(groups) || groups.some(group=>!Array.isArray(group.hooks))) throw new Error('hooks 分组格式不正确，保持原文件不变');
  }
  return {file,data};
}
function save(file,data) {
  const content = JSON.stringify(data,null,2)+'\n';
  if (fs.existsSync(file) && fs.readFileSync(file,'utf8') === content) return;
  fs.mkdirSync(path.dirname(file),{recursive:true});
  if (fs.existsSync(file)) {
    const backup = file+'.agent-bridge-backup-'+Date.now()+'-'+crypto.randomUUID().slice(0,8);
    fs.copyFileSync(file,backup);
    console.log('原 hooks 备份：'+backup);
  }
  fs.writeFileSync(file,content,'utf8');
}
export function installHooks({home=projectHome,commandPrefix=''}={}) {
  const {file,data} = read(home);
  const template=JSON.parse(fs.readFileSync(path.join(ROOT,'hooks.template.json'),'utf8'));
  const commandBase=commandPrefix+'"'+process.execPath.replaceAll('\\','/')+'" "'+HOOK+'"';
  for (const [event,groups] of Object.entries(template.hooks)) {
    const current=data.hooks[event] ?? [];
    // 精确匹配本服务绝对路径；保留同组内第三方处理器。
    const retained=current.map(group=>({...group,hooks:group.hooks.filter(handler=>!ours(handler))})).filter(group=>group.hooks.length);
    const resolved=groups.map(group=>({...group,hooks:group.hooks.map(handler=>({...handler,command:handler.command.replace('__COMMAND__',commandBase),commandWindows:handler.command.replace('__COMMAND__',commandBase)}))}));
    data.hooks[event]=[...retained,...resolved];
  }
  save(file,data);
  console.log('hooks 已准备：'+file+'；需要在 Codex 中审核并信任。');
  return file;
}
export function uninstallHooks({home=projectHome}={}) {
  const {file,data}=read(home);
  if (!fs.existsSync(file)) return;
  let changed=false;
  for (const [event,groups] of Object.entries(data.hooks)) {
    const retained=groups.map(group=>({...group,hooks:group.hooks.filter(handler=>{if(ours(handler)){changed=true;return false;}return true;})})).filter(group=>group.hooks.length);
    if(retained.length)data.hooks[event]=retained;else delete data.hooks[event];
  }
  if(!changed)return;
  save(file,data);
  if(!Object.keys(data.hooks).length && Object.keys(data).length===1) fs.rmSync(file);
  console.log('已移除本项目 hooks，其他配置保留。');
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=new Set(process.argv.slice(2));
  const home=args.has('--user') ? path.join(os.homedir(),'.codex') : projectHome;
  if(args.has('--hooks'))installHooks({home});
  else if(args.has('--uninstall'))uninstallHooks({home});
  else if(args.has('--status') || !args.size) {
    const {file,data}=read(home);
    console.log('hooks 路径：'+file+'；事件：'+Object.keys(data.hooks).join('、'));
  } else { console.error('参数：--hooks / --uninstall / --status；默认仅当前项目，--user 指用户级配置。notify 和文字回写不由本安装器修改。'); process.exitCode=1; }
}
