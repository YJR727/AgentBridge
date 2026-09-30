// Capture the existing service's output in the controller's private log, without a console.
import fs from 'node:fs';
import {format} from 'node:util';
const file=process.env.AGENT_BRIDGE_LOG;
if(!file)throw new Error('Desktop log path is required');
for(const level of ['log','warn','error'])console[level]=(...args)=>fs.appendFileSync(file,format(...args)+'\n','utf8');
await import('../server.mjs');
