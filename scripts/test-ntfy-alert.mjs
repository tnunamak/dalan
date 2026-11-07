#!/usr/bin/env node
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const file=path.join(os.homedir(),'.config/dot-bridge/alerts.env');
if((fs.statSync(file).mode&0o777)!==0o600) throw new Error('alerts.env must be mode 0600');
const settings=Object.fromEntries(fs.readFileSync(file,'utf8').split('\n').filter(x=>x.includes('=')).map(line=>{const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];}));
if(!settings.NTFY_URL||!settings.NTFY_TOKEN) throw new Error('NTFY_URL and NTFY_TOKEN required');
const response=await fetch(settings.NTFY_URL,{method:'POST',headers:{Authorization:`Bearer ${settings.NTFY_TOKEN}`,Title:'dot-bridge test alert (ignore)','Content-Type':'text/plain'},body:'Test of dot-bridge subscription alerts. No action needed.',signal:AbortSignal.timeout(5000)});
if(!response.ok) throw new Error(`ntfy HTTP ${response.status}`);
console.log(`Test alert sent: HTTP ${response.status}`);
