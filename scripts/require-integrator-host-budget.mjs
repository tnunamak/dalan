// These integration journeys must run a real budgeted check, not the legacy launcher.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { runHostBudget } from '../src/host-budget.mjs';
import { INTEGRATOR_HOST_BUDGET } from '../src/integrator.mjs';
import { hostReadiness } from '../src/execution.mjs';

process.env.DALAN_HOST_CHECKS='1';
const readiness=hostReadiness();
if(!readiness.ready) {
  console.log(`SKIP integrator verification: budgeted host executor unavailable (${readiness.reason})`);
  process.exit(77);
}
const probeDir=fs.mkdtempSync(path.join(os.tmpdir(),'integrator-budget-probe-'));
const probe=await runHostBudget({dir:probeDir,budgets:INTEGRATOR_HOST_BUDGET,enabled:true,phases:[{name:'check',argv:['/usr/bin/true']}]});
if(!probe.stop.verified||/^(host budget admission failed|host preparation failed)/.test(probe.error??'')) {
  console.log(`SKIP integrator verification: budgeted host executor unavailable (${probe.error??probe.stop.reason})`);
  process.exit(77);
}
if(probe.error) throw new Error(`budgeted host executor probe failed: ${probe.error}`);
if(probe.exit.code!==0) throw new Error(`budgeted host executor probe failed: ${JSON.stringify(probe)}`);
