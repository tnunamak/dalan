#!/usr/bin/env node
// Extracts the three JSON Schemas and the 42 golden traces from the Job Protocol Fixture Profile v0 markdown
// into scripts/conformance/fixtures/, so fixtures stay in sync with the doc. Records the doc SHA-256.
// Usage: node extract-fixtures.mjs [path-to-doc]
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const here = path.dirname(new URL(import.meta.url).pathname);
const inputDoc = process.argv[2] ?? process.env.CONFORMANCE_DOC;
if (!inputDoc) throw new Error('Pass the conformance document path or set CONFORMANCE_DOC.');
const doc = path.resolve(inputDoc);
const text = fs.readFileSync(doc, 'utf8');
const sha256 = createHash('sha256').update(text).digest('hex');
const out = path.join(here, 'fixtures');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'traces'), { recursive: true });

// Walk headings; attach each ```json block to the nearest preceding heading.
const lines = text.split('\n');
let heading = '', inBlock = false, buf = [];
const blocks = [];
for (const line of lines) {
  if (!inBlock) {
    if (/^#{2,4} /.test(line)) heading = line.replace(/^#+ /, '').trim();
    else if (line.trim() === '```json') { inBlock = true; buf = []; }
  } else if (line.trim() === '```') { blocks.push({ heading, json: buf.join('\n') }); inBlock = false; }
  else buf.push(line);
}
const schemas = { 'Command JSON Schema': 'command.schema.json', 'Event JSON Schema': 'event.schema.json', 'Reply JSON Schema': 'reply.schema.json' };
const traces = [];
for (const b of blocks) {
  const value = JSON.parse(b.json);
  if (schemas[b.heading]) fs.writeFileSync(path.join(out, schemas[b.heading]), JSON.stringify(value, null, 1) + '\n');
  else if (/^T\d\d /.test(b.heading)) {
    if (!b.heading.startsWith(value.id + ' ')) throw new Error(`heading ${b.heading} does not match trace id ${value.id}`);
    traces.push(value);
    fs.writeFileSync(path.join(out, 'traces', `${value.id}.json`), JSON.stringify(value, null, 1) + '\n');
  } else throw new Error(`unexpected json block under heading: ${b.heading}`);
}
if (traces.length !== 42) throw new Error(`expected 42 traces, found ${traces.length}`);
for (let i = 0; i < 42; i++) if (traces[i].id !== `T${String(i + 1).padStart(2, '0')}`) throw new Error('trace order/ids not T01..T42');
for (const f of Object.values(schemas)) if (!fs.existsSync(path.join(out, f))) throw new Error(`missing ${f}`);
const schemaSha256 = Object.fromEntries(Object.entries(schemas).map(([, file]) => [file.replace('.schema.json', ''), createHash('sha256').update(fs.readFileSync(path.join(out, file))).digest('hex')]));
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const traceSha256 = Object.fromEntries(traces.map(trace => [trace.id, createHash('sha256').update(JSON.stringify(canonical(trace))).digest('hex')]));
const intentionalInvalidCommands = traces.flatMap(trace => trace.steps.flatMap((step, index) => step.expect?.reply?.code === 'INVALID' ? [`${trace.id}:${index}`] : []));
const manifest = { doc: 'conformance-input.md', docPath: 'conformance-input.md', docSha256: sha256, profileVersion: 0, traces: traces.length, traceIds: traces.map(trace => trace.id), traceSha256, nativeMustCases: 3, nativeMustCaseIds: ['A1-revoked-holder-no-effect', 'A2-destination-approval-required', 'A3-replacement-cannot-replay-grant'], schemaSha256, intentionalInvalidCommands, extractedBy: 'scripts/conformance/extract-fixtures.mjs' };
fs.writeFileSync(path.join(out, 'MANIFEST.json'), JSON.stringify(manifest, null, 1) + '\n');
console.log(`extracted 3 schemas and ${traces.length} traces from ${doc}\nsha256 ${sha256}`);
