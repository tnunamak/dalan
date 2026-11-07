// Independent PR #203 corpus. No real keys, tokens, network, or imports.
// All verdicts are STATIC predictions for fa3d2306e286a77cb666895cfb4996e523e0ec5b.
// This module constructs fixtures; it does not execute the repository redactor.
const corpusDash = String.fromCodePoint(0x2d);
const corpusBegin = ['BE', 'GIN'].join('');
const corpusEnd = ['EN', 'D'].join('');
const corpusPrivate = ['PRI', 'VATE'].join('');
const corpusKey = ['K', 'EY'].join('');
const corpusLabel = [corpusPrivate, corpusKey].join(' ');
const corpusRSA = ['R', 'SA'].join('');
const corpusBodyA = ['U1lO', 'VEhF', 'VElD', 'X0JP', 'RFlf', 'QQ=='].join('');
const corpusBodyB = ['U1lO', 'VEhF', 'VElD', 'X0JP', 'RFlf', 'Qg=='].join('');
const corpusLF = String.fromCharCode(10);
const corpusCRLF = String.fromCharCode(13, 10);
const corpusEscLF = String.fromCharCode(92) + 'n';
const corpusEscCRLF = String.fromCharCode(92) + 'r' + corpusEscLF;
const corpusRun = corpusDash.repeat(5);
const corpusShort = corpusDash.repeat(3);
const corpusFence = String.fromCharCode(96).repeat(3);
const corpusMarker = (kind, label = corpusLabel, left = corpusRun, right = left, separator = ' ') =>
  left + kind + separator + label + right;
const corpusOpen = (label = corpusLabel, left = corpusRun, right = left, separator = ' ') =>
  corpusMarker(corpusBegin, label, left, right, separator);
const corpusClose = (label = corpusLabel, left = corpusRun, right = left, separator = ' ') =>
  corpusMarker(corpusEnd, label, left, right, separator);
const corpusBlock = (
  opener = corpusOpen(),
  closer = corpusClose(),
  body = corpusBodyA,
  newline = corpusLF
) => [opener, body, ...(closer === null ? [] : [closer]), 'AFTER_CORPUS'].join(newline);
const corpusCases = [];
const corpusAdd = (name, text, mustMask, current, reason) => corpusCases.push({
  name, text, mustMask,
  note: 'current=' + current + '_STATIC; ' + reason
});
const corpusYes = (name, text, current = 'PASS', reason = 'Recognized opener masks every synthetic body sentinel; admission detects it.') =>
  corpusAdd(name, text, true, current, reason);
const corpusNo = (name, text, reason = 'Ordinary prose: admission false and output byte-for-byte unchanged.') =>
  corpusAdd(name, text, false, 'PASS', reason);
const corpusFail = (name, text, reason) => corpusYes(name, text, 'FAIL', reason);

// Ordering, malformed openers, and complete-versus-incomplete closes.
corpusYes('order-canonical', corpusBlock());
corpusYes('order-truncated-end-before-begin',
  corpusRun + corpusEnd + ' ' + corpusLabel + corpusLF + corpusBlock());
corpusYes('order-glued-truncated-end-before-begin',
  corpusRun + corpusEnd + corpusBlock());
corpusYes('order-stray-end-before-begin', corpusClose() + corpusLF + corpusBlock());
corpusYes('order-label-less-begin-adjacent',
  corpusRun + corpusBegin + corpusRun + corpusBlock());
corpusYes('order-label-less-end-adjacent',
  corpusRun + corpusEnd + corpusRun + corpusBlock());
corpusYes('order-two-adjacent-blocks',
  corpusBlock() + corpusBlock(corpusOpen(), corpusClose(), corpusBodyB));
corpusYes('order-nested-same-label',
  [corpusOpen(), corpusBodyA, corpusOpen(), corpusBodyB, corpusClose(), corpusClose()].join(corpusLF));
corpusYes('order-nested-different-labels',
  [corpusOpen(), corpusBodyA, corpusOpen(corpusRSA + ' ' + corpusLabel),
    corpusBodyB, corpusClose(corpusRSA + ' ' + corpusLabel), corpusClose()].join(corpusLF));
