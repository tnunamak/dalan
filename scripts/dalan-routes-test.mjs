// `dalan routes` and the routes doc generator, against Dalan's contract-faithful fake of Gozar.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { routesMain } from '../src/routes.mjs';
import { main as docMain, renderRoutesDoc } from './routes-doc.mjs';
import { createFakeGozar } from '../src/test-support/gozar-fake.mjs';

const run = async (argv, gozar = createFakeGozar()) => { const lines = []; const catalog = await routesMain({ argv, env: { GOZAR_HOME: '/tmp/unused-gozar-home' }, out: line => lines.push(line), gozar }); return { lines, text: lines.join('\n'), catalog, gozar }; };

test('dalan routes lists every candidate with id, label, reach, lifetimes, ports, proof, needs, eligibility and consent text', async () => {
  const { text, catalog } = await run([]);
  assert.equal(catalog.candidates.length, 3);
  for (const c of catalog.candidates) {
    assert.match(text, new RegExp(`id: ${c.providerId}`));
    assert.ok(text.includes(c.display.label) && text.includes(c.display.needs) && text.includes(c.disclosure.text), c.providerId);
    assert.match(text, new RegExp(`reach: ${c.properties.reach}`));
    assert.ok(text.includes(`lifetimes: ${c.properties.lifetimes.join(', ')}`));
  }
  assert.match(text, /ports: 443; proof: checked from public; checks: tls, nonce/);
  assert.match(text, /ports: assigned by the provider; proof: checked from this-device; checks: tls/);
  assert.match(text, /ports: 443, 8443; proof: checked from none; no checks/);
  assert.match(text, /eligible: yes/);
  assert.match(text, /consent: Example disclosure text/);
});

test('dalan routes shows the unmet reasons of a route that cannot be used here', async () => {
  const { text } = await run([], createFakeGozar({ platform: 'darwin' }));
  assert.match(text, /eligible: no/);
  assert.match(text, /not met: platform \(unsupported_platform\)/);
});

test('dalan routes asks Gozar for the catalog and does nothing else', async () => {
  const { gozar } = await run([]);
  assert.deepEqual(gozar.fake.state.calls, ['catalogRoutes']);
  assert.equal(gozar.fake.state.effects.length, 0);
});

test('dalan routes --json prints Gozar\'s candidates as returned', async () => {
  const { lines, catalog } = await run(['--json']);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), catalog.candidates);
});

test('dalan routes refuses an unknown option, and reports a Gozar failure as its message', async () => {
  await assert.rejects(run(['--route', 'x']), /unknown option --route/);
  const gozar = createFakeGozar(); gozar.catalogRoutes = async () => { throw Object.assign(new Error('Gozar is busy now'), { code: 'busy' }); };
  await assert.rejects(run([], gozar), /Gozar is busy/);
});

// ---- the generated doc --------------------------------------------------------------------------------------------------------------------
const catalogOf = () => createFakeGozar().catalogRoutes({ schemaVersion: 1, owner: 'dalan', target: '127.0.0.1:8789', usage: { kind: 'durable', routeId: 'dalan-main' }, home: '/tmp/x',
  requirements: { reach: 'internet', transport: 'https', payloadAccess: 'allow-provider', address: 'any', setup: 'allow', protocols: ['sse'] } });

test('the routes doc lists each route by id, sorted, with ports, proof and needs', async () => {
  const doc = renderRoutesDoc(await catalogOf());
  assert.ok(doc.indexOf('`fake-ephemeral`') < doc.indexOf('`fake-setup`') && doc.indexOf('`fake-setup`') < doc.indexOf('`fake-stable`'));
  assert.match(doc, /public ports: 443, 8443/);
  assert.match(doc, /Proof before publishing: checked from public; checks: tls, nonce/);
  assert.match(doc, /Needs: A synthetic stable provider/);
  assert.equal(renderRoutesDoc(await catalogOf()), doc, 'the same catalog renders the same bytes');
});

test('--check passes on a current docs file and fails on a stale or missing one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-doc-test-'));
  try {
    const file = path.join(dir, 'routes.md'), lines = [], out = line => lines.push(line);
    const api = createFakeGozar();
    assert.equal(await docMain({ argv: ['--check'], api, file, out }), 1, 'a missing file is stale');
    assert.equal(await docMain({ argv: [], api, file, out }), 0);
    assert.equal(await docMain({ argv: ['--check'], api, file, out }), 0);
    fs.appendFileSync(file, '\nhand edit\n');
    assert.equal(await docMain({ argv: ['--check'], api, file, out }), 1);
    assert.match(lines.at(-1), /stale/);
    const smaller = createFakeGozar({ providers: { 'fake-stable': 'cand_stable' } });
    const narrowed = createFakeGozar({ providers: { 'fake-stable': 'cand_stable' } }); narrowed.catalogRoutes = async query => { const catalog = await smaller.catalogRoutes(query); return { ...catalog, candidates: catalog.candidates.filter(c => c.providerId === 'fake-stable') }; };
    assert.equal(await docMain({ argv: ['--check'], api: narrowed, file, out }), 1, 'a registry change makes the file stale');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
