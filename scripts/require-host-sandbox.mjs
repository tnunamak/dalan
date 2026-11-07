// Gate for the tests that attack the host check sandbox. They opt in to host checks themselves (as sandbox-probe-e2e does), then:
//  - a platform without the sandbox prerequisites prints why and exits 77 (skip);
//  - a platform with them must run the sandbox, so any remaining refusal throws and fails the test instead of skipping it.
import fs from 'node:fs';
import { hostCheckRefusal } from '../src/host-execution-policy.mjs';

const missing = [];
if (process.platform !== 'linux') missing.push(`no enforced host budget backend on ${process.platform}`);
else {
  for (const file of ['/usr/bin/bwrap', '/usr/bin/systemd-run', '/usr/bin/python3', '/sys/fs/cgroup/cgroup.controllers']) if (!fs.existsSync(file)) missing.push(`${file} is missing`);
}
if (missing.length) {
  console.log(`SKIP host sandbox journey: ${process.argv[1]} (the sandbox is unavailable on this host: ${missing.join('; ')})`);
  process.exit(77);
}
process.env.DALAN_HOST_CHECKS = '1';
const refusal = hostCheckRefusal({});
if (refusal) throw new Error(`the host sandbox is available but host checks are refused, so the attack test cannot run: ${refusal}`);
