// Text that a worker or a job supplied must not drive the operator's terminal. An ESC, BEL or C1 byte can retitle the
// window, forge earlier lines or replace the clipboard (OSC 52). This is the one place that makes such text printable.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/gu;
const escapeChar = c => {
  const code = c.codePointAt(0);
  return code <= 0xff ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`;
};

// Human output: keep \n and \t, spell every other control character as \xNN so it shows and does nothing.
export function terminalSafe(text) { return String(text).replace(CONTROL, escapeChar); }

// Machine JSON output: JSON.stringify already escapes C0 controls; DEL and C1 stay raw. Spell those as \uNNNN, which
// parses back to the same string.
export function jsonTerminalSafe(jsonText) {
  return String(jsonText).replace(/[\u007f-\u009f\u2028\u2029]/gu, c => `\\u${c.codePointAt(0).toString(16).padStart(4, '0')}`);
}

// One-line fields (inbox rows): newline and tab are spelled out too, so a field cannot start a forged line.
export function terminalSafeLine(text) { return String(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, escapeChar); }
