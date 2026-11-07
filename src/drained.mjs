// `dalan wait --drained`: wake a producer agent when its own worker work runs low, so it refills the queue.
// Pure decision logic; bin/dot-worker.mjs does the reads, the pidfile and the sleeping.

export const drainedExitCodes={drained:0,attention:3,worker_break:5,paused:6,already_running:7,bridge_unreachable:8,error:9,timeout:124};
export const terminal=new Set(['finished','cancelled']);

// One evaluation step.
// states: [{request_id,status,blocker_count,last_blocker}] for every producer task seen so far.
// refill: {held:'paused'|'worker_break'|'throttle'|null} for the bridge now.
// memo: what the waiter knew at its start and previous step (mutated):
//   baseline: Map request_id -> blocker_count when the waiter first saw the request,
//   startTerminal: Set of request ids already terminal at the first step,
//   lastHeld: the previous step's refill.held, undefined on the first step.
// Returns a result object when the waiter should exit, else null.
export function decideDrained(states,refill,memo,{maxClaimed=0,maxQueued=1}={}) {
  const first=memo.lastHeld===undefined;
  const live=states.filter(s=>!terminal.has(s.status));
  const queued=live.filter(s=>s.status==='queued').length, claimed=live.filter(s=>s.status==='claimed').length;
  const attention=[];
  for(const s of states) {
    if(!memo.baseline.has(s.request_id)) memo.baseline.set(s.request_id,first?s.blocker_count:0);
    if(first&&terminal.has(s.status)) memo.startTerminal.add(s.request_id);
    if(!terminal.has(s.status)&&s.blocker_count>memo.baseline.get(s.request_id)) attention.push({request_id:s.request_id,status:/^\s*QUESTION:/im.test(s.last_blocker??'')?'question':'blocker',text:s.last_blocker});
  }
  const finished=states.filter(s=>terminal.has(s.status)&&!memo.startTerminal.has(s.request_id)).map(s=>({request_id:s.request_id,status:s.status}));
  const counts={queued,claimed};
  const held=refill?.held??null, previous=memo.lastHeld;
  memo.lastHeld=held;
  if(attention.length) return {status:'attention',in_flight:counts,attention,finished};
  // A break or pause that starts during the wait is news: the worker will take nothing for a while. One that was already on
  // when the waiter started is not; the waiter holds until refilling can work, so a restart never spins.
  if(!first&&previous!==held&&(held==='worker_break'||held==='paused')) return {status:held,reason:held==='paused'?'the bridge was paused':'the worker is on a usage break',in_flight:counts,finished};
  const low=claimed<=maxClaimed&&queued<=maxQueued;
  if(first) memo.startedAbove=!low;
  // Below the low-water mark at start with work still in flight (e.g. one task queued): wait for something to finish first.
  const drained=low&&(live.length===0||finished.length>0||memo.startedAbove);
  if(drained&&held) { memo.heldDrained=held; return null; }
  if(drained) return {status:'drained',in_flight:counts,finished,...(memo.heldDrained?{held_until_now:memo.heldDrained}:{})};
  return null;
}
