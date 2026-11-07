import { defaultPath } from './paths.mjs';
import { terminalSafeLine } from './terminal-safe.mjs';
import { readEnv } from './env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadRedeliveryLimits } from './store.mjs';
import { redactSinkText, registerSecret } from './redaction.mjs';

function config() {
  const file=readEnv('DALAN_ALERTS_FILE')||defaultPath(os.homedir(),'.config/dot-bridge/alerts.env');
  if(!fs.existsSync(file)) return {};
  if((fs.statSync(file).mode&0o777)!==0o600) throw new Error('alerts.env must be mode 0600');
  const settings=Object.fromEntries(fs.readFileSync(file,'utf8').split('\n').filter(x=>x.includes('=')).map(x=>{const i=x.indexOf('=');return [x.slice(0,i),x.slice(i+1)];}));
  // The publisher token and topic URL are credentials the bridge holds: mask them by value everywhere.
  for(const name of ['NTFY_TOKEN','NTFY_URL']) if(settings[name]) registerSecret(settings[name]);
  return settings;
}
const notAccepted=message=>Object.assign(new Error(message),{notifyOutcome:'not_accepted'});
const MASK='[redacted secret]';
// A credential may be split across title and body ("Bearer" / value, "whsec_" / suffix).
// If scanning the joined text masks more than the separate scans, mask the title's last token and the whole body:
// whitespace before the value means no token boundary in the body can be trusted to end the credential.
export function sanitizeAlertFields(rawTitle,rawMessage) {
  let title=redactSinkText(String(rawTitle).replace(/[\r\n]+/g,' ')),message=redactSinkText(rawMessage);
  const separate=`${title} ${message}`;
  const split=['',' '].some(glue=>redactSinkText(`${String(rawTitle).replace(/[\r\n]+/g,' ')}${glue}${rawMessage}`)!==(glue?separate:`${title}${message}`));
  if(split) {
    title=title.replace(/\S*$/,MASK);
    message=MASK;
  }
  return {title,message};
}
async function emit(rawTitle,rawMessage,log,settings,options={}) {
  // One pass before both the log and the transport: a caller never reaches either with a raw secret.
  const {title,message}=sanitizeAlertFields(rawTitle,rawMessage);
  if(!options.skipLog)log({kind:'alert',title,message});
  if(options.requirePublisher&&!settings.NTFY_URL) throw notAccepted('ntfy publisher missing');
  if(options.logOnly) return false;
  // With no publisher, writing the log is delivery; configured POST failures still retry.
  if(!settings.NTFY_URL) return !options.skipLog;
  const headers={Title:title,'Content-Type':'text/plain'};
  if(options.idempotencyKey) headers['X-Idempotency-Key']=options.idempotencyKey;
  if(settings.NTFY_TOKEN) headers.Authorization=`Bearer ${settings.NTFY_TOKEN}`;
  const response=await fetch(settings.NTFY_URL,{method:'POST',headers,body:message,signal:AbortSignal.timeout(5000)});
  if(!response.ok) {
    const message=`ntfy HTTP ${response.status}`;
    if(response.status>=400&&response.status<500) throw notAccepted(message);
    throw new Error(message);
  }
  return true;
}
export async function publishAlert(title,message,log,options={}) { return emit(title,message,log,config(),options); }
const minutes=ms=>Math.round(ms/60000);
// Transient worker pauses are normal; page only after 30 minutes on the trusted OS clock.
const ALERT_ATTENTION_DELAY_MS=30*60_000;
export function redactNote(text) {
  // Known values, strong formats and credential fields only: commit hashes and long identifiers stay readable.
  return terminalSafeLine(redactSinkText(String(text)).replace(/\s+/g,' ').trim());
}
// One start and one end alert per usage break; mark after delivery (log-only or published), so a failed publish retries.
async function breakAlerts(store,log,settings,limits) {
  store.pruneWorkerCalls();
  store.inferBreak(limits);
  const queued=store.hasQueuedFor(['dot']);
  for(const b of store.breakAlertsDue()) {
    if(!b.until&&!b.attention_published_at) {
      if(!queued) {store.observeBreakAlert(b.id,null);continue;}
      const first=b.alert_first_observed_at??store.stamp();
      if(!b.alert_first_observed_at)store.observeBreakAlert(b.id,first);
      if(store.nowMs()-Date.parse(first)<ALERT_ATTENTION_DELAY_MS||!Number.isFinite(Date.parse(first)))continue;
      // An inferred break is silence, not evidence: it is reported and holds nothing until the owner confirms it.
      const effect=b.source==='owner'?`Re-wakes are limited to one probe every ${minutes(limits.breakProbeMs??1800000)} min; the queue stays intact.`:'Not confirmed, so nothing is held; if the worker client reports a usage limit, confirm with dalan break --reason TEXT.';
      const published=await emit('Dalan attention',`worker_break: the worker ${b.source==='owner'?'is':'may be'} on a usage break since ${b.since} (${b.source}): ${redactNote(b.reason).slice(0,200)}. ${effect} Inspect with dalan breaks.`,log,settings);
      if(published)store.markBreakAlert(b.id,'start');
    }
    if(b.until&&b.attention_published_at&&!b.end_alerted_at) {
      const published=await emit('Dalan recovered',`worker_break resolved: ended ${b.until} by ${b.end_source} after ${minutes(Date.parse(b.until)-Date.parse(b.since))} min`,log,settings);
      if(published)store.markBreakAlert(b.id,'end');
    }
  }
}
const activeChecks=new WeakMap();
export function checkAlerts(store,log) {
  if(activeChecks.has(store)) return activeChecks.get(store);
  const run=checkAlertsNow(store,log).finally(()=>activeChecks.delete(store));
  activeChecks.set(store,run);
  return run;
}
async function checkAlertsNow(store,log) {
  const settings=config(),limits=loadRedeliveryLimits();
  for(const alert of store.pendingDeliveryAlerts()) {
    const message=`uncertain_delivery: ${alert.request_id?`request ${alert.request_id}`:`message ${alert.message_id??alert.notification_id}`}, notification ${alert.notification_id}: ${redactNote(alert.reason)}. This notice will not be resent automatically. No action is required.`;
    if(!alert.logged_at) {
      log({kind:'alert',...sanitizeAlertFields('Dalan attention',message)});
      store.deliveryAlertLogged(alert.notification_id);
    }
    if(!settings.NTFY_URL)continue;
    await emit('Dalan attention',message,log,settings,{requirePublisher:true,skipLog:true});
    store.deliveryAlertPublished(alert.notification_id);
  }
  await breakAlerts(store,log,settings,limits);
  // Episodes opened under the old condition name continue under the current one.
  store.db.prepare("UPDATE OR IGNORE alert_episodes SET condition='skipped_by_worker' WHERE condition='skipped_by_dot'").run();
  const status=store.status({limits}),lead=Number(settings.ALERT_LEAD_MS||21600000);
  const live=status, classes=live.queue_classes, queued=status.counts.find(x=>x.status==='queued')?.count||0;
  const slots=`${live.claimed_outer_count} of ${live.max_claimed_outer_assignments} slots claimed`;
  const expiresAt=status.subscription.expires_at?Date.parse(status.subscription.expires_at):null;
  // Estimated limits are metrics: reaching one pages once and holds nothing.
  const over=store.overEstimate(limits);
  const denied=status.claim_denied??{count:0,request_ids:[]};
  const conditions={
    claim_denied:{active:denied.count>0,message:()=>`claim_denied: the worker reported that its reviewer denied the claim of ${denied.count} queued assignment(s): ${denied.request_ids.join(', ')}${denied.capacity_hold_until?`. It was a capacity overrun, so re-wakes hold until a claimed assignment ends (at most until ${denied.capacity_hold_until})`:''}. The worker will not retry them and the bridge no longer re-wakes them; cancel or resubmit. Inspect with dalan get ID.`},
    skipped_by_worker:{active:status.skipped_by_worker.count>0,message:()=>`skipped_by_worker: the worker listed but did not claim ${status.skipped_by_worker.count} queued assignment(s) despite free lanes: ${status.skipped_by_worker.request_ids.join(', ')}. They now list after their peers; cancel and re-issue, or take the work yourself.`},
    usage_over_estimate:{active:over.length>0,message:()=>`usage_over_estimate: ${over.map(o=>`${o.name} ${o.used}/${o.limit}${o.learned!==undefined?` (configured ${o.configured}, learned ${o.learned} from break ${o.break_id}${o.learned<o.limit?', floored':''})`:''}`).join('; ')}. Estimates only; the bridge holds no work for them. Inspect with dalan learned.`},
    subscription_lapse:{active:status.subscriptions_active>0&&expiresAt&&expiresAt-store.nowMs()<=lead},
    subscription_inactive:{active:status.subscriptions_active===0},
    callback_auth:{active:status.subscription.auth_failures>=3},
    pause_suspected:{active:classes.pause_suspected>0&&queued>0,message:()=>`pause_suspected: no worker tool call for ${minutes(live.worker_silence_ms??live.oldest_unclaimed_event_2xx_age_ms??0)} min while ${queued} assignments are queued (${slots}). Pause cause unconfirmed.`},
    stale_claims:{active:live.stale_claims.count>0,message:()=>`stale_claims: ${live.stale_claims.count} claimed assignments idle up to ${minutes(live.stale_claims.max_idle_ms)} min (${slots}). Their leases have expired, so another claimant may take them over; the bridge does not abandon them by itself. Inspect with dalan claims.`},
    unclaimed_queued:{active:(live.unclaimed_after_reannounce?.count??0)>0,message:()=>`unclaimed_queued: ${live.unclaimed_after_reannounce.count} queued assignments outlived the ${minutes(limits.rewakeWindowMs)} min re-wake window without a claim (oldest queued ${minutes(live.unclaimed_after_reannounce.oldest_age_ms??0)} min, ${slots}). They are re-woken at most every ${minutes(limits.rewakeStaleMs??1200000)} min; the bridge does not cancel or park them. Inspect with dalan status --json.`},
    transport_failing:{active:classes.transport_failing>0,message:()=>`transport_failing: ${classes.transport_failing} queued assignments never had an event accepted (oldest unclaimed age ${minutes(live.oldest_queue_age_ms??0)} min).`}
  };
  for(const [name,{active,message}] of Object.entries(conditions)) {
    const old=store.db.prepare('SELECT active,started_at,attention_sent_at FROM alert_episodes WHERE condition=?').get(name);
    const now=store.stamp();
    if(active) {
      const started=old?.active&&old.started_at?old.started_at:now;
      if(!old?.active||!old.started_at)store.db.prepare('INSERT INTO alert_episodes(condition,active,started_at,last_change_at,attention_sent_at) VALUES(?,1,?,?,NULL) ON CONFLICT(condition) DO UPDATE SET active=1,started_at=excluded.started_at,last_change_at=excluded.last_change_at,attention_sent_at=NULL').run(name,started,now);
      if(store.nowMs()-Date.parse(started)>=ALERT_ATTENTION_DELAY_MS&&!old?.attention_sent_at) {
        const published=await emit('Dalan attention',message?message():`${name}: inspect dalan status --json`,log,settings);
        // Remote acceptance and the local marker are not atomic; lost replies may duplicate transport.
        if(published)store.db.prepare('UPDATE alert_episodes SET attention_sent_at=? WHERE condition=? AND active=1 AND attention_sent_at IS NULL').run(store.stamp(),name);
      }
    } else if(old?.active) {
      if(old.attention_sent_at&&!await emit('Dalan recovered',`${name} resolved`,log,settings))continue;
      store.db.prepare('UPDATE alert_episodes SET active=0,started_at=NULL,last_change_at=?,attention_sent_at=NULL WHERE condition=?').run(now,name);
    }
  }
  const denials=store.denialNotes();
  if(denials.matches.length) {
    const quote=redactNote(denials.matches[0]).slice(0,80), more=denials.matches.length>1?` (+${denials.matches.length-1} more)`:'';
    // Logged, not paged: a per-task auto-review block is the worker's own business; a real pause pages as pause_suspected or worker_break.
    await emit('Dalan attention',`denial_mentioned: a worker note mentions a denial or pause: "${quote}"${more}. Likely pause cause; no action taken.`,log,settings,{logOnly:true});
  }
  store.ackDenialNotes(denials);
}
