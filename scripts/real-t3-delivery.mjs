#!/usr/bin/env node
import { callT3, sendArgs } from '../src/t3.mjs';
const threadId = process.env.T3_THREAD_ID;
if (!threadId) throw new Error('Set T3_THREAD_ID to the destination thread before running this live delivery check.');
const message='[dot-bridge fake-worker e2e] Local fake worker completed: signed event, claim, progress, finish, restart recovery, and exact-thread T3 delivery passed.';
const inspected=await callT3(['threads','read','--thread',threadId,'--turns','1','--detail','answers','--max-chars','100']);
if(inspected.thread?.deletedAt||inspected.thread?.status!=='active')throw new Error('target thread unavailable');
const argv=sendArgs(threadId);
const result=await callT3(argv,message);
console.log(JSON.stringify({pass:true,argv,message,result}));
