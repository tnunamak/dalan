// systemd runs this after stopping the service's control group. Check for
// unkillable survivors instead of treating a stop request as proof of cessation.
import fs from 'node:fs';
import {writeHostStop,validateReceiptIdentity} from './host-budget-receipts.mjs';
import {readCgroupProcesses} from './host-cgroup.mjs';
const relative=fs.readFileSync('/proc/self/cgroup','utf8').split('\n').find(l=>l.startsWith('0::')).slice(3);
const remaining=readCgroupProcesses('/sys/fs/cgroup'+relative);
const events=fs.readFileSync('/sys/fs/cgroup'+relative+'/memory.events','utf8');
const oom_kill=Number(events.match(/^oom_kill (\d+)$/m)?.[1] ?? 0);
const stop={verified:remaining.length===0,remaining_pids:remaining,invocation_id:process.env.INVOCATION_ID,result:process.env.SERVICE_RESULT,exit_code:process.env.EXIT_CODE,exit_status:process.env.EXIT_STATUS,oom_kill};
try {
  const args=process.argv.slice(2);
  if(args.length) {
    if(args.length!==4||args[0]!=='--check-run-id'||args[2]!=='--receipt-dir') throw new Error('invalid host receipt recorder arguments');
    const checkRunId=args[1],receiptDir=args[3],invocationId=process.env.INVOCATION_ID;
    validateReceiptIdentity(checkRunId,invocationId);
    writeHostStop({receiptDir,checkRunId,invocationId,verified:stop.verified,remaining_pids:remaining});
  }
} catch {
  process.stderr.write('durable host stop receipt unavailable\n');
  stop.verified=false;
  process.exitCode=1;
} finally {
  // A pipe event is advisory. A failed durable write cannot assert a stop.
  process.stdout.write(JSON.stringify({event:'stopped',stop})+'\n');
}
