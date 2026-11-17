import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { writeAtomic } from './as-files.mjs';
import { describeFacts, OWNER } from './gozar-routes.mjs';
import { terminalSafe } from './terminal-safe.mjs';

const cleanupPurposes = new Set(['reconcile', 'stop-connector', 'remove-resource', 'revoke-credential', 'disconnect']);
const setupComplete = view => view.state === 'complete' &&
  !view.resources.some(resource => !resource.presence.known && resource.ownership !== 'foreign');
const yes = answer => /^y(es)?$/i.test(String(answer ?? '').trim());

function refDirectory(env) {
  return path.join(env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config'), 'dalan', 'route-setup');
}

function referencePath(env, home, providerId) {
  const key = createHash('sha256').update(JSON.stringify([home, providerId])).digest('hex');
  return path.join(refDirectory(env), key + '.json');
}

function reserveReference(file, home, providerId) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  if (!fs.existsSync(file)) {
    const staged = path.join(dir, randomUUID());
    try {
      writeAtomic(staged, JSON.stringify({ home, owner: OWNER, providerId, operationId: randomUUID() }));
      try { fs.linkSync(staged, file); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const fd = fs.openSync(dir, 'r');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } finally { fs.rmSync(staged, { force: true }); }
  }
  const ref = readReference(file);
  if (ref.home !== home || ref.providerId !== providerId) throw new Error('The saved Gozar setup reference has a different scope.');
  return ref;
}

function readReference(file) {
  const ref = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (ref.owner !== OWNER || typeof ref.home !== 'string' || !path.isAbsolute(ref.home) ||
      typeof ref.providerId !== 'string' || typeof ref.operationId !== 'string') throw new Error('Invalid Gozar setup reference.');
  return ref;
}

export function muteableTerminal(input, output) {
  const terminal = Boolean(input.isTTY && output.isTTY);
  let muted = false;
  return {
    terminal,
    output: terminal ? Object.assign(new Writable({
      write(chunk, _encoding, done) { if (!muted) output.write(chunk); done(); },
    }), { columns: output.columns, isTTY: true }) : undefined,
    mute(value) { muted = value; },
  };
}

function showAction(view, say) {
  const action = view.nextAction;
  if (!action) return;
  for (const line of [action.label, action.disclosure.text, action.instructions, action.help, action.obtainUrl,
    !action.step.browser && action.href, action.step.permission.label,
    ...action.disclosure.links.map(link => link.href),
    ...describeFacts(action.consent.facts),
    ...(action.effects?.writes ?? []), ...(action.effects?.networkOrigins ?? []),
  ]) if (line) say(line);
  if (action.artifact) say(`Software artifact SHA-256 ${action.artifact.sha256}`);
  if (action.effects?.requiresPrivilege) say('This effect requires elevated privileges.');
  if (action.effects?.restartRequired) say('This effect requires a restart.');
  if (action.step.resourceHandle) say(`Resource reference ${action.step.resourceHandle}`);
}

async function drive({ gozar, ref, view, say, ask, askSecret, handoff, cancelling }) {
  // Cancellation offers are separate decisions, including disconnect versus remote revocation.
  for (;;) {
    say(`Gozar setup is ${view.state}.`);
    say(view.evidence.known ? view.evidence.value.summary : `Evidence unknown (${view.evidence.reason}).`);
    for (const resource of view.resources) {
      say(`${resource.label} (${resource.ownership}): ${resource.presence.known ? resource.presence.value ? 'present' : 'absent' : 'presence unknown'}, removal ${resource.removal}.`);
    }
    const action = view.nextAction;
    if (view.operationId !== ref.operationId || view.scope.providerId !== ref.providerId) throw new Error('The Gozar setup offer does not match the retained operation.');
    if (!cancelling && setupComplete(view)) return view;
    if (!action || (cancelling && !cleanupPurposes.has(action.step.purpose)) ||
        (!cancelling && ['cancelled', 'expired', 'denied'].includes(view.state))) return view;
    const scopeReview = action.consent.scope;
    if (scopeReview.operation?.id !== ref.operationId || scopeReview.operation.revision !== view.revision ||
        scopeReview.configurationRevision !== view.scope.configurationRevision || scopeReview.scopeId !== view.scope.scopeId ||
        scopeReview.providerId !== view.scope.providerId || scopeReview.registryId !== view.scope.registryId || scopeReview.draftId !== view.scope.draftId) {
      throw new Error('The Gozar approval does not match the current setup offer.');
    }
    showAction(view, say);
    if (!ask || !yes(await ask(`Approve ${action.kind === 'open-url' && action.step.browser ? 'the browser handoff' : action.step.permission.label} for this setup step? [y/N] `))) return view;
    const approval = { kind: 'setup', digest: action.digest, disclosureRevision: action.disclosure.revision, consentFactsDigest: action.consent.consentFactsDigest };
    const scope = { ...ref, ...(view.scope.draftId && { draftId: view.scope.draftId }), expectedConfigurationRevision: view.scope.configurationRevision };
    const command = { ...scope, expectedSetupRevision: view.revision, actionId: action.id, approval };
    let next;
    if (action.kind === 'open-url' && action.step.browser) {
      if (!handoff) return view;
      const interactive = await gozar.readSetupOperation({ ...ref, includeBrowserHandoff: true });
      if (interactive.revision !== view.revision || interactive.nextAction?.consent.consentFactsDigest !== approval.consentFactsDigest) {
        view = await gozar.readSetupOperation(ref);
        continue;
      }
      if (interactive.nextAction.href) await handoff(interactive.nextAction.href);
      if (!yes(await ask('Check Gozar for current authorization evidence? [y/N] '))) return view;
      next = await gozar.readSetupOperation(ref);
    } else if (action.kind === 'provide-secret') {
      if (!askSecret) { say('Open Dalan in a private interactive terminal to enter the credential.'); return view; }
      const bytes = await askSecret(action.secretLabel ?? action.label);
      if (!bytes?.length) return view;
      let stored;
      try {
        stored = await gozar.storeSecret({ ...scope, inputId: action.inputId, scopeId: view.scope.scopeId, bytes });
      } finally { bytes.fill(0); }
      try { next = await gozar.runSetupAction({ ...command, secretHandle: stored.handle }); }
      finally {
        // Delete unused intake, including refusals. Gozar protects the handles already referenced by the operation or configuration.
        try { await gozar.discardSecret({ home: ref.home, handle: stored.handle }); }
        catch (error) { if (error.code !== 'secret_in_use') throw error; }
      }
    } else if (action.kind === 'provide-value') {
      const options = action.step.options;
      for (const [index, option] of (options ?? []).entries()) say(`${index + 1}. ${option.label}`);
      const answer = await ask(`${action.valueLabel ?? action.label}: `);
      if (!answer) return view;
      const value = options ? options[Number(answer) - 1]?.value : answer;
      if (!value) return view;
      next = await gozar.runSetupAction({ ...command, value });
    } else {
      // For instructions and documentation links the SDK observes; the owner's acknowledgement cannot complete setup.
      next = await gozar.runSetupAction(command);
    }
    // An attempted effect can advance the revision even when it fails. Offer it again only on a new owner invocation.
    if (next.nextAction?.id === action.id && next.nextAction.digest === action.digest && next.state === view.state) return next;
    view = next;
  }
}

export async function runRouteSetup({ gozar, candidate, home, env, ...interaction }) {
  const file = referencePath(env, home, candidate.providerId);
  if (candidate.setup.state === 'ready' && !fs.existsSync(file)) return true;
  const ref = reserveReference(file, home, candidate.providerId);
  let view;
  try { view = await gozar.readSetupOperation(ref); }
  catch (error) {
    if (error.code !== 'route_not_found') throw error;
    const initial = candidate.setup.actions[0];
    if (!initial) return false;
    view = await gozar.runSetupAction({ ...ref, expectedSetupRevision: 0,
      expectedConfigurationRevision: candidate.configuration.revision, actionId: initial.id });
  }
  interaction.say(`Setup operation ${ref.operationId}`);
  view = await drive({ gozar, ref, view, ...interaction });
  return setupComplete(view);
}

export async function cancelRouteSetup({ gozar, home, operationId, env, say, ask }) {
  const dir = refDirectory(env);
  const files = fs.readdirSync(dir, { throwIfNoEntry: false }) ?? [];
  const found = files.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => {
    const file = path.join(dir, name);
    return { file, ref: readReference(file) };
  }).filter(({ ref }) => ref.home === home && ref.operationId === operationId);
  if (found.length !== 1) throw new Error('No exact Dalan setup reference matches that operation.');
  const { ref, file } = found[0];
  if (!ask || !yes(await ask('Cancel this Gozar setup operation? [y/N] '))) return false;
  const view = await drive({ gozar, ref, view: await gozar.cancelSetupOperation(ref), say, ask, cancelling: true });
  const settled = view.evidence.known && !view.nextAction && view.resources.every(resource => resource.removal === 'retained' ||
    (resource.ownership === 'owned' && resource.removal === 'confirmed' && resource.presence.known && !resource.presence.value));
  if (settled) fs.unlinkSync(file);
  else say(`Cleanup is unconfirmed. Resume operation ${ref.operationId} after following the current Gozar instructions.`);
  return settled;
}

export const safeRouteOutput = output => line => output.write(`${terminalSafe(line)}\n`);
