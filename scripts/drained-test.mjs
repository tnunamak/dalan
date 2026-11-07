#!/usr/bin/env node
import assert from 'node:assert/strict';
import { decideDrained } from '../src/drained.mjs';

const memo=()=>({baseline:new Map(),startTerminal:new Set(),lastHeld:undefined});
const s=(request_id,status,blocker_count=0,last_blocker=null)=>({request_id,status,blocker_count,last_blocker});
const free={held:null};

// Nothing in flight: refill now.
assert.equal(decideDrained([],free,memo())?.status,'drained');
// Above low water, then two finish: drained, with the finished list.
let m=memo();
assert.equal(decideDrained([s('a','claimed'),s('b','claimed'),s('c','queued')],free,m),null);
const out=decideDrained([s('a','finished'),s('b','cancelled'),s('c','queued')],free,m);
assert.deepEqual(out,{status:'drained',in_flight:{queued:1,claimed:0},finished:[{request_id:'a',status:'finished'},{request_id:'b',status:'cancelled'}]});
// One queued at start is already low; wait for it to finish rather than wake at once (no spin).
m=memo();
assert.equal(decideDrained([s('a','queued')],free,m),null);
assert.equal(decideDrained([s('a','claimed')],free,m),null);
assert.equal(decideDrained([s('a','finished')],free,m)?.status,'drained');
// Tasks already terminal at start are not news.
m=memo();
assert.equal(decideDrained([s('old','finished'),s('a','queued')],free,m),null);
// A new question wakes; one present at start does not.
m=memo();
assert.equal(decideDrained([s('a','claimed',1,'QUESTION: old'),s('b','claimed'),s('c','claimed')],free,m),null);
const q=decideDrained([s('a','claimed',1,'QUESTION: old'),s('b','claimed',1,'BLOCKED: no access'),s('c','claimed')],free,m);
assert.equal(q.status,'attention'); assert.deepEqual(q.attention,[{request_id:'b',status:'blocker',text:'BLOCKED: no access'}]);
// A task first seen mid-wait with a question wakes too.
m=memo();
assert.equal(decideDrained([s('a','claimed'),s('b','claimed')],free,m),null);
assert.equal(decideDrained([s('a','claimed'),s('b','claimed'),s('n','claimed',1,'QUESTION: which?')],free,m).attention[0].status,'question');
// Custom low water.
assert.equal(decideDrained([s('a','claimed'),s('b','queued'),s('c','queued')],free,memo(),{maxClaimed:1,maxQueued:2}),null);
m=memo(); decideDrained([s('a','claimed'),s('b','claimed')],free,m,{maxClaimed:1,maxQueued:0});
assert.equal(decideDrained([s('a','claimed'),s('b','finished')],free,m,{maxClaimed:1,maxQueued:0}).status,'drained');
// A break that starts mid-wait exits with a reason; one already on at start holds, then drained exits after it clears.
m=memo();
assert.equal(decideDrained([s('a','claimed'),s('b','claimed')],free,m),null);
assert.equal(decideDrained([s('a','claimed'),s('b','claimed')],{held:'worker_break'},m).status,'worker_break');
m=memo();
assert.equal(decideDrained([s('a','claimed'),s('b','claimed')],{held:'worker_break'},m),null);
assert.equal(decideDrained([s('a','finished'),s('b','finished')],{held:'worker_break'},m),null);
assert.deepEqual(decideDrained([s('a','finished'),s('b','finished')],free,m),{status:'drained',in_flight:{queued:0,claimed:0},finished:[{request_id:'a',status:'finished'},{request_id:'b',status:'finished'}],held_until_now:'worker_break'});
// Pause mid-wait exits; a 'throttle' hold (sent only by older bridges; the current bridge never holds on an estimate) only holds the drained exit (a held submit means wait).
m=memo(); decideDrained([s('a','claimed'),s('b','claimed')],free,m);
assert.equal(decideDrained([s('a','claimed'),s('b','claimed')],{held:'paused'},m).status,'paused');
m=memo(); decideDrained([s('a','claimed'),s('b','claimed')],free,m);
assert.equal(decideDrained([s('a','claimed'),s('b','claimed')],{held:'throttle'},m),null);
assert.equal(decideDrained([s('a','finished'),s('b','finished')],{held:'throttle'},m),null);
assert.equal(decideDrained([s('a','finished'),s('b','finished')],free,m).status,'drained');
console.log('PASS drained decision: low water, no-spin start, new attention only, break/pause transitions, throttle hold');
