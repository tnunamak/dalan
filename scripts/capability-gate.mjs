// A module, not a test: scripts/capability-table-test.mjs imports it and exercises it (see the synthetic reports there). Running it alone does nothing, so it is not a suite segment.
// The drift gate: the probe suite's JSON report must come from a run that exited 0 with no failed probe, and its measured capabilities
// must equal the declared table. A failing probe fails the gate even when the capability summary happens to match.
import assert from 'node:assert/strict';

function mismatchDetails(report, backend) {
  const measured=report?.capabilities??{}, expected=backend.capabilities;
  const probes=new Map((report?.probes??[]).map(probe=>[probe.id,probe]));
  const clean=value=>String(value??'no recorded reason').replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g,' ').slice(0,1100);
  return [...new Set([...Object.keys(expected),...Object.keys(measured)])].sort()
    .filter(key=>expected[key]!==measured[key]).map(key=>{
      const ids=report?.capability_probes?.[key];
      const reasons=Array.isArray(ids)&&ids.length?ids.map(id=>{
        const probe=probes.get(id);
        return probe ? clean(id)+' '+clean(probe.status)+': '+clean(probe.evidence) : clean(id)+' MISSING: no probe result';
      }).join('; '):'no mapped probes';
      return clean(key)+': declared '+clean(expected[key])+', measured '+clean(measured[key])+'; '+reasons;
    }).join('\n');
}

export function gate({ status, report, backend }) {
  const details=mismatchDetails(report,backend);
  const extra=details?'\n'+details:'';
  assert.equal(status, 0, 'probe suite exited '+status+extra);
  assert.equal(report.backend, backend.name);
  const failed = report.probes.filter(p => p.status === 'FAIL').map(p => p.id);
  assert.equal(report.summary.fail, 0, 'probe suite reports '+report.summary.fail+' failed probe(s): '+failed.join(', ')+extra);
  assert.deepEqual(failed, [], 'failed probes: '+failed.join(', ')+extra);
  assert.deepEqual(report.capabilities, backend.capabilities, 'declared table differs from measurement\n'+
    'declared: '+JSON.stringify(backend.capabilities)+'\nmeasured: '+JSON.stringify(report.capabilities)+extra);
}
