// What the owner is told to click in a hosted client, and which OAuth callback that client uses. This is data and copy only:
// the bridge's OAuth rules live in src/as.mjs. The callbacks below are the vendors' published ones and are also in the bridge's
// default callback list (src/as-files.mjs), so a hosted trial adds no new trust.
import { terminalSafe } from './terminal-safe.mjs';

export const CONNECTOR_NAME = 'Dalan Trial';

export const CLIENTS = {
  chatgpt: {
    label: 'ChatGPT',
    // https://developers.openai.com/apps-sdk/build/auth: the stable redirect, and the connection-specific one that ChatGPT
    // uses when it does not accept the issuer's identification. Both are vendor-published; anything else is refused here.
    callbacks: ['https://chatgpt.com/connector_platform_oauth_redirect', /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]+$/],
    steps: [
      'Open ChatGPT, then Settings → Apps (older accounts: Settings → Connectors → Advanced → Developer mode), and choose Create or Add a custom MCP server.',
      `Name it "${CONNECTOR_NAME}", paste the URL above, choose OAuth (automatic registration if asked), accept the notice and create it.`,
      `Open a new chat, enable "${CONNECTOR_NAME}" from the + menu, and send the prompt below. Sign in when ChatGPT asks.`,
    ],
  },
  claude: {
    label: 'claude.ai',
    // Observed live (a Funnel on 8443 gave "Couldn't reach this address"; a Quick Tunnel on 443 connected): claude.ai reaches
    // only port 443. Anthropic does not document this, so it is treated as a rule of the trial, not as a vendor guarantee.
    port: 443,
    callbacks: ['https://claude.ai/api/mcp/auth_callback'],
    steps: [
      'Open claude.ai, then Customize → Connectors → + → Add custom connector. (If your organization manages connectors, an owner adds it under Organization settings → Connectors first.)',
      `Name it "${CONNECTOR_NAME}", paste the URL above, leave the OAuth client fields empty (automatic registration), then Add and sign in.`,
      `Open a chat, enable "${CONNECTOR_NAME}" from the + → Connectors menu, and send the prompt below.`,
    ],
  },
};

export const CLIENT_NAMES = Object.keys(CLIENTS);

export const callbackAllowed = (client, redirect) => CLIENTS[client].callbacks.some(c => typeof c === 'string' ? c === redirect : c.test(redirect));

export const hostedPrompt = (requestId, requestPhrase) =>
  `Use ${CONNECTOR_NAME} to list pending jobs, claim only ${requestId}, read its brief, and finish it with the requested report (${requestPhrase}). Stop if the job is missing or cancelled. Do not read files, run commands, or call other services.`;

// The connector handoff: every value is filled in. `url` is a credential, so the caller writes this text to the owner's terminal
// only, never to a log.
export function handoffText({ client, url, requestId, requestPhrase }) {
  const spec = CLIENTS[client];
  return [
    `Connector name: ${CONNECTOR_NAME}`, 'Paste this URL into your connector (it is a secret; it stays on this terminal and in the private resource-url file):', url, '',
    spec.label, ...spec.steps.map((step, i) => `${i + 1}. ${step}`), '', 'Paste this into the chat:', hostedPrompt(requestId, requestPhrase),
  ].map(line => terminalSafe(line)).join('\n');
}
