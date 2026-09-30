import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installHooks, uninstallHooks } from '../tools/install.mjs';
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-hooks-'));
  t.after(() => fs.rmSync(home, {recursive:true, force:true}));
  const config = path.join(home, 'config.toml');
  fs.writeFileSync(config, 'notify = ["existing-program", "unchanged-argument"]\r\n');
  return {home, config, file:path.join(home,'hooks.json')};
}

test('explicit Mac data prefix persists in hooks and uninstall still recognizes owned handlers', t => {
 const e=fixture(t);
 installHooks({home:e.home,commandPrefix:"env AGENT_BRIDGE_DATA='/Users/test/Library/Application Support/AgentBridge' "});
 const installed=JSON.parse(fs.readFileSync(e.file));
 assert.ok(installed.hooks.Stop[0].hooks[0].command.startsWith("env AGENT_BRIDGE_DATA='/Users/test/Library/Application Support/AgentBridge' "));
 uninstallHooks({home:e.home});assert.equal(fs.existsSync(e.file),false);
});
test('追加本项目 hooks，保留外部 hook 和 notify，重复安装幂等', t => {
  const e = fixture(t);
  const foreign = {type:'command',command:'another-hook.mjs',timeout:4};
  const original = {description:'已有配置',hooks:{PermissionRequest:[{hooks:[foreign]}]}};
  fs.writeFileSync(e.file, JSON.stringify(original));
  const before = fs.readFileSync(e.config);
  installHooks({home:e.home});
  const installed = JSON.parse(fs.readFileSync(e.file));
  assert.deepEqual(installed.hooks.PermissionRequest[0].hooks[0],foreign);
  assert.equal(installed.hooks.PermissionRequest.length,2);
  assert.equal(installed.description,original.description);
  const ours = installed.hooks.PermissionRequest[1].hooks[0];
  assert.equal(ours.timeout,105);
  assert.equal(ours.timeoutSec,undefined);
  const first = fs.readFileSync(e.file);
  installHooks({home:e.home});
  assert.deepEqual(fs.readFileSync(e.file),first);
  assert.deepEqual(fs.readFileSync(e.config),before);
  assert.ok(fs.readdirSync(e.home).some(n=>n.includes('agent-bridge-backup')));
  uninstallHooks({home:e.home});
  assert.deepEqual(JSON.parse(fs.readFileSync(e.file)),original);
  assert.deepEqual(fs.readFileSync(e.config),before);
});
test('损坏的 hooks 不覆盖', t => {
  const e = fixture(t); fs.writeFileSync(e.file,'{invalid');
  assert.throws(()=>installHooks({home:e.home}));
  assert.equal(fs.readFileSync(e.file,'utf8'),'{invalid');
});
test('只移除自己的处理器，保留同组外部处理器', t => {
  const e = fixture(t); installHooks({home:e.home});
  const data = JSON.parse(fs.readFileSync(e.file));
  data.hooks.Stop[0].hooks.push({type:'command',command:'foreign-stop'});
  data.hooks.PreToolUse=[{hooks:[{type:'command',command:'foreign-policy'}]}];
  fs.writeFileSync(e.file,JSON.stringify(data));
  uninstallHooks({home:e.home});
  const remaining=JSON.parse(fs.readFileSync(e.file));
  assert.deepEqual(remaining.hooks.Stop[0].hooks,[{type:'command',command:'foreign-stop'}]);
  assert.ok(remaining.hooks.PreToolUse);
  assert.equal(remaining.hooks.PermissionRequest,undefined);
});
test('新 hooks 卸载后保留 config.toml', t => {
  const e=fixture(t); installHooks({home:e.home}); uninstallHooks({home:e.home});
  assert.equal(fs.existsSync(e.file),false); assert.equal(fs.existsSync(e.config),true);
});