corpusYes('order-missing-footer', corpusBlock(corpusOpen(), null));
corpusYes('order-truncated-opener', corpusBlock(corpusOpen(corpusLabel, corpusRun, ''), null));
corpusYes('order-truncated-footer', corpusBlock(corpusOpen(), corpusClose(corpusLabel, corpusRun, '')));
corpusYes('order-mismatched-footer-label',
  corpusBlock(corpusOpen(), corpusClose(corpusRSA + ' ' + corpusLabel)));
corpusYes('order-mismatched-footer-width',
  corpusBlock(corpusOpen(), corpusClose(corpusLabel, corpusDash.repeat(7))));
corpusYes('order-short-glued', corpusBlock('word' + corpusOpen(corpusLabel, corpusShort),
  corpusClose(corpusLabel, corpusShort)));
corpusYes('order-short-unequal', corpusBlock(corpusOpen(corpusLabel, corpusShort, corpusDash.repeat(4)), null));
corpusYes('order-short-truncated', corpusBlock(corpusOpen(corpusLabel, corpusShort, ''), null));
corpusYes('order-label-less-short-adjacent',
  corpusShort + corpusBegin + corpusShort + corpusBlock());

// Case and separator variation. Labels/control words remain runtime-built.
for (const [name, transform] of [
  ['lower', s => s.toLowerCase()],
  ['upper', s => s.toUpperCase()],
  ['mixed', s => [...s].map((c, i) => i % 2 ? c.toLowerCase() : c.toUpperCase()).join('')]
]) corpusYes('case-' + name, corpusBlock(transform(corpusOpen()), transform(corpusClose())));
for (const [name, separator] of [
  ['spaces', '    '], ['tabs', '\t\t'], ['space-tab', ' \t '],
  ['nbsp', String.fromCodePoint(0xa0)], ['lf', corpusLF], ['crlf', corpusCRLF]
]) corpusYes('separator-' + name,
  corpusBlock(corpusOpen(corpusLabel, corpusRun, corpusRun, separator),
    corpusClose(corpusLabel, corpusRun, corpusRun, separator)));
for (const [name, separator] of [['colon', ': '], ['colon-tight', ':'], ['none', '']]) {
  corpusFail('separator-' + name, corpusBlock(
    corpusOpen(corpusLabel, corpusRun, corpusRun, separator),
    corpusClose(corpusLabel, corpusRun, corpusRun, separator)),
    'Control discovery rejects punctuation after the control, or its word boundary rejects a separator-less label; admission false and body leaks.');
}

// Whole-word label folding; no body classification should rescue or veto a key.
for (const [name, newline] of [
  ['lf', corpusLF], ['two-lf', corpusLF.repeat(2)], ['crlf', corpusCRLF],
  ['escaped-lf', corpusEscLF], ['escaped-crlf', corpusEscCRLF]
]) {
  const folded = corpusPrivate + newline + corpusKey;
  corpusYes('fold-long-' + name,
    corpusBlock(corpusOpen(folded), corpusClose(folded)),
    'PASS', 'A remaining whole PRIVATE word is sufficient for the current long-delimiter path.');
  const realWhitespace = name === 'lf' || name === 'two-lf' || name === 'crlf';
  corpusYes('fold-short-standalone-' + name,
    corpusBlock(corpusOpen(folded, corpusShort), corpusClose(folded, corpusShort)),
    realWhitespace ? 'PASS' : 'FAIL',
    realWhitespace
      ? 'Equal standalone short runs accept real whitespace in the bare label.'
      : 'Backslash-escaped label fails the bare-label test; body lookahead stops at the label fold, not the body. Admission false and body leaks.');
  for (const [variant, opener] of [
    ['glued', 'word' + corpusOpen(folded, corpusShort)],
    ['unequal', corpusOpen(folded, corpusShort, corpusDash.repeat(4))],
    ['truncated', corpusOpen(folded, corpusShort, '')]
  ]) corpusFail('fold-short-' + variant + '-' + name,
    corpusBlock(opener, null),
    'Short non-bare opener asks bodyAfterKey about the first break inside the label; the next label word is not a body line. Admission false and body leaks.');
}
corpusFail('fold-escaped-between-control-and-label',
  corpusBlock(corpusOpen(corpusLabel, corpusRun, corpusRun, corpusEscLF), null),
  'A literal backslash after the control is neither whitespace nor a dash.');
corpusFail('fold-intraword-both-label-words',
  corpusBlock(corpusOpen(corpusPrivate.slice(0, 3) + corpusLF + corpusPrivate.slice(3)
    + ' ' + corpusKey[0] + corpusLF + corpusKey.slice(1)), null),
  'Neither label keyword remains a whole word; ordinary whitespace collapsing does not repair split words.');
