import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalSafe, jsonTerminalSafe, terminalSafeLine } from '../src/terminal-safe.mjs';

// Exercise every newly escaped range, including both ends of the surrogate range.
const hiddenUnits = [
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
  0x2066, 0x2067, 0x2068, 0x2069,
  0x200e, 0x200f, 0x200b, 0xfeff,
  0xd800, 0xdbff, 0xdc00, 0xdfff,
];
for (const code of hiddenUnits) {
  const raw = String.fromCharCode(code);
  const spelled = '\\u' + code.toString(16).padStart(4, '0');
  const input = 'x' + raw + 'y';
  test('human output spells ' + spelled, () => {
    for (const safe of [terminalSafe, terminalSafeLine]) {
      const output = safe(input);
      assert.equal(output.includes(raw), false);
      assert.equal(output, 'x' + spelled + 'y');
    }
  });
  test('JSON round trips ' + spelled + ' without a raw invisible unit', () => {
    // Well-formed JSON.stringify already escapes lone surrogates on modern Node.
    const output = jsonTerminalSafe(JSON.stringify({ t: input }));
    assert.equal(output.includes(raw), false);
    assert.equal(output.includes(spelled), true);
    assert.deepEqual(JSON.parse(output), { t: input });
  });
}

const unchanged = [
  ['ZWNJ', 'a\u200cb'],
  ['ZWJ family', '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}'],
  ['Persian', '\u0645\u06cc\u200c\u062e\u0648\u0627\u0645'],
  ['valid surrogate pair', '\ud83d\ude00'],
];
for (const [label, input] of unchanged) {
  test(label + ' remains unchanged', () => {
    assert.equal(terminalSafe(input), input);
    assert.equal(terminalSafeLine(input), input);
    assert.equal(jsonTerminalSafe(input), input);
    const json = JSON.stringify({ t: input });
    assert.equal(jsonTerminalSafe(json), json);
    assert.deepEqual(JSON.parse(jsonTerminalSafe(json)), { t: input });
  });
}
