import assert from 'node:assert/strict';
import { unsupportedDependencies } from '../src/prepared-node-modules.mjs';

// Which manifests and locks the host can never prepare, so run_check is not offered for them.
const pkg = extra => JSON.stringify({ name: 'f', version: '1.0.0', ...extra });
const lock = (packages = {}, extra = {}) => JSON.stringify({ name: 'f', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'f', version: '1.0.0' }, ...packages }, ...extra });
const reason = /without workspaces|local or workspace/;

assert.equal(unsupportedDependencies(pkg(), lock({ 'node_modules/a': { version: '1.0.0', resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz' } })), null, 'a plain registry lockfile is supported');
assert.equal(unsupportedDependencies(pkg(), null), null, 'no lockfile: nothing to prepare, not unsupported');
assert.equal(unsupportedDependencies('{not json', lock()), null, 'unparseable input is left to the normal refusal path');
assert.match(unsupportedDependencies(pkg({ workspaces: ['packages/*'] }), lock()), reason, 'workspaces');
assert.match(unsupportedDependencies(pkg(), lock({ 'node_modules/p': { resolved: 'packages/p', link: true } })), reason, 'linked package');
assert.match(unsupportedDependencies(pkg(), lock({ 'packages/p': { version: '1.0.0' } })), reason, 'a package outside node_modules');
assert.match(unsupportedDependencies(pkg(), lock({ 'node_modules/a': { resolved: 'file:../a' } })), reason, 'file: resolution');
assert.match(unsupportedDependencies(pkg(), lock({ '': { name: 'f', dependencies: { a: 'workspace:*' } } })), reason, 'workspace: dependency');
assert.match(unsupportedDependencies(pkg(), lock({}, { lockfileVersion: 1 })), reason, 'lockfileVersion 1');
console.log('PASS unsupported dependencies are recognised without preparing');
