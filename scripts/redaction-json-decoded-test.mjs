import assert from 'node:assert/strict';
import {test} from 'node:test';
import {redactSinkText,redactLogEntry,maskText,registerSecret} from '../src/redaction.mjs';
import {prepareOwnerReportArtifact,ownerReportArtifactBytes,ownerReportFormat} from '../src/owner-report-artifact.mjs';

const SECRET='safeDemoCredential9';
registerSecret(SECRET);
// The JSON escape for "s" (backslash, u, 0, 0, 7, 3) written out so the literal secret never appears in the text.
const ESC_S='\\u0073';
const escaped=`${ESC_S}afeDemoCredential9`;
const sinks={
  redactSinkText,
  maskText,
  redactLogEntry,
  ownerReportArtifact:text=>JSON.parse(ownerReportArtifactBytes(prepareOwnerReportArtifact({
    format:ownerReportFormat,version:1,summary:'s',result:text,progress:[],
  })).toString()).result,
};
for(const [name,sink] of Object.entries(sinks)) {
  test(`${name}: registered secret with one JSON-escaped character is masked`,() => {
    const text=`{"message":"${escaped}"}`;
    assert.equal(JSON.parse(text).message,SECRET,'fixture decodes to the registered secret');
    const out=sink(text);
    assert(!out.includes(SECRET)&&!out.includes(escaped),`${name} leaked: ${out}`);
  });
  test(`${name}: nested object and array values are inspected decoded`,() => {
    const text=`{"a":{"b":["x","${escaped}"],"c":1}}`;
    const out=sink(text);
    assert(!out.includes(SECRET)&&!out.includes(escaped),`${name} leaked: ${out}`);
  });
  test(`${name}: credential field name written with an escape is still a credential field`,() => {
    const text='{"\\u0070assword":"hunter2valueXYZ"}';
    assert.equal(Object.keys(JSON.parse(text))[0],'password');
    const out=sink(text);
    assert(!out.includes('hunter2valueXYZ'),`${name} leaked: ${out}`);
  });
  test(`${name}: a top-level JSON string document is inspected decoded`,() => {
    const text=`"${escaped}"`;
    assert.equal(JSON.parse(text),SECRET,'fixture decodes to the registered secret');
    const out=sink(text);
    assert(!out.includes(SECRET)&&!out.includes(escaped),`${name} leaked: ${out}`);
  });
  test(`${name}: strong-format token with an escaped character is masked`,() => {
    const token='ghp_'+'S'.repeat(36);
    const text=`{"note":"\\u0067hp_${'S'.repeat(36)}"}`;
    assert.equal(JSON.parse(text).note,token);
    const out=sink(text);
    assert(!out.includes(token)&&!out.includes('S'.repeat(36)),`${name} leaked: ${out}`);
  });
}

test('clean JSON text with escapes keeps its original formatting',() => {
  const text='{ "note" : "caf\\u00e9",  "n": [1, 2] }';
  assert.equal(redactSinkText(text),text);
});
