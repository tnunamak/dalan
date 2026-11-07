// Legacy journeys have no explicit host budgets. With the default-off setting,
// verify refusal and skip; host-budgets-test.mjs exercises the contained backend.
import assert from 'node:assert/strict';
import { hostCheckRefusal } from '../src/host-execution-policy.mjs';

const reason=hostCheckRefusal({});
if(reason) {
  const { Workspace }=await import('../src/workspace.mjs');
  const receiver={store:{get:()=>({assignment:{}})}};
  for(const network of [false,true]) {
    await assert.rejects(Workspace.prototype.runConfined.call(receiver,'fixture','/unused',['/must-not-run'],{network}),/resource_limits_unavailable/);
  }
  console.log(`SKIP host executor journey: ${process.argv[1]} (${reason})`);
  process.exit(77);
}
