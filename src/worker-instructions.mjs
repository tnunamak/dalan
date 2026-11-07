import fs from 'node:fs';
import path from 'node:path';

// Guidance for a worker client that loads instruction files, such as opencode's "instructions" list.
// opencode's own prompt suggests an `execute` tool that the opencode worker recipe denies (it runs code that can
// reach the network); a model that follows the suggestion writes the call as text and stops. This text prevents that.
// `dalan try` and the service setup both write it next to resource-url, so one recipe path works for both.
export const WORKER_INSTRUCTIONS = `# Dalan worker

You work for a Dalan bridge. Its tools are MCP tools such as \`list_pending\`, \`get\`, \`claim\`, \`progress\` and \`finish\`. Your client may show them with the server's name in front, such as \`local_claim\`.

- Call tools only as structured tool calls. Never write a tool call as text.
- There is no \`execute\` tool for this worker. Call every tool directly.
- If no Dalan tool is in your tool list yet, call \`opencode_list_mcp_resources\` once; the Dalan tools are then available.
`;

export const WORKER_INSTRUCTIONS_FILE = 'worker-instructions.md';

// Writes the guidance into a bridge home (mode 0600), replacing an older copy.
export function writeWorkerInstructions(home) {
  const file = path.join(home, WORKER_INSTRUCTIONS_FILE);
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, WORKER_INSTRUCTIONS, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}