corpusFail('fold-intraword-control',
  corpusBlock(corpusRun + corpusBegin.slice(0, 2) + corpusLF + corpusBegin.slice(2)
    + ' ' + corpusLabel + corpusRun, null),
  'Control spelling itself crosses a line break.');

// Runtime-wide Unicode Dash_Punctuation coverage, plus non-Pd dash/minus forms.
// The runtime Unicode version determines any additional Pd members.
// Numeric code points prevent literal armor-shaped strings in this source.
const corpusNamedDashes = [
  [0x002d, 'hyphen-minus'], [0x058a, 'armenian'], [0x05be, 'maqaf'],
  [0x1400, 'canadian'], [0x1806, 'mongolian'], [0x2010, 'hyphen'],
  [0x2011, 'nonbreaking'], [0x2012, 'figure'], [0x2013, 'en'],
  [0x2014, 'em'], [0x2015, 'horizontal-bar'], [0x2053, 'swung'],
  [0x207b, 'superscript-minus'], [0x208b, 'subscript-minus'], [0x2212, 'minus'],
  [0x2e17, 'double-oblique'], [0x2e1a, 'diaeresis'], [0x2e3a, 'two-em'],
  [0x2e3b, 'three-em'], [0x2e40, 'double-hyphen'], [0x2e5d, 'oblique'],
  [0x301c, 'wave'], [0x3030, 'wavy'], [0x30a0, 'katakana-double'],
  [0xfe31, 'vertical-em'], [0xfe32, 'vertical-en'], [0xfe58, 'small-em'],
  [0xfe63, 'small-hyphen'], [0xff0d, 'fullwidth'], [0x10d6e, 'garay'],
  [0x10ead, 'yezidi'], [0x00ad, 'soft-hyphen'], [0x02d7, 'modifier-minus'],
  [0x2043, 'hyphen-bullet'], [0x2796, 'heavy-minus']
];
const corpusDashSet = new Map(corpusNamedDashes);
const corpusPd = /\p{Dash_Punctuation}/u;
for (let cp = 0; cp <= 0x10ffff; cp++) {
  if (cp >= 0xd800 && cp <= 0xdfff) continue;
  if (!corpusDashSet.has(cp) && corpusPd.test(String.fromCodePoint(cp)))
    corpusDashSet.set(cp, 'runtime-pd');
}
for (const [cp, name] of corpusDashSet) {
  const run = String.fromCodePoint(cp).repeat(5);
  const supported = cp === 0x2d || (cp >= 0x2010 && cp <= 0x2015) || cp === 0x2212;
  corpusYes('dash-u' + cp.toString(16).padStart(4, '0') + '-' + name,
    corpusBlock(corpusOpen(corpusLabel, run), corpusClose(corpusLabel, run)),
    supported ? 'PASS' : 'FAIL',
    supported
      ? 'Current ASCII or explicitly normalized dash is recognized.'
      : 'Current dash table never maps this code point to ASCII; admission false and body leaks.');
}
corpusYes('dash-mixed-supported',
  corpusBlock(corpusOpen(corpusLabel, [0x2d, 0x2013, 0x2014, 0x2011, 0x2212]
    .map(cp => String.fromCodePoint(cp)).join('')), null));
corpusFail('dash-mixed-unsupported-final',
  corpusBlock(corpusOpen(corpusLabel,
    [0x2d, 0x2013, 0x2014, 0x2011, 0xff0d].map(cp => String.fromCodePoint(cp)).join('')), null),
  'The unsupported final dash separates every ASCII/normalized run from the control.');

