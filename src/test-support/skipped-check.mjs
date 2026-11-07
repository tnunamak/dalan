// A test file that skips one check, and still runs the rest, calls skipCheck. The line it prints is visible in the
// output. When the segment runner sets DALAN_TEST_SKIP_REPORT, the skip is also recorded for its final summary.
import fs from 'node:fs';

// A group of checks skipped for one reason passes { count }, so the runner counts each check, not the group.
export function skipCheck(name, reason, { count = 1 } = {}) {
  const label = count > 1 ? `${name} (${count} checks)` : name;
  console.log(`SKIP: ${label} — ${reason}`);
  const report = process.env.DALAN_TEST_SKIP_REPORT;
  if (report) fs.appendFileSync(report, `${JSON.stringify({ name: label, reason, count })}\n`);
}
