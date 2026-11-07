import { maskText } from './redaction.mjs';

// The one place text from a child process or a remote response becomes a diagnostic.
// Order matters: redact the whole text first, then clip, so a secret that straddles the
// clip point cannot leave a recognizable prefix.
export function safeDiagnostic(text, max = 300) {
  const stripped = String(text ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  const redacted = maskText(stripped)
    // A parser or a clip can cut a token short; a recognizable prefix is still a leak.
    .replace(/\b(?:gh[pousr]_|github_pat_|xox[abposr]-|xoxe-|AKIA|sk-|sk_live_|sk_test_|sk_|glpat-|npm_|whsec_|GOCSPX-|ya29\.)[A-Za-z0-9_-]{4,}/g, '[redacted secret]');
  return redacted.length > max ? redacted.slice(0, max) + '…[truncated]' : redacted;
}

// A plain Error, or a Dalan subclass, carries a message written for the caller. A built-in subclass (SyntaxError,
// TypeError and the like), a Node system error or a non-Error throw is a crash: its text can quote data, so callers show
// only the tool name and an error id and keep the detail in a local log (Python MCP SDK pattern).
const builtinErrors = [EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError, AggregateError];
export function isCrash(error) {
  if (!(error instanceof Error)) return true;
  if (error.errno !== undefined || error.syscall !== undefined) return true;
  if (typeof error.code === 'string' && /^(?:E[A-Z0-9]+|ERR_[A-Z0-9_]+)$/.test(error.code)) return true;
  return builtinErrors.some(type => error instanceof type);
}

// Child output relayed as it arrives: mask whole lines only, holding a partial line back until it completes or the
// stream ends, so a secret split across chunks is masked as one (Jenkins line-based masking, Buildkite partial matches).
// Lines from an armor header to its footer, and runs of full-width base64 lines (a PEM body without a header), are held
// and masked as one block, so multiline key material is never judged one line at a time.
const armorHeader = /-----BEGIN [A-Z0-9 ]*-----|^\s*BEGIN [A-Z0-9 ]*PRIVATE KEY\s*$/;
const armorFooter = /-----END [A-Z0-9 ]*-----|^\s*END [A-Z0-9 ]*PRIVATE KEY\s*$/;
const bodyLine = line => /^\s*[A-Za-z0-9+/]{64}\s*$|^\s*[A-Za-z0-9+/]{76}\s*$/.test(line);
export function createLineMasker(write, max = 16384) {
  let held = '', block = [], armored = false;
  const flush = () => {
    if (!block.length) return;
    const text = block.join('\n');
    write(`${text.length > max ? '[redacted secret]' : safeDiagnostic(text, max)}\n`);
    block = []; armored = false;
  };
  return (chunk, final = false) => {
    const lines = (held + chunk).split('\n');
    held = final ? '' : lines.pop();
    if (final && lines.at(-1) === '') lines.pop();
    const out = [];
    for (const line of lines) {
      if (armored || armorHeader.test(line)) {
        if (!armored && out.length) { write(out.map(text => safeDiagnostic(text, max)).join('\n') + '\n'); out.length = 0; }
        if (!armored) flush();
        armored = true; block.push(line);
        if (armorFooter.test(line)) flush();
        // An unterminated block cannot grow without bound: mask what is held and stay inside the block.
        else if (block.reduce((n, text) => n + text.length + 1, 0) > max) { write('[redacted secret]\n'); block = []; }
      } else if (bodyLine(line)) {
        if (out.length) { write(out.map(text => safeDiagnostic(text, max)).join('\n') + '\n'); out.length = 0; }
        block.push(line);
      } else if (block.length && /^\s*[A-Za-z0-9+/]+={0,2}\s*$/.test(line)) {
        // The short last line of a PEM body ends the block and belongs to it.
        block.push(line);
        flush();
      } else if (block.length && armorFooter.test(line)) {
        // A footer after a header-less body gives the held lines their context: mask them with it.
        block.push(line);
        flush();
      } else {
        flush();
        out.push(line);
      }
    }
    if (out.length) write(out.map(line => safeDiagnostic(line, max)).join('\n') + '\n');
    if (final) flush();
  };
}

// Parse a response or child-process body. A SyntaxError message quotes the start of the body, cut by the parser
// at a point that defeats redaction, so a failure reports only the label and never the parser's excerpt.
export function parseJsonBody(text, label = 'response') {
  try { return JSON.parse(text); } catch { throw new Error(`${label} is not valid JSON`); }
}
