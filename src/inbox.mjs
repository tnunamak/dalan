// `dalan inbox`: what of mine finished, is unread, or needs an answer. Pure classification of /owner-states rows;
// bin/dot-worker.mjs does the reads. Nothing here, or in the batch read behind it, records an owner read.

import { terminalSafeLine } from './terminal-safe.mjs';
export const inboxGroups=['finished_unread','question','undecided','cancelled_unread'];
export const decideWords='accepted|applied|useful_no_change|useful_negative|not_useful';
const firstLine=text=>{ const line=String(text).split('\n').find(l=>l.trim())?.trim()??''; return line.length>100?line.slice(0,97)+'...':line; };

// One owner-states row to an inbox item, or null when the owner has nothing to do for it.
export function inboxItem(state) {
  const v=state.inbox;
  if(!v||state.error) return null;
  const base={request_id:state.request_id,worker:v.target_worker,title:firstLine(v.brief)};
  const failure=v.failure_type?{failure_type:v.failure_type,failure_type_source:v.failure_type_source}:{};
  const get=`dalan get ${state.request_id}`;
  if(state.status==='finished'&&!v.consumed&&!v.delivered_t3) return {group:'finished_unread',...base,...failure,status:v.outcome==='blocked'?'blocked':'finished',finished_at:v.finished_at,updated_at:v.finished_at,next:[get]};
  // Read (or delivered to T3) and not decided: the inbox asks for one word. A stale expiry counts as decided; the owner may still overwrite it.
  if(state.status==='finished'&&(v.consumed||v.delivered_t3)&&v.decision===null) return {group:'undecided',...base,...failure,status:v.outcome==='blocked'?'blocked':'finished',finished_at:v.finished_at,updated_at:v.finished_at,next:[`dalan decide ${state.request_id} ${decideWords}`]};
  if(state.status==='cancelled'&&!v.read&&!v.cancelled_by_owner) return {group:'cancelled_unread',...base,...failure,...(v.failure_type==='expired'?{expired:true}:{}),status:state.status,reason:v.cancelled_reason,updated_at:v.cancelled_at,next:[get]};
  if(state.status!=='finished'&&state.status!=='cancelled'&&v.unanswered_blocker) return {group:'question',...base,status:/^\s*QUESTION:/im.test(v.unanswered_blocker.text)?'question':'blocker',text:firstLine(v.unanswered_blocker.text),updated_at:v.unanswered_blocker.at,next:[get,`dalan note ${state.request_id} "..."`]};
  return null;
}

// '72h', '3d', an RFC3339 time, or 'all' (null: no limit) to a cutoff in ms since the epoch. Anything else throws.
export function parseWhen(text,now=Date.now()) {
  if(text==='all') return null;
  const rel=/^(\d+)([hd])$/.exec(text??'');
  if(rel) return now-Number(rel[1])*(rel[2]==='h'?3600000:86400000);
  const ms=/^\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:\d\d)$/.test(text??'')?Date.parse(text):NaN;
  if(Number.isNaN(ms)) throw new Error(`invalid time '${text}': use Nh, Nd, an RFC3339 time (--since also takes all)`);
  return ms;
}
const stale=(item,cutoff)=>cutoff!==null&&item.group!=='question'&&Date.parse(item.updated_at)<cutoff;

// Unread finished results older than the window are counted, not listed. Unanswered questions are always listed.
export function buildInbox(states,scope,{cutoff=null}={}) {
  const all=states.map(inboxItem).filter(Boolean).sort((a,b)=>String(a.updated_at).localeCompare(String(b.updated_at)));
  const items=all.filter(i=>!stale(i,cutoff)), hidden_older=all.length-items.length;
  const delivered_t3=states.filter(s=>!s.error&&s.status==='finished'&&s.inbox&&!s.inbox.consumed&&s.inbox.delivered_t3).length;
  const unknown=states.filter(s=>s.error).map(s=>s.request_id);
  const counts=Object.fromEntries(inboxGroups.map(g=>[g,items.filter(i=>i.group===g).length]));
  return {scope,total:items.length,counts,hidden_older,delivered_t3,items,...(unknown.length?{unknown}:{})};
}

export function formatInbox(inbox) {
  const hidden=inbox.hidden_older?`${inbox.hidden_older} older item${inbox.hidden_older===1?'':'s'} hidden (--since all to show)`:'';
  if(!inbox.total) return hidden?`inbox empty\n${hidden}`:'inbox empty';
  const lines=[];
  for(const g of inboxGroups) for(const i of inbox.items.filter(x=>x.group===g)) {
    const why=i.group==='cancelled_unread'?` (${i.reason??'cancelled'})`:i.group==='question'?` ${i.text}`:'';
    lines.push(terminalSafeLine(`${g}  ${i.request_id}  ${i.worker}  ${i.status}  ${i.updated_at??''}  ${i.title}${why}  -> ${i.next.join(' | ')}`));
  }
  lines.push(`${inbox.total} item${inbox.total===1?'':'s'}: ${inboxGroups.map(g=>`${inbox.counts[g]} ${g}`).join(', ')}${hidden?`; ${hidden}`:''}`);
  return lines.join('\n');
}
