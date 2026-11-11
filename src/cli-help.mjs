// Help text and command lookup for the `dalan` CLI. Its only I/O is reading the package version for docs links, so `bin/dalan.mjs` can answer help
// requests before it loads the rest of the CLI.
import { docsUrl } from './docs-url.mjs';

// Order matters: it is the order of the help screens. `group` is where a command shows on the short screen;
// commands without a group only appear under `dalan help --all`, and internal maintenance commands only under
// `dalan help --internal`. Every command runs and has its own help either way.
export const COMMANDS = [
  { name: 'try', group: 'start', summary: 'Try Dalan with ChatGPT or claude.ai, or on this computer only', usage: 'dalan try [--local | --public [--client chatgpt|claude] [--route auto|tailscale|cloudflare]] [--home DIR] [--port N] [--callback PATTERN]...',
    detail: ['In an interactive terminal, asks where your worker runs. Choose ChatGPT or claude.ai (the default): it opens a temporary public HTTPS route (a ready Tailscale Funnel,',
      'else, for ChatGPT only, a Cloudflare Quick Tunnel through a checksum-verified helper; claude.ai needs Tailscale, because a quick tunnel answers it with 403), prints the connector URL and the clicks to add it, asks you to approve the sign-in,',
      'and confirms that the hosted client finished a demo job. Ctrl-C stops the trial and removes the route. Choose this computer only, or pass --local, for a',
      'self-check with a built-in demo worker; then connect a local client. With no terminal (dalan try < /dev/null) it runs the local self-check and never opens a route.', '',
      'Options:', '  --local             this computer only', '  --public            ChatGPT or claude.ai through a public route', '  --client NAME       chatgpt (default) or claude; implies --public',
      '  --route NAME        auto (default), tailscale or cloudflare; implies --public', '  --home DIR          trial home (default: DALAN_HOME if set, else ~/.local/share/dalan-trial)',
      '  --port N            bridge port (default: the home\'s previous port, else 8799 or the next free port)', '  --callback PATTERN  local mode only: allow one more OAuth callback pattern; repeatable', '',
      'Example: dalan try', 'A public trial gets a new home on every run unless you pass --home; --port is always the bridge port on this computer, never the public port.', `In local mode, connect your own worker and review its first result: ${docsUrl('README.md', 'connect-your-own-worker')}`] },
  { name: 'init', group: 'start', summary: 'Create a bridge home and its first worker profile', usage: 'dalan init --public-url URL (--worker NAME | --legacy) [--json]',
    detail: ['Writes the built-in authorization server files and the first worker profile into the bridge home (DALAN_HOME).', 'It needs no running bridge.', '',
      'Options:', '  --public-url URL  the address clients will use to reach the bridge: https://HOST, or',
      '                    http://127.0.0.1:PORT when DALAN_LOOPBACK=1 is set', '  --worker NAME     create the first worker profile with this name', '  --legacy          keep the settings of an older single-worker host instead of creating a profile', '  --json            print the result as JSON', '',
      'Example (a bridge on this computer only):', '  export DALAN_HOME="$HOME/.local/share/dalan-manual-trial"', '  export DALAN_LOOPBACK=1', '  dalan init --worker local --public-url http://127.0.0.1:8799'] },
  { name: 'connect', group: 'start', summary: 'Pair a worker client with the bridge', usage: 'dalan connect <subcommand> [options]',
    detail: ['Subcommands:', '  start --worker NAME [--minutes N]   open a pairing window for a worker', '  pending [--json]                    show connection attempts waiting for approval',
      '  approve CODE --worker NAME          approve only the attempt with this code', '      [--confirm-redirect URI]        required for a native client: the redirect you expect', '      [--replace]                     replace an existing connection for the worker',
      '  list [--json]                       show connected workers', '  revoke NAME                         disconnect a worker', '  stop                                close the pairing window', '  reset                               clear pairing state',
      '  add-client --redirect-uri URI [--name NAME] [--json]   register an OAuth client', '  clients [--json]                    list OAuth clients', '  remove-client CLIENT_ID [--json]    remove an OAuth client',
      '  allow-callback PATTERN              allow another OAuth callback pattern', '  signal-token [--worker NAME] [--rotate] [--json]       show or rotate a worker signal token', '',
      'Examples (pair a worker named local):', '  dalan connect start --worker local', '  dalan connect pending', '  dalan connect approve CODE --worker local --confirm-redirect URI',
      'Replace CODE with the code that pending and the browser page both show, and URI with the', 'redirect that pending shows.'] },
  { name: 'submit', group: 'everyday', summary: 'Queue a job for a worker', usage: 'dalan submit (--file PATH | --stdin | --brief TEXT) [options]',
    detail: ['Queues a job. Give it a JSON assignment (request_id, inputs, brief, ...) or, with --brief, plain text for a question that needs no files.', 'Prints the request ID.', '',
      'Options:', '  --file PATH | --stdin | --brief TEXT', '                            where the job comes from (exactly one). --brief makes a read-only job with', '                            no repository from TEXT, used exactly as typed', '  --worker NAME             queue for a named worker (default: the profile\'s only worker;', '                            required when the profile has several)',
      '  --thread ID               deliver the result to a T3 Code thread (optional integration)', '  --deliver none|t3:ID      delivery target (default: none; not with --thread)', '  --review                  ask for a review of work already done',
      '  --wait                    wait for the result before returning', '  --timeout S               with --wait: seconds to wait, 1 to 3600 (default: 300)', '  --dry-run                 check the assignment and store nothing',
      '  --queue-anyway            queue even when the bridge would defer or warn', '  --refuse-defer            fail instead of deferring',
      '  --allow-scope-prune       when submit rejects the brief for naming files outside scope_paths, let it fix scope_paths and retry once',
      '  --execution none|worker|host   execution capability for the job (default: the profile\'s default_execution, none for a new profile)',
      '  --require-capability LIST      comma-separated backend capabilities the job needs (default: none)', '  --json                    print JSON', '',
      'Examples (the first job):',
      '  dalan submit --worker local --execution none --deliver none --file first-job.json --json', '  dalan wait REQUEST_ID', '  dalan get REQUEST_ID', '  dalan decide REQUEST_ID accepted',
      '', 'Example (a question that needs no files):', '  dalan submit --worker local --brief "What does a database index do?"', '',
      'Replace REQUEST_ID with the request_id that submit prints. Read the report before you accept it.', `first-job.json and the full walk-through: ${docsUrl('docs/manual-setup.md', 'submit-finish-and-read-the-result')}`] },
  { name: 'status', group: 'everyday', summary: 'Show the bridge, queue and worker state', usage: 'dalan status [--explain] [--json]',
    detail: ['Prints the bridge state.', '', 'Options:', '  --explain  describe the state and recent metrics in plain words', '  --json     print JSON', '', 'Example: dalan status, then dalan inbox --all'] },
  { name: 'get', group: 'everyday', summary: 'Show one job (or message) by ID', usage: 'dalan get ID [--json]',
    detail: ['Prints the job\'s state, progress, report and artifacts, and marks a finished result as read.', 'On a terminal it prints a short view; piped, or with --json, it prints the full JSON record.', '', 'Example: dalan get REQUEST_ID'] },
  { name: 'wait', group: 'everyday', summary: 'Wait for a job to finish', usage: 'dalan wait ID [--timeout S] | wait --drained --producer-thread ID [--max-claimed N] [--max-queued N] [--timeout S]',
    detail: ['Waits until job ID reaches a final state, or until the timeout. With --drained, waits until your queue has drained.', '',
      'Options:', '  --timeout S  seconds to wait: 1 to 3600 for a job (default: 300); 1 to 86400 with --drained (default: 1740)', '',
      '--drained needs --producer-thread ID unless the command runs inside a Claude Code or Codex session, which supplies it.', '',
      'Exit status for a job: 0 finished, 3 blocker or question, 4 cancelled, 5 the worker is on a usage break, 124 timeout (the job is still open), 1 error.', '', 'Example: dalan wait REQUEST_ID --timeout 3600, then dalan get REQUEST_ID.', 'Exit 124 leaves the job open; inspect it with dalan get before waiting again.'] },
  { name: 'inbox', group: 'everyday', summary: 'List jobs and messages that need you', usage: 'dalan inbox [--all | --producer ID] [--since RFC3339] [--json] | dalan inbox --mark-read [ID...] [--before RFC3339]',
    detail: ['Lists what needs you. A producer is the shell or agent session that submitted the job. Inside a Claude Code or Codex session, plain dalan inbox lists that session\'s jobs.', 'Outside a Claude Code or Codex session, plain dalan inbox lists every producer\'s jobs on this bridge home.', '--all lists every producer anywhere; --producer ID lists one.', '', 'Options:', '  --since, --before  an RFC3339 time or a duration such as 72h or 3d', '', 'Default window: jobs updated in the last 72 hours. Questions are always listed. To see older results: dalan inbox --all --since all', '', 'Example: dalan inbox --all, then dalan get REQUEST_ID'] },
  { name: 'decide', group: 'everyday', summary: 'Record your decision on a finished job', usage: 'dalan decide ID WORD [--note TEXT]',
    detail: ['Records your decision on a finished job. Review the report or patch first.', '', 'WORD is one of: accepted, applied, useful_no_change, useful_negative, not_useful.', 'Example: dalan decide REQUEST_ID accepted'] },
  { name: 'apply', group: 'everyday', summary: 'Apply a finished job\'s patch to a directory', usage: 'dalan apply ID [--dir PATH]',
    detail: ['Applies the patch from a finished job to a directory (default: the current directory) and records the decision "applied" for you.', 'There is no need to accept the job first.'] },
  { name: 'mcp', group: 'everyday', summary: 'Serve submit, wait, result and status as local MCP tools over stdio', usage: 'dalan mcp',
    detail: ['Runs a local MCP server on standard input and output for an agent on this computer (Claude Code, Codex).', 'Tools: dalan_submit, dalan_wait, dalan_result, dalan_status. They run the same CLI commands, with the same access to the admin socket.', 'Only protocol messages go to standard output; logs go to standard error. See docs/local-agent-mcp.md.'] },
  { name: 'worker', group: 'operator', summary: 'Choose which repositories a worker may use', usage: 'dalan worker allow|deny NAME OWNER/REPO [--json] | worker list [NAME] [--json] | worker migrate-repos [--json]',
    detail: ['Subcommands:', '  allow NAME OWNER/REPO   let a worker use a repository', '  deny NAME OWNER/REPO    stop a worker using it', '  list [NAME]             show each worker\'s repository access', '  migrate-repos           convert an old repository policy; stop the service first'] },
  { name: 'tool', group: 'operator', summary: 'Register tools and choose which workers may call them', usage: 'dalan tool add --file PATH | remove NAME | list | grant NAME WORKER | revoke NAME WORKER [--json]',
    detail: ['Manages the owner-side tool registry. A worker sees and calls only the tools granted to it. Changing the registry never changes the advertised MCP tool list.', '', 'Subcommands:', '  add --file PATH         register a tool from a JSON file: name, description, class (read|write), inputSchema, handler', '  remove NAME             remove a tool and its grants', '  list                    show tools, classes, schema hashes and granted workers', '  grant NAME WORKER       let a worker call a tool', '  revoke NAME WORKER      stop a worker calling a tool'] },
  { name: 'doctor', group: 'operator', summary: 'Check the host setup', usage: 'dalan doctor [--checks] [--json]',
    detail: ['Reports whether this host can run jobs.', '', 'Options:', '  --checks  lint the owner\'s checks.json instead (local only)', '  --json    print JSON'] },
  { name: 'paths', group: 'operator', summary: 'Print where Dalan keeps its files', usage: 'dalan paths [--json | --workspace-root | --config-root | --data-root | --state-root]' },
  { name: 'pause', group: 'operator', summary: 'Stop handing out new jobs', usage: 'dalan pause --reason TEXT' },
  { name: 'resume', group: 'operator', summary: 'Resume handing out jobs', usage: 'dalan resume' },
  // Reachable, but not on the first screen.
  { name: 'artifact', summary: 'Download a job artifact', usage: 'dalan artifact ID --output PATH' },
  { name: 'cancel', summary: 'Cancel a job', usage: 'dalan cancel ID [--reason TEXT]' },
  { name: 'cancel-if-queued', summary: 'Cancel a job only if it has not started', usage: 'dalan cancel-if-queued ID' },
  { name: 'accept', summary: 'same as: dalan decide REQUEST_ID accepted', usage: 'dalan accept ID [--note TEXT]' },
  { name: 'reject', summary: 'same as: dalan decide REQUEST_ID not_useful', usage: 'dalan reject ID [--note TEXT]' },
  { name: 'note', summary: 'Add a note to a job', usage: 'dalan note ID TEXT [--json]' },
  { name: 'questions', summary: 'List a job\'s open worker questions', usage: 'dalan questions ID [--json]' },
  { name: 'answer', summary: 'Answer a worker question', usage: 'dalan answer ID QUESTION_ID TEXT [--json]' },
  { name: 'tell', summary: 'Send a message to workers', usage: 'dalan tell [--worker NAME] TEXT [--json]' },
  { name: 'untell', summary: 'Withdraw a message', usage: 'dalan untell MESSAGE_ID [--worker NAME] [--json]' },
  { name: 'audit', summary: 'Show the audit trail', usage: 'dalan audit [--since RFC3339]' },
  { name: 'claims', summary: 'List active worker claims', usage: 'dalan claims [--json]' },
  { name: 'abandon', summary: 'Release a stuck claim', usage: 'dalan abandon ID [--reason TEXT]' },
  { name: 'reconcile', internal: true, summary: 'Reconcile one job record with the bridge', usage: 'dalan reconcile ID [--adopt]' },
  { name: 'verify-stops', internal: true, summary: 'Re-check host stop evidence for a job whose claim reports claim_effects_unverified', usage: 'dalan verify-stops [ID] [--json]' },
  { name: 'integrate', summary: 'Mark a job as integrated', usage: 'dalan integrate ID [--reason TEXT]' },
  { name: 'metrics', summary: 'Show bridge metrics', usage: 'dalan metrics [--since RFC3339] [--json]' },
  { name: 'rejections', summary: 'Summarize rejected jobs', usage: 'dalan rejections [--since RFC3339] [--json]' },
  { name: 'backfill-objectives', internal: true, summary: 'Backfill objective records', usage: 'dalan backfill-objectives [--dry-run] [--json]' },
  { name: 'break', summary: 'Record or clear a capacity break', usage: 'dalan break --reason TEXT [--since RFC3339] | dalan break --clear' },
  { name: 'breaks', summary: 'List capacity breaks', usage: 'dalan breaks [--json]' },
  { name: 'learned', summary: 'Show or clear learned limits', usage: 'dalan learned [--clear] [--json]' },
  { name: 'break-usage-backfill', internal: true, summary: 'Backfill usage for a capacity break', usage: 'dalan break-usage-backfill --id N [--log PATH] [--json]' },
  { name: 'as-init', internal: true, summary: 'Create built-in authorization server files (older form of init)', usage: 'dalan as-init --public-url https://HOST [--json]' },
  { name: 'as-rotate-keys', summary: 'Rotate the authorization server keys', usage: 'dalan as-rotate-keys [--jwks-only|--cookies-only] [--json]  (stop the bridge first)' },
  { name: 'prepare-deps', internal: true, summary: 'Prepare dependencies for a source directory', usage: 'dalan prepare-deps SOURCE_DIRECTORY [--json] [--replace-invalid]' },
];

