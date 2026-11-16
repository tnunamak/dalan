// Text that a worker or a job supplied must not drive the operator's terminal. An ESC, BEL or C1 byte can retitle the
// window, forge earlier lines or replace the clipboard (OSC 52). Escape bidi embeddings/overrides, isolates and marks,
// zero-width space, BOM and lone surrogates too: they can hide or reorder displayed text. Preserve ZWNJ for Persian
// and ZWJ for emoji sequences. Unicode-mode matching preserves valid surrogate pairs (astral characters).
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200e\u200f\u200b\ufeff\ud800-\udfff]/gu;
const escapeChar = c => {
  const code = c.codePointAt(0);
  return code <= 0xff ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`;
};

// Human output: keep \n and \t; spell unsafe characters as \xNN or \uNNNN so they show and do nothing.
export function terminalSafe(text) { return String(text).replace(CONTROL, escapeChar); }

// Machine JSON output: JSON.stringify escapes C0 and lone surrogates; other unsafe characters can stay raw.
// Spell raw unsafe characters as \uNNNN, which parses back to the same string.
export function jsonTerminalSafe(jsonText) {
  return String(jsonText).replace(/[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200e\u200f\u200b\ufeff\ud800-\udfff]/gu, c => `\\u${c.codePointAt(0).toString(16).padStart(4, '0')}`);
}

// One-line fields (inbox rows): newline and tab are spelled out too, so a field cannot start a forged line.
export function terminalSafeLine(text) { return String(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200e\u200f\u200b\ufeff\ud800-\udfff]/gu, escapeChar); }
