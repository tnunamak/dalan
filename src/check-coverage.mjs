// Coverage comes from complete check output before preview truncation. Exit 77
// also marks incomplete coverage when a command supplied no segment detail.
function coverage(output,exitCode) {
  const names=new Set();let unnamed=0;
  const add=value=>{
    const label=value.trim(),script=label.match(/(?:^|[\/\s])(scripts\/[^\r\n]*?\.mjs)(?=\s|$)/);
    names.add(script?script[1]:label);
  };
  for(const match of output.matchAll(/^SKIP #\d+\/\d+: (.+)$/gm)) add(match[1]);
  for(const match of output.matchAll(/^SKIP host executor journey:[ \t]*([^\r\n]*)\r?$/gm)) {
    const name=match[1].replace(/(?:^|[ \t]+)\([^\r\n]*\)[ \t]*$/,'').trim();
    if(name) add(name);else unnamed++;
  }
  for(const match of output.matchAll(/^SKIP (?!#\d+\/\d+:|host executor journey:)(.+)$/gm)) add(match[1]);
  for(const match of output.matchAll(/^(?:ok|not ok) \d+ - (.+?) # SKIP(?: .*)?$/gm)) add(match[1]);
  let reported=null;
  for(const match of output.matchAll(/^TEST SEGMENTS: \d+ total, \d+ passed, \d+ failed, (\d+) skipped$/gm)) {
    const n=Number(match[1]);if(Number.isSafeInteger(n)) reported=Math.max(reported??0,n);
  }
  // The aggregate already includes unnamed lines from its child segments.
  // A contradictory zero summary must still leave an observed skip visible.
  const count=Math.max(names.size,reported??names.size+unnamed,unnamed?1:0,exitCode===77?1:0);
  return {skipped_segments:count,skipped_segment_names:[...names]};
}

export function withCheckCoverage(row,output) {
  const evidence=row.evidence;
  const skips=output!==undefined?coverage(output,row.exit_code)
    :Number.isSafeInteger(evidence?.skipped_segments)&&evidence.skipped_segments>=0?{skipped_segments:evidence.skipped_segments,skipped_segment_names:evidence.skipped_segment_names??[]}
    :coverage(row.output_preview??'',row.exit_code);
  const check_summary=skips.skipped_segments?`${row.check_id}: ${skips.skipped_segments} skipped segment${skips.skipped_segments===1?'':'s'}: ${skips.skipped_segment_names.join(', ')||'segment name unavailable'}`:null;
  let status=row.status;
  if(skips.skipped_segments&&status==='completed') {
    const failed=![0,77].includes(row.exit_code)||row.timed_out||row.cancelled||evidence?.cancelled||(row.phase??evidence?.phase)==='install';
    status=failed?'failed':'skipped';
  }
  return {...row,...skips,check_summary,status,evidence:evidence?{...evidence,...skips,check_summary}:evidence};
}