const GROUPS = [['start', 'Getting started'], ['everyday', 'Everyday'], ['operator', 'Operator']];
const find = name => COMMANDS.find(c => c.name === name);
const section = (title, rows) => [`${title}:`, ...rows.map(c => `  ${c.name.padEnd(10)} ${c.summary}`)];

export function shortHelp() {
  return ['Dalan: hand bounded jobs to a worker agent, follow their progress and review the results.', '',
    'Usage: dalan <command> [options]', '',
    ...GROUPS.flatMap(([key, title]) => [...section(title, COMMANDS.filter(c => c.group === key)), '']),
    'Environment:', '  DALAN_HOME   bridge home that commands use; for the trial: export DALAN_HOME=~/.local/share/dalan-trial', '',
    'Start here:  dalan try',
    'Details:     dalan <command> --help', 'More:        dalan help --all', 'Version:     dalan --version', ''].join('\n').trimEnd();
}

const width = Math.max(...COMMANDS.map(c => c.name.length)) + 2;
const rows = commands => commands.map(c => `  ${c.name.padEnd(width)}${c.summary}`);

export function fullHelp() {
  return [shortHelp(), '', 'Other commands:', ...rows(COMMANDS.filter(c => !c.group && !c.internal)), '',
    'Internal maintenance commands: dalan help --internal'].join('\n');
}

