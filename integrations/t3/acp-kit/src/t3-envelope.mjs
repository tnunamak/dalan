// What T3 Code puts around a user's text in session/prompt, and the identity token an adapter's caller puts first.
export const CONTINUE_PROMPT = 'Continue where you left off.'; // T3's restart continuation prompt (RestartContinuation.ts)

// T3's instruction envelope occurs at the start of the first text block:
//   <t3_code_instructions>...</t3_code_instructions>\n\n<user_request>\n<the user's text>\n</user_request>
// optionally followed by T3's own trailing blocks (<runtime_info>, <pull_request_linking>), which may sit in the same text
// when T3 sends one block, or when isT3RuntimeBlock does not recognise a changed copy of them. Anchor at the start, and cut
// the end only at a </user_request> that is followed by nothing but those known blocks, so tags the user wrote inside the
// brief never select a different request root. Follow-ups are bare text. Without the envelope the text is returned as is;
// without <user_request> only the instruction block and the trailing T3 blocks are dropped. Unknown tags are kept.
// Keep the user request separate from generated runtime instructions to preserve the task context budget.
const INSTRUCTIONS = /^<t3_code_instructions>\n## T3 Code interaction mode: [^\n]*\n[\s\S]*?\n<\/t3_code_instructions>\n+/;
const TRAILING_T3_BLOCKS = /^(?:\s*<(runtime_info|pull_request_linking)>[\s\S]*?<\/\1>)*\s*$/;
const CLOSE = '</user_request>';
export function unwrapUserRequest(prompt) {
  const head = INSTRUCTIONS.exec(prompt);
  if (!head) return prompt;
  const rest = prompt.slice(head[0].length);
  const open = '<user_request>\n';
  if (!rest.startsWith(open)) return stripTrailingT3Blocks(rest);
  const body = rest.slice(open.length);
  for (let at = body.lastIndexOf(CLOSE); at > 0; at = body.lastIndexOf(CLOSE, at - 1)) {
    if (body[at - 1] === '\n' && TRAILING_T3_BLOCKS.test(body.slice(at + CLOSE.length))) return body.slice(0, at - 1);
  }
  return stripTrailingT3Blocks(body); // the closing tag is missing
}
function stripTrailingT3Blocks(text) {
  for (let at = text.search(/<(?:runtime_info|pull_request_linking)>/); at >= 0;) {
    if (TRAILING_T3_BLOCKS.test(text.slice(at))) return text.slice(0, at).replace(/\s+$/, '');
    const next = text.slice(at + 1).search(/<(?:runtime_info|pull_request_linking)>/);
    at = next < 0 ? -1 : at + 1 + next;
  }
  return text;
}

// runtimeInstructions.ts supplies this as a separate final text block, not part of the user's text. Check its generated
// shape and recognizable copy before dropping it; never cut at an embedded tag.
export function isT3RuntimeBlock(text) {
  return /^<runtime_info>In case you're asked: you are running in T3 Code through the [^<>\n]+ harness[^<>\n]*\. No need to mention this otherwise\. You can embed images and videos in your response using Markdown with absolute file paths\.<\/runtime_info>\n\n<pull_request_linking>\nWhen the t3-code MCP server exposes link_pull_request, you must use it to register every pull request [\s\S]+call unwatch_pull_request first so the thread returns to their inbox\.\n<\/pull_request_linking>$/.test(text);
}

// The user's text from a prompt's content blocks. One user block is never discarded, even if it looks like the runtime block.
export function promptText(blocks) {
  const texts = blocks.filter(b => b.type === 'text').map(b => b.text);
  if (texts.length > 1 && isT3RuntimeBlock(texts.at(-1))) texts.pop();
  return unwrapUserRequest(texts.join('\n'));
}

// T3's delegate_task puts this before the task for every role except general (and none).
const rolePreamble = /^Act as the (?:implementation|research|review|design|test) sub-agent for this task\.\n\n/;
export const stripRolePreamble = text => text.replace(rolePreamble, '');

// Identity from a first line `[<prefix>:<id>]`. `prefix` is the adapter's tag (`dot-decision`, `example-request`); `idPattern`
// decides which ids are valid (an invalid id gives id null; the token line is still removed from `brief`).
// Returns { id, text, brief }: `text` is the input after the leading blank line and role preamble (hash this when there is
// no token); `brief` is `text` without the token line, trimmed.
export function parseIdentity(input, { prefix, idPattern = /^[-\w]{8,128}$/ }) {
  if (!/^[\w-]+$/.test(prefix)) throw new Error('prefix must be word characters and hyphens');
  const text = stripRolePreamble(input.replace(/^\s*\n/, ''));
  const m = new RegExp(`^\\[${prefix}:([^\\]\\s]+)\\][ \\t]*(?:\\r?\\n|$)`).exec(text);
  return { id: m && idPattern.test(m[1]) ? m[1] : null, text, brief: (m ? text.slice(m[0].length) : text).trim() };
}
