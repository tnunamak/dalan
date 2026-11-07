// The parser recognizes this block's T3 signature; the harness name and request text are synthetic.
const runtimeInfo = "<runtime_info>In case you're asked: you are running in T3 Code through the synthetic harness. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>";
const linkingStart = 'When the t3-code MCP server exposes link_pull_request, you must use it to register every pull request ';
const linkingEnd = 'call unwatch_pull_request first so the thread returns to their inbox.';
const filler = n => 'Synthetic instruction filler sentence. '.repeat(Math.ceil(n / 38)).slice(0, n);
export const runtimeBlock = `${runtimeInfo}\n\n<pull_request_linking>\n${linkingStart}in this synthetic example. ${linkingEnd}\n</pull_request_linking>`;
export const envelope = text => `<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions and carrying out the user's request.\n</t3_code_instructions>\n\n<user_request>\n${text}\n</user_request>`;
// Synthetic delegate prompt with instruction, user, and trailing runtime sections. Filler text gives
// the parser a large envelope while keeping the fixture independent of any real prompt or measurement.
export const t3Instructions = `<t3_code_instructions>\n## T3 Code interaction mode: Synthetic\n\n${filler(256)}\n\n## Collaborative review\n\n${filler(2048)}\n\n## Repository workflow\n\n${filler(8192)}\n</t3_code_instructions>`;
export const t3TrailingBlocks = `${runtimeInfo}\n\n<pull_request_linking>\n${linkingStart}${filler(1024)} ${linkingEnd}\n</pull_request_linking>`;
export const delegatePrompt = task => `${t3Instructions}\n\n<user_request>\n${task}\n</user_request>\n${t3TrailingBlocks}`;