export function internalHelp() {
  return ['Internal maintenance commands. Operators run these for recovery or upgrades; a normal setup does not need them.', '',
    ...rows(COMMANDS.filter(c => c.internal)), '', 'Details: dalan <command> --help'].join('\n');
}

export function commandHelp(name) {
  const c = find(name);
  if (!c) return null;
  return [`${c.summary}.`, '', `Usage: ${c.usage}`, ...(c.detail ? ['', ...c.detail] : []), '', 'Other commands: dalan help --all. Internal maintenance commands: dalan help --internal.'].join('\n');
}

function distance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

export function suggest(name) {
  const scored = COMMANDS.map(c => ({ name: c.name, d: c.name.startsWith(name) && name.length >= 2 ? 1 : distance(name, c.name) }));
  const best = scored.sort((a, b) => a.d - b.d)[0];
  return best && best.d <= Math.max(1, Math.min(2, Math.floor(name.length / 3))) ? best.name : null;
}

const FREE_TEXT = new Set(['note', 'answer', 'tell']);
// Free-text commands keep rejecting option-like words (`tell --help` is an error); `dalan help tell` shows their usage.
const wantsHelp = (command, rest) => !FREE_TEXT.has(command) && (rest[0] === '-h' || rest.includes('--help'));

// Decide whether argv (after the node and script names) is a help request or an unknown command.
// Returns null when the command should run normally; otherwise { stream, code, text }.
export function resolveHelp(argv) {
  const [command, ...rest] = argv;
  if (command === undefined) return { stream: 'stdout', code: 0, text: shortHelp() };
  if (command === '--help' || command === '-h') return { stream: 'stdout', code: 0, text: shortHelp() };
  if (command === 'help') {
    const topic = rest.find(a => !a.startsWith('-'));
    if (topic) {
      const text = commandHelp(topic);
      if (!text) return unknown(topic, rest.includes('--json'));
      return { stream: 'stdout', code: 0, text };
    }
    return { stream: 'stdout', code: 0, text: rest.includes('--internal') ? internalHelp() : rest.includes('--all') ? fullHelp() : shortHelp() };
  }
  if (!find(command)) return unknown(command, rest.includes('--json'));
  if (wantsHelp(command, rest)) return { stream: 'stdout', code: 0, text: commandHelp(command) };
  return null;
}

function unknown(name, json) {
  const hint = suggest(name);
  if (json) return { stream: 'stderr', code: 1, text: JSON.stringify({ error: `unknown command "${name}"${hint ? `; did you mean "${hint}"?` : ''}`, kind: 'local' }) };
  return { stream: 'stderr', code: 1, text: `dalan: unknown command "${name}"${hint ? `. Did you mean "${hint}"?` : ''}\nRun 'dalan --help' for usage.` };
}
