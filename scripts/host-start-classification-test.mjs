#!/usr/bin/env node
import assert from 'node:assert/strict';
import { provesHostNotStarted } from '../src/host-budget.mjs';

assert.equal(provesHostNotStarted({spawnError:'ENOENT',pid:null,stopped:null}),true,'an OS spawn error proves systemd-run did not launch');
assert.equal(provesHostNotStarted({spawnError:null,pid:null,stopped:null,exitCode:1,diagnostic:'Unit already exists'}),false,'ambiguous admission refusal is not proof');
assert.equal(provesHostNotStarted({spawnError:null,pid:123,stopped:null}),false,'a started supervisor without a stop receipt stays unknown');
assert.equal(provesHostNotStarted({spawnError:'late error',pid:123,stopped:{verified:true}}),false,'any observed invocation or stop receipt prevents not-started classification');
console.log('PASS host launch classification requires a spawn OS error and no invocation or stop receipt');
