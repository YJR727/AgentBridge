// Explicit opt-in installer, run after dragging the app into /Applications.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {installHooks} from '../tools/install.mjs';
const data=path.join(os.homedir(),'Library','Application Support','AgentBridge');
if(process.platform!=='darwin'||!process.execPath.startsWith('/Applications/Agent Bridge.app/Contents/Resources/'))throw new Error('使用 /Applications 内已安装的 Agent Bridge 内嵌 Node 执行 hooks 安装；不要使用临时源码目录');
if(!fs.existsSync(path.join(data,'config.json')))throw new Error('请先打开 Agent Bridge，生成本机配置');
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
installHooks({home:process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),commandPrefix:'env AGENT_BRIDGE_DATA='+quote(data)+' '});
