// Where the time between "queued" and "claimed" goes, one log line per step (no schema, no behavior change):
//   wake_delivery      each wake webhook: queued-to-attempt time and how long the receiver took to answer
//   claim_phase        each new claim: the timestamps and gaps from submit to wake, wake to first listing, listing to claim
//   claim_first_action the holder's first call on a fresh claim after the claim itself
// Fresh claims and finish handoffs are told apart by `handoff`: a handoff claim has no wake and no listing of its own.
// Remembered state is in memory and bounded; a restart forgets it, and the lines then carry nulls, never wrong numbers.
const iso=ms=>new Date(ms).toISOString();
const gap=(from,to)=>from==null||to==null?null:Math.round(to-from);
export function createPhaseTrace({log,now=Date.now,max=5000}) {
  const listed=new Map(),woke=new Map(),fresh=new Map();
  const remember=(map,key,value)=>{map.set(key,value);while(map.size>max)map.delete(map.keys().next().value);};
  return {
    // A list_pending call showed these rows: keep the first time each one was seen.
    listed(requestIds) {
      const at=now();
      for(const id of requestIds) if(!listed.has(id)) remember(listed,id,at);
    },
    // One wake webhook attempt. `attemptAt` is when the send began; `ackMs` is how long the receiver took to answer (null on a transport error).
    wake({item,worker,attemptAt,ackMs,status,state}) {
      const created=Date.parse(item.created_at);
      log({kind:'wake_delivery',event_id:item.id,request_id:item.request_id??null,worker,wake_kind:item.wake_kind??null,state,http_status:status??null,
        enqueued_at:item.created_at,attempt_at:iso(attemptAt),queued_to_attempt_ms:gap(created,attemptAt),ack_ms:ackMs==null?null:Math.round(ackMs)});
      if(item.request_id&&state==='delivered'&&!woke.has(item.request_id)) remember(woke,item.request_id,{attemptAt,ackAt:ackMs==null?null:attemptAt+ackMs});
    },
    // A new claim was granted. `createdAt` is the assignment's submit time.
    claimed({requestId,worker,subject,claimId,handoff,createdAt}) {
      // A handoff claim has no wake and no listing of its own: whatever an earlier failed or lapsed attempt left behind is not its timing.
      const at=now(),seen=handoff?null:listed.get(requestId)??null,wake=handoff?null:woke.get(requestId)??null,created=Date.parse(createdAt);
      listed.delete(requestId);woke.delete(requestId);
      // Send, answer and listing are separate stamps. A row listed before the answer came back (or before the send) has no known order: null, never a negative gap.
      const wakeToListed=wake&&wake.ackAt!=null&&seen!=null&&seen>=wake.ackAt?gap(wake.ackAt,seen):null;
      remember(fresh,requestId,{claimId,subject,at,handoff});
      log({kind:'claim_phase',request_id:requestId,worker,claim_id:claimId,handoff,created_at:createdAt,
        wake_attempt_at:wake?iso(wake.attemptAt):null,first_listed_at:seen==null?null:iso(seen),claimed_at:iso(at),
        submit_to_wake_ms:gap(created,wake?.attemptAt),wake_ack_ms:wake&&wake.ackAt!=null?Math.round(wake.ackAt-wake.attemptAt):null,
        wake_to_listed_ms:wakeToListed,listed_to_claim_ms:gap(seen,at),submit_to_claim_ms:gap(created,at)});
    },
    // The server provides a snapshot taken before the successful progress write.
    progress({requestId,claimId,claimedAt,first,note}) {
      if(!first) return;
      const stamp=/^dispatched_at=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)(?=\s|$)/.exec(note)?.[1];
      const sent=Date.parse(stamp), claimed=Date.parse(claimedAt);
      if(!Number.isFinite(sent)||iso(sent)!==stamp.replace('Z','.000Z')) return;
      const known=Number.isFinite(claimed);
      log({kind:'claim_dispatch',request_id:requestId,claim_id:claimId,dispatched_at:stamp,
        claimed_at:known?claimedAt:null,gap_ms:known&&claimed>=sent?gap(sent,claimed):null});
    },
    // Any worker call that names a request. The first one by the claimant after a fresh claim is the first action.
    action({requestId,tool,subject}) {
      const claim=fresh.get(requestId);
      if(!claim||claim.subject!==subject) return;
      fresh.delete(requestId);
      log({kind:'claim_first_action',request_id:requestId,claim_id:claim.claimId,tool,handoff:claim.handoff,after_claim_ms:gap(claim.at,now())});
    },
  };
}