// Invisible characters inside control spelling, both label words, and runs.
for (const [name, cp] of [
  ['soft-hyphen', 0xad], ['zero-width-space', 0x200b],
  ['zero-width-joiner', 0x200d], ['zero-width-nonjoiner', 0x200c],
  ['bom', 0xfeff], ['word-joiner', 0x2060]
]) {
  const invisible = String.fromCodePoint(cp);
  const brokenControl = corpusBegin.slice(0, 2) + invisible + corpusBegin.slice(2);
  const brokenLabel = corpusPrivate.slice(0, 3) + invisible + corpusPrivate.slice(3)
    + ' ' + corpusKey[0] + invisible + corpusKey.slice(1);
  corpusFail('invisible-control-' + name,
    corpusBlock(corpusRun + brokenControl + ' ' + corpusLabel + corpusRun, null),
    'The control regex cannot match an intraword invisible.');
  corpusFail('invisible-both-label-words-' + name,
    corpusBlock(corpusOpen(brokenLabel), null),
    'Both whole-word label matches are broken; BOM is whitespace but still splits each word.');
  const brokenRun = (corpusDash + invisible).repeat(5);
  const current = cp === 0xfeff ? 'PASS' : 'FAIL';
  corpusYes('invisible-dash-run-' + name,
    corpusBlock(corpusOpen(corpusLabel, brokenRun), null),
    current, current === 'PASS'
      ? 'BOM is JavaScript whitespace: the last one-dash run plus a bare equal close recognizes the header.'
      : 'Each dash run is followed by a non-whitespace invisible before the control; admission false and body leaks.');
}
corpusYes('invisible-one-label-word-only',
  corpusBlock(corpusOpen(corpusPrivate.slice(0, 3) + String.fromCodePoint(0x200b)
    + corpusPrivate.slice(3) + ' ' + corpusKey), null),
  'PASS', 'The intact KEY word still triggers the current broad label rule.');
corpusYes('offset-nonbmp-prefix', 'before ' + String.fromCodePoint(0x1f41f) + corpusLF + corpusBlock(),
  'PASS', 'Existing normalization is length-preserving; also assert the prefix and AFTER_CORPUS survive.');
corpusFail('offset-normalization-removes-invisibles',
  'before ' + String.fromCodePoint(0x1f41f) + corpusLF
    + corpusBlock(corpusRun + corpusBegin.slice(0, 2) + String.fromCodePoint(0x200b)
      + corpusBegin.slice(2) + ' ' + corpusLabel + corpusRun),
  'Current admission fails. Future deletion-based normalization must map normalized spans back to original UTF-16 offsets.');

// Bodies, quoting, Markdown, and serialized representations.
corpusYes('body-same-line-long',
  corpusOpen() + ' ' + corpusBodyA + ' ' + corpusClose());
corpusFail('body-same-line-short-glued',
  'word' + corpusOpen(corpusLabel, corpusShort) + ' ' + corpusBodyA + corpusLF,
  'Short glued opener is not bare and there is no following body line.');
for (const prefix of ['> ', '// ', '# ']) {
  corpusYes('body-quoted-long-' + JSON.stringify(prefix),
    corpusBlock(corpusOpen(), corpusClose(), prefix + corpusBodyA + corpusLF + prefix + corpusBodyB));
  corpusYes('body-quoted-short-glued-' + JSON.stringify(prefix),
    corpusBlock('word' + corpusOpen(corpusLabel, corpusShort), null,
      prefix + corpusBodyA + corpusLF + prefix + corpusBodyB),
    prefix === '> ' ? 'PASS' : 'FAIL',
    prefix === '> '
      ? 'Current bodyLine accepts Markdown quote prefixes.'
      : 'Current bodyLine does not accept this comment prefix; admission false and both body sentinels leak.');
}
corpusYes('body-split-by-markdown-long',
  corpusBlock(corpusOpen(), corpusClose(),
    corpusBodyA + corpusLF + corpusFence + corpusLF + corpusBodyB));
corpusFail('body-code-fence-before-short-glued',
  corpusBlock('word' + corpusOpen(corpusLabel, corpusShort), null,
    corpusFence + corpusLF + corpusBodyA + corpusLF + corpusFence),
  'The first prospective body line is a fence, so the short fallback rejects it.');
corpusYes('container-code-fence',
  corpusFence + 'text' + corpusLF + corpusBlock() + corpusLF + corpusFence);
corpusYes('container-json-string', JSON.stringify({ keyText: corpusBlock() }));
corpusYes('container-json-string-short', JSON.stringify({ keyText:
  corpusBlock(corpusOpen(corpusLabel, corpusShort), null) }),
  'PASS', 'Escaped body-line breaks are supported when the label itself is not folded.');
corpusFail('container-json-escaped-fold-short',
  JSON.stringify({ keyText: corpusBlock(corpusOpen(corpusPrivate + corpusLF + corpusKey, corpusShort), null) }),
  'The serialized label fold defeats bare-label and first-line body fallback.');
corpusFail('container-double-json-short',
  JSON.stringify(JSON.stringify({ keyText: corpusBlock('word' + corpusOpen(corpusLabel, corpusShort), null) })),
  'Glued short header needs bodyLine; the double-escaped body terminator is not accepted by its single-escape boundary check.');
corpusFail('container-json-unicode-control',
  JSON.stringify({ keyText: corpusBlock() }).replaceAll(corpusBegin,
    [...corpusBegin].map(c => String.fromCharCode(92) + 'u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('')),
  'Raw serialized Unicode escapes hide the opening control; decoding JSON values first is a separate requirement.');
corpusFail('control-greek-i-confusable',
  corpusBlock(corpusRun + corpusBegin.slice(0, 3) + String.fromCodePoint(0x399)
    + corpusBegin.slice(4) + ' ' + corpusLabel + corpusRun, null),
  'Greek capital iota is not ASCII I and NFKC alone does not equate them.');
corpusYes('window-long-gap-before-label',
  corpusBlock(corpusOpen(corpusLabel, corpusRun, corpusRun, ' '.repeat(8192)), null),
  'PASS', 'Current scan has no label-window cap. A future window below 8192 code units needs an explicit overflow policy.');

// At least 15 unchanged-prose controls, deliberately close to the grammar.
corpusNo('prose-key-idea', 'We begin with a key idea and end the discussion.');
corpusNo('prose-private-key-explanation', 'A private key should never be shared.');
corpusNo('prose-begin-end-words', corpusBegin + ' and ' + corpusEnd + ' name transaction boundaries.');
corpusNo('prose-label-only', 'The label ' + corpusLabel + ' appears in documentation.');
corpusNo('prose-keyboard', 'The keyboard sends keys to the application.');
corpusNo('prose-front-end', 'The front' + corpusDash + 'end private API is documented.');
corpusNo('prose-back-end', 'Back' + corpusDash + 'end key rotation happens nightly.');
corpusNo('prose-markdown-end-bullet',
  corpusDash + ' ' + corpusEnd + ' one: review the private API.' + corpusLF
    + corpusDash + ' Next key item.');
corpusNo('prose-page-range', 'Read pages 3' + String.fromCodePoint(0x2013) + '5.');
corpusNo('prose-em-dash', 'A pause ' + String.fromCodePoint(0x2014) + ' then continue.');
corpusNo('prose-minus', 'The result is 7 ' + String.fromCodePoint(0x2212) + ' 2.');
corpusNo('prose-dashes-only', corpusDash.repeat(24));
corpusNo('prose-begin-banner-only', corpusRun + corpusBegin + corpusRun);
corpusNo('prose-end-banner-only', corpusRun + corpusEnd + corpusRun);
corpusNo('prose-chapter-banner',
  corpusMarker(corpusBegin, 'CHAPTER') + corpusLF + 'Ordinary text.'
    + corpusLF + corpusMarker(corpusEnd, 'CHAPTER'));
corpusNo('prose-key-after-closed-chapter-banner',
  corpusMarker(corpusBegin, 'CHAPTER') + corpusLF + 'This private key is discussed, not included.'
    + corpusLF + corpusMarker(corpusEnd, 'CHAPTER'),
  'A closed non-key banner must terminate label lookahead before subsequent key-related prose; current scanner preserves it.');
corpusNo('prose-keynote-banner', corpusMarker(corpusBegin, 'KEY' + 'NOTE ADDRESS') + corpusLF + 'Welcome.');
corpusNo('prose-monkey-business', corpusMarker(corpusBegin, 'MON' + 'KEY BUSINESS') + corpusLF + 'A story.');
corpusNo('prose-privately-owned', corpusMarker(corpusBegin, 'PRIV' + 'ATELY OWNED') + corpusLF + 'A story.');
corpusNo('prose-json-documentation',
  JSON.stringify({ text: 'Use BEGIN and END in SQL; keep keys private.' }));
corpusNo('prose-code-fenced-explanation',
  corpusFence + corpusLF + 'A key idea begins here and ends there.' + corpusLF + corpusFence);
corpusNo('prose-no-marker-private-words',
  corpusPrivate + corpusLF + corpusKey + corpusLF + 'These are vocabulary words, without an opening marker.');

// This exported array is the deliverable. Import or paste it into the test file.
export const armorEvasionCases = Object.freeze(corpusCases.map(Object.freeze));
export default armorEvasionCases;
